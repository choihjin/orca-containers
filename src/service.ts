import type { ContainerAction, FocusContext, HostId, Opened, Problem, Result, RunOptions, Snapshot, TerminalKind } from './protocol'
import type { Anchor, Hosts, NoAnchor } from './hosts'
import type { LocalRunner } from './local/runner'
import { CliError, type OrcaCli } from './remote/orca-cli'
import { kernelKey, type KeyValueStore, type SshRunner } from './remote/ssh'
import { actionCommand, InvalidInputError, logsCommand, SNAPSHOT_COMMANDS, terminalArgv, type DockerCommand } from './docker/commands'
import { buildSnapshot, classifyFailure, cleanLabel, type CommandResult } from './docker/parse'
import { isSupportedRemoteKernel, shellCommand } from './platform'

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
}

export function terminalTitle(kind: TerminalKind, name: string): string {
  return `${kind}: ${cleanLabel(name, 40)}`
}

// The host problems the service answers itself: an unsupported host, and a terminal with no anchor.
const MESSAGE: Record<'unsupported' | NoAnchor['missing'], string> = {
  unsupported: 'This host is not supported.',
  unreachable: 'Orca could not reach this host.',
  'no-workspace': 'This host has no workspace.',
}

const fail = (kind: Problem['kind'], message: string): { ok: false; problem: Problem } => ({ ok: false, problem: { kind, message } })
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
  // a terminal; only Logs/Shell terminals look up an anchor.
  async function runCommands(hostId: HostId, commands: readonly DockerCommand[], options: RunOptions): Promise<Result<CommandResult[]>> {
    const env = envOf(hostId)
    return env === null ? { ok: true, value: await local.run(commands, options) } : ssh.run(env, commands, options)
  }

  // A terminal opens only on a host known to run Linux. A stored kernel decides at once: Linux goes on, any other is
  // unsupported. With none stored, or a store that cannot be read, one ssh run with no docker command reads the
  // kernel (the runner stores it, and answers unsupported off Linux).
  async function linuxKnown(env: string, options: RunOptions): Promise<Result<null>> {
    let kernel: unknown
    try {
      kernel = await deps.storage.get(kernelKey(env))
    } catch {
      kernel = undefined
    }
    if (typeof kernel === 'string') {
      return isSupportedRemoteKernel(kernel) ? { ok: true, value: null } : fail('unsupported', MESSAGE.unsupported)
    }
    const checked = await ssh.run(env, [], options)
    return checked.ok ? { ok: true, value: null } : checked
  }

  // Bringing the new terminal to the front is best effort: the terminal is open either way.
  async function bringToFront(o: { environment?: string; handle: string }): Promise<void> {
    try {
      await cli.switchTo(o)
    } catch (error) {
      deps.log?.(`terminal switch failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  return {
    async snapshot(hostId, options) {
      const host = await readyHost(hostId)
      if (!host.ok) return host
      const ran = await runCommands(hostId, SNAPSHOT_COMMANDS, options)
      return ran.ok ? buildSnapshot(hostId, deps.now(), ran.value) : ran
    },

    async action(hostId, action, containerId, options) {
      const host = await readyHost(hostId)
      if (!host.ok) return host
      let command: DockerCommand
      try {
        command = actionCommand(action, containerId)
      } catch (error) {
        if (error instanceof InvalidInputError) return fail('invalid', error.message)
        throw error
      }
      const ran = await runCommands(hostId, [command], options)
      if (!ran.ok) return ran
      const result = ran.value.find((r) => r.name === 'action') ?? { name: 'action', code: 1, lines: ['action produced no result'] }
      return result.code === 0 ? { ok: true, value: { done: true } } : { ok: false, problem: classifyFailure(result) }
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
      const host = await readyHost(hostId)
      if (!host.ok) return host
      const resolved = await anchorOf(hostId, focus)
      if (!resolved.ok) return resolved
      const anchor = resolved.value
      let command: string
      try {
        command = shellCommand(terminalArgv(kind, containerId))
      } catch (error) {
        if (error instanceof InvalidInputError) return fail('invalid', error.message)
        throw error
      }
      const title = terminalTitle(kind, containerName)
      const env = envOf(hostId)
      if (env === null) {
        if (anchor.workspaceId === undefined) return fail('no-workspace', MESSAGE['no-workspace'])
        const terminalId = await deps.openLocalTerminal({ workspaceId: anchor.workspaceId, title, command })
        await bringToFront({ handle: terminalId })
        return { ok: true, value: { opened: true, workspace: anchor.name ?? baseName(anchor.path) } }
      }
      const linux = await linuxKnown(env, options)
      if (!linux.ok) return linux
      let handle: string
      try {
        handle = await cli.createTerminal({ environment: env, worktreePath: anchor.path, title, command, focus: true })
      } catch (error) {
        if (error instanceof CliError) return fail('unreachable', error.message)
        throw error
      }
      await hosts.remember(hostId, anchor.path)
      await bringToFront({ environment: env, handle })
      return { ok: true, value: { opened: true, workspace: baseName(anchor.path) } }
    },
  }
}
