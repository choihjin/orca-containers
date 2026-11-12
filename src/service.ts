import type {
  ComposeAction, ContainerAction, FocusContext, HostId, Opened, Problem, ResourceKind, Result, RunOptions, Snapshot, TerminalKind,
} from './protocol'
import type { Anchor, Hosts, NoAnchor } from './hosts'
import type { LocalRunner } from './local/runner'
import { CliError, type OrcaCli } from './remote/orca-cli'
import { kernelKey, type KeyValueStore, type SshRunner } from './remote/ssh'
import {
  actionCommand, composeCommand, composeLabelsCommand, composeUpArgv, InvalidInputError, isComposeAction, isComposeProject, logsCommand, pullArgv,
  removeCommand, SNAPSHOT_COMMANDS, terminalArgv, type ComposeTarget, type DockerCommand,
} from './docker/commands'
import { buildSnapshot, classifyFailure, cleanLabel, parseComposeTarget, type CommandResult } from './docker/parse'
import { isSupportedRemoteKernel, shellCommand } from './platform'
import { macTerminalArgv } from './remote/script'

export type ServiceDeps = {
  hosts: Hosts; local: LocalRunner; ssh: SshRunner; cli: OrcaCli; now: () => number; log?: (message: string) => void
  /** Read only: the kernel each SSH host last reported (the ssh runner writes it). */
  storage: Pick<KeyValueStore, 'get'>
  /** Resolves with the id of the terminal it created. */
  openLocalTerminal: (o: { workspaceId: string; title: string; command: string }) => Promise<string>
}
export type Service = {
  snapshot(hostId: HostId, options: RunOptions): Promise<Result<Snapshot>>
  action(hostId: HostId, action: ContainerAction, containerId: string, options: RunOptions): Promise<Result<{ done: true }>>
  logs(hostId: HostId, containerId: string, options: RunOptions): Promise<Result<{ lines: string[]; takenAt: number }>>
  openTerminal(hostId: HostId, kind: TerminalKind, containerId: string, containerName: string, focus: FocusContext | null, options: RunOptions): Promise<Result<Opened>>
  removeResource(hostId: HostId, kind: ResourceKind, ref: string, options: RunOptions): Promise<Result<{ done: true }>>
  pullTerminal(hostId: HostId, ref: string, focus: FocusContext | null, options: RunOptions): Promise<Result<Opened>>
  composeAction(hostId: HostId, project: string, memberId: string, action: ComposeAction, options: RunOptions): Promise<Result<{ done: true }>>
  composeUp(hostId: HostId, project: string, memberId: string, focus: FocusContext | null, options: RunOptions): Promise<Result<Opened>>
}

export function terminalTitle(kind: TerminalKind | 'pull' | 'compose up', name: string): string {
  return `${kind}: ${cleanLabel(name, 40)}`
}

// The host problems the service answers itself: an unsupported host, and a terminal with no anchor.
const MESSAGE: Record<'unsupported' | NoAnchor['missing'], string> = {
  unsupported: 'This host is not supported.',
  unreachable: 'Orca could not reach this host.',
  'no-workspace': 'This host has no workspace.',
}

const fail = (kind: Problem['kind'], message: string): { ok: false; problem: Problem } => ({ ok: false, problem: { kind, message } })
// Builds a command or an argv: a bad value (InvalidInputError) is invalid and runs nothing; any other throw propagates.
function checked<T>(build: () => T): Result<T> {
  try {
    return { ok: true, value: build() }
  } catch (error) {
    if (error instanceof InvalidInputError) return fail('invalid', error.message)
    throw error
  }
}
// The labels lookup of a Compose project's member container, with both values checked.
function composeLookup(project: string, memberId: string): DockerCommand {
  if (!isComposeProject(project)) throw new InvalidInputError('Invalid Compose project name')
  return composeLabelsCommand(memberId)
}
// The docker CLI's answer when the compose plugin is missing, in older and newer wordings; it ends with
// "See 'docker --help'", which says nothing on its own.
const NO_COMPOSE_PLUGIN = /is not a docker command|unknown command "compose"|unknown command: docker compose\b/i

// A failed compose command. Code 124 from a command that started (its own 55 s limit ended it, on the host or here) may
// have changed some of the project's containers and not others, so its result is unknown; one the local runner never
// started stays a timeout. A missing compose plugin is named. Any other failure shows compose's last meaningful line:
// it prints its progress first and its error last.
function composeFailure(result: CommandResult): Problem {
  if (result.code === 124 && result.skipped !== true) return { kind: 'unknown-result', message: 'sent; result unknown' }
  if (result.lines.some((line) => NO_COMPOSE_PLUGIN.test(line))) {
    return { kind: 'failed', message: 'Docker Compose is not installed on this host (the docker compose plugin is missing).' }
  }
  return classifyFailure(result, 'last')
}
// What a terminal types: the argv, or (for Up) a lookup that finds it once the host and its kernel are known.
type TerminalCommand = string[] | (() => Promise<Result<string[]>>)
const argvOf = async (command: TerminalCommand): Promise<Result<string[]>> => (Array.isArray(command) ? { ok: true, value: command } : command())
const envOf = (hostId: HostId): string | null => (hostId.startsWith('ssh:') ? hostId.slice(4) : null)
const baseName = (path: string): string => path.split('/').filter((part) => part !== '').pop() ?? path
// 200 log lines of a chatty container must stay far under the 1 MiB a panel request may answer, even at several
// bytes a character: each line is cut, then only the newest lines that fit the total are kept. The panel cuts shorter still.
const LOG_ANSWER_LINE_MAX = 2_000
const LOG_ANSWER_TOTAL_MAX = 100_000
const answerLine = (line: string): string => (line.length > LOG_ANSWER_LINE_MAX ? `${line.slice(0, LOG_ANSWER_LINE_MAX)}…` : line)
function answerLines(lines: readonly string[]): string[] {
  const kept: string[] = []
  let total = 0
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = answerLine(lines[i]!)
    total += line.length
    if (total > LOG_ANSWER_TOTAL_MAX) break
    kept.push(line)
  }
  return kept.reverse()
}

export function createService(deps: ServiceDeps): Service {
  const { hosts, local, ssh, cli } = deps

  // Unknown host -> invalid; unsupported -> unsupported. Nothing else: Orca's workspace listing of an SSH host does
  // not stop a request, ssh answers for itself. This Mac is known from the platform alone; an SSH id needs the host
  // list (one lookup: a failing CLI listing is not cached, so each one asks again).
  async function readyHost(hostId: HostId): Promise<Result<null>> {
    const info = envOf(hostId) === null ? hosts.localHost() : (await hosts.list()).find((h) => h.id === hostId)
    if (!info) return fail('invalid', 'Unknown host.')
    return info.status === 'ready' ? { ok: true, value: null } : fail('unsupported', MESSAGE.unsupported)
  }

  // No anchor on an SSH host -> why (unreachable: Orca's listing of it failed; no-workspace: it has none). No anchor
  // on this Mac -> no-workspace.
  async function anchorOf(hostId: HostId, focus: FocusContext | null): Promise<Result<Anchor>> {
    const anchor = await hosts.anchor(hostId, focus)
    if (!('missing' in anchor)) return { ok: true, value: anchor }
    const kind = envOf(hostId) === null ? 'no-workspace' : anchor.missing
    return fail(kind, MESSAGE[kind])
  }

  // Runs on the host's own runner: docker on this Mac, or `ssh <host name>` from this Mac. Neither needs a workspace or
  // a terminal; only Logs/Shell/Pull terminals look up an anchor.
  async function runCommands(hostId: HostId, commands: readonly DockerCommand[], options: RunOptions): Promise<Result<CommandResult[]>> {
    const env = envOf(hostId)
    return env === null ? { ok: true, value: await local.run(commands, options) } : ssh.run(env, commands, options)
  }

  // A terminal opens only on a host known to run a supported kernel (Linux or macOS). A stored kernel decides at once.
  // With none stored, or a store that cannot be read, one ssh run with no docker command reads the kernel (the runner
  // stores it, and answers unsupported for any other kernel).
  // The answer carries the kernel when it can be read (after a check, from what the runner stored), else null.
  async function kernelKnown(env: string, options: RunOptions): Promise<Result<{ kernel: string | null }>> {
    const storedKernel = async (): Promise<string | null> => {
      try {
        const kernel = await deps.storage.get(kernelKey(env))
        return typeof kernel === 'string' ? kernel : null
      } catch {
        return null
      }
    }
    const kernel = await storedKernel()
    if (kernel !== null) {
      return isSupportedRemoteKernel(kernel) ? { ok: true, value: { kernel } } : fail('unsupported', MESSAGE.unsupported)
    }
    const checked = await ssh.run(env, [], options)
    return checked.ok ? { ok: true, value: { kernel: await storedKernel() } } : checked
  }

  // Bringing the new terminal to the front is best effort: the terminal is open either way.
  async function bringToFront(o: { environment?: string; handle: string }): Promise<void> {
    try {
      await cli.switchTo(o)
    } catch (error) {
      deps.log?.(`terminal switch failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  // One command on the host's runner: its output lines on code 0; anything else, or no result, is classified.
  async function runOne(
    hostId: HostId, command: DockerCommand, options: RunOptions, classify: (result: CommandResult) => Problem = classifyFailure,
  ): Promise<Result<string[]>> {
    const ran = await runCommands(hostId, [command], options)
    if (!ran.ok) return ran
    const { name } = command
    const result = ran.value.find((r) => r.name === name) ?? { name, code: 1, lines: [`${name} produced no result`] }
    return result.code === 0 ? { ok: true, value: result.lines } : { ok: false, problem: classify(result) }
  }

  // An action or a remove: the host must be ready, the command is built (and checked: a bad value runs nothing), then
  // one run. Code 0 is done; anything else, or no result, is classified.
  async function runDone(hostId: HostId, build: () => DockerCommand, options: RunOptions): Promise<Result<{ done: true }>> {
    const host = await readyHost(hostId)
    if (!host.ok) return host
    const command = checked(build)
    if (!command.ok) return command
    const ran = await runOne(hostId, command.value, options)
    return ran.ok ? { ok: true, value: { done: true } } : ran
  }

  // Where a Compose project's files are: one run of the member's labels lookup, then the labels must name the project
  // and record absolute paths (parseComposeTarget). Read-only: it changes nothing on the host.
  async function composeTargetOf(hostId: HostId, project: string, lookup: DockerCommand, options: RunOptions): Promise<Result<ComposeTarget>> {
    const ran = await runOne(hostId, lookup, options)
    if (!ran.ok) return ran
    const target = parseComposeTarget(project, ran.value)
    return 'kind' in target ? { ok: false, problem: target } : { ok: true, value: target }
  }

  // Shell, Logs, Pull and Compose up: one docker command in a new terminal on the host's anchor workspace. The host must
  // be ready and have an anchor; `command` is built (and checked) next, so a bad value opens and runs nothing; an SSH host
  // must then be known to run Linux or macOS. Only then does Up look its argv up. The terminal comes to the front.
  async function openCommandTerminal(
    hostId: HostId, title: string, command: () => TerminalCommand, focus: FocusContext | null, options: RunOptions,
  ): Promise<Result<Opened>> {
    const host = await readyHost(hostId)
    if (!host.ok) return host
    const resolved = await anchorOf(hostId, focus)
    if (!resolved.ok) return resolved
    const anchor = resolved.value
    const prepared = checked(command)
    if (!prepared.ok) return prepared
    const env = envOf(hostId)
    if (env === null) {
      if (anchor.workspaceId === undefined) return fail('no-workspace', MESSAGE['no-workspace'])
      const args = await argvOf(prepared.value)
      if (!args.ok) return args
      const terminalId = await deps.openLocalTerminal({ workspaceId: anchor.workspaceId, title, command: shellCommand(args.value) })
      await bringToFront({ handle: terminalId })
      return { ok: true, value: { opened: true, workspace: anchor.name ?? baseName(anchor.path) } }
    }
    const known = await kernelKnown(env, options)
    if (!known.ok) return known
    const args = await argvOf(prepared.value)
    if (!args.ok) return args
    // A Linux host gets the plain command; a Mac host, or one whose kernel could not be read back, gets the lookup (plain
    // POSIX that still prefers docker on PATH).
    const typed = shellCommand(known.value.kernel === 'Linux' ? args.value : macTerminalArgv(args.value))
    let handle: string
    try {
      handle = await cli.createTerminal({ environment: env, worktreePath: anchor.path, title, command: typed, focus: true })
    } catch (error) {
      if (error instanceof CliError) return fail('unreachable', error.message)
      throw error
    }
    await hosts.remember(hostId, anchor.path)
    await bringToFront({ environment: env, handle })
    return { ok: true, value: { opened: true, workspace: baseName(anchor.path) } }
  }

  return {
    async snapshot(hostId, options) {
      const host = await readyHost(hostId)
      if (!host.ok) return host
      const ran = await runCommands(hostId, SNAPSHOT_COMMANDS, options)
      return ran.ok ? buildSnapshot(hostId, deps.now(), ran.value) : ran
    },

    async action(hostId, action, containerId, options) {
      return runDone(hostId, () => actionCommand(action, containerId), options)
    },

    async logs(hostId, containerId, options) {
      const host = await readyHost(hostId)
      if (!host.ok) return host
      let command: DockerCommand
      try {
        command = logsCommand(containerId)
      } catch (error) {
        if (error instanceof InvalidInputError) return fail('invalid', error.message)
        throw error
      }
      const ran = await runCommands(hostId, [command], options)
      if (!ran.ok) return ran
      const result = ran.value.find((r) => r.name === 'logs') ?? { name: 'logs', code: 1, lines: ['logs produced no result'] }
      if (result.code !== 0) return { ok: false, problem: classifyFailure(result) }
      return { ok: true, value: { lines: answerLines(result.lines), takenAt: deps.now() } }
    },

    async openTerminal(hostId, kind, containerId, containerName, focus, options) {
      return openCommandTerminal(hostId, terminalTitle(kind, containerName), () => terminalArgv(kind, containerId), focus, options)
    },

    async removeResource(hostId, kind, ref, options) {
      return runDone(hostId, () => removeCommand(kind, ref), options)
    },

    async pullTerminal(hostId, ref, focus, options) {
      return openCommandTerminal(hostId, terminalTitle('pull', ref), () => pullArgv(ref), focus, options)
    },

    // Start, stop, restart or down of the whole project: the labels lookup, then one compose command (55 s limit).
    async composeAction(hostId, project, memberId, action, options) {
      const host = await readyHost(hostId)
      if (!host.ok) return host
      const lookup = checked(() => {
        if (!isComposeAction(action)) throw new InvalidInputError('Invalid Compose action')
        return composeLookup(project, memberId)
      })
      if (!lookup.ok) return lookup
      const target = await composeTargetOf(hostId, project, lookup.value, options)
      if (!target.ok) return target
      const command = checked(() => composeCommand(target.value, action))
      if (!command.ok) return command
      const ran = await runOne(hostId, command.value, options, composeFailure)
      return ran.ok ? { ok: true, value: { done: true } } : ran
    },

    // `docker compose ... up -d` in a terminal, as Pull opens one; the labels lookup runs once the terminal can open.
    async composeUp(hostId, project, memberId, focus, options) {
      return openCommandTerminal(hostId, terminalTitle('compose up', project), () => {
        const lookup = composeLookup(project, memberId)
        return async () => {
          const target = await composeTargetOf(hostId, project, lookup, options)
          return target.ok ? checked(() => composeUpArgv(target.value)) : target
        }
      }, focus, options)
    },
  }
}
