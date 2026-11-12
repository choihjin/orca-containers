import { existsSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import type { PluginRequests } from 'orca'
import type { OrcaWorkerApi } from 'orca/worker'
import { isComposeAction } from './docker/commands'
import { createHosts, type LocalWorkspace } from './hosts'
import { createLocalRunner, nodeLocalDeps, type LocalRunner } from './local/runner'
import { localNameInText, resolveOrcaCliPath } from './platform'
import {
  WORK_BUDGET_MS, type ContainerAction, type FocusContext, type HostId, type Problem, type ResourceKind, type RunOptions,
  type TerminalKind,
} from './protocol'
import { createOrcaCli, nodeExec, type OrcaCli } from './remote/orca-cli'
import { createSshRunner, nodeSshExec, type KeyValueStore, type SshExec } from './remote/ssh'
import { createService, type Service } from './service'
import type { Hosts } from './hosts'

export type WorkerDeps = {
  makeCli: () => OrcaCli; makeLocal: () => LocalRunner; makeSshExec: () => SshExec; platform: string; now: () => number
  randomHex: () => string
}

type Failure = { ok: false; problem: Problem }
const failure = (kind: Problem['kind'], message: string): Failure => ({ ok: false, problem: { kind, message } })
const invalid = (message: string) => failure('invalid', message)

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isHostId = (v: unknown): v is HostId => typeof v === 'string' && (v === 'local' || (v.startsWith('ssh:') && v.length > 4))
const isString = (v: unknown): v is string => typeof v === 'string'
const isAction = (v: unknown): v is ContainerAction => v === 'start' || v === 'stop' || v === 'restart' || v === 'remove'
const isKind = (v: unknown): v is TerminalKind => v === 'logs' || v === 'shell'
const isResourceKind = (v: unknown): v is ResourceKind => v === 'image' || v === 'volume' || v === 'network'

// Answers must be plain JSON: an undefined field would make the host refuse the answer.
const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

export function createWorkerModule(deps: WorkerDeps): { default: (orca: OrcaWorkerApi) => void; deactivate: () => Promise<void> } {
  // Each running request has its own controller here, aborted by the request's own signal or by deactivate, which
  // aborts them all (an ssh run is killed). A request that finished leaves nothing behind.
  const running = new Set<AbortController>()
  let stopped = false

  // The request's own signal is followed through a listener that the request removes when it ends.
  function requestScope(outer: AbortSignal): { signal: AbortSignal; end: () => void } {
    const controller = new AbortController()
    const onAbort = () => controller.abort()
    if (outer.aborted) controller.abort()
    else outer.addEventListener('abort', onAbort, { once: true })
    running.add(controller)
    return {
      signal: controller.signal,
      end: () => {
        running.delete(controller)
        outer.removeEventListener('abort', onAbort)
      },
    }
  }

  function activate(orca: OrcaWorkerApi): void {
    type Wired = { hosts: Hosts; service: Service }
    let wired: Wired | null = null
    stopped = false

    const readFocus = async (): Promise<FocusContext | null> => {
      const context = await orca.host.call('workspace.readContext', {})
      return context ? { displayName: context.displayName, branch: context.branch, terminalIds: context.terminals.map((t) => t.id) } : null
    }
    // Only this Mac's workspaces: a row of another host is not where a local terminal can open.
    const listLocalWorkspaces = async (): Promise<LocalWorkspace[]> => {
      const { workspaces } = await orca.host.call('workspace.list', {})
      return workspaces
        .filter((w) => w.hostId === 'local' || w.hostId === null)
        .map((w) => ({ id: w.id, name: w.name, path: w.path, branch: w.branch }))
    }
    const get = (): Wired => {
      if (wired) return wired
      const cli = deps.makeCli()
      const local = deps.makeLocal()
      const storage = orca.storage as unknown as KeyValueStore
      const hosts = createHosts({ cli, listLocalWorkspaces, platform: deps.platform, storage, now: deps.now, log: (m) => orca.log(m) })
      const ssh = createSshRunner({ exec: deps.makeSshExec(), storage, now: deps.now, randomHex: deps.randomHex, localName: localNameInText(deps.platform) })
      const service = createService({
        hosts, local, ssh, cli, storage, now: deps.now, log: (m) => orca.log(m),
        openLocalTerminal: async (o) => (await orca.host.call('terminal.create', { workspaceId: o.workspaceId, title: o.title, command: o.command })).terminalId,
      })
      wired = { hosts, service }
      return wired
    }

    type Req = PluginRequests
    type Checked<K extends keyof Req> = { input: Req[K]['input'] } | { error: string }
    // Validates the raw input (bad -> invalid), runs, and turns a throw into a failed Result with a log line.
    const register = <K extends keyof Req>(
      name: K,
      check: (raw: unknown) => Checked<K>,
      run: (input: Req[K]['input'], wired: Wired, options: RunOptions) => Promise<Req[K]['output']>,
    ) => {
      // The generated handle overload is keyed by a concrete name; the generic K needs this one cast.
      const handle = orca.panels.handle as unknown as (
        n: K, h: (raw: unknown, ctx: { signal: AbortSignal }) => Promise<Req[K]['output'] | Failure>) => void
      handle.call(orca.panels, name, async (raw, ctx) => {
        if (stopped) return failure('timeout', 'The plugin is stopping.')
        const checked = check(raw)
        if ('error' in checked) return invalid(checked.error)
        const scope = requestScope(ctx.signal)
        try {
          return plain(await run(checked.input, get(), { deadline: deps.now() + WORK_BUDGET_MS, signal: scope.signal }))
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          orca.log(`${name} failed: ${message}`)
          return failure('failed', message)
        } finally {
          scope.end()
        }
      })
    }

    const obj = (raw: unknown): Record<string, unknown> | null => (isObject(raw) ? raw : null)
    const NOT_OBJECT = 'The request must be an object.'
    const BAD_HOST = 'hostId must be "local" or "ssh:<name>".'

    register('hosts.list', (raw) => {
      const o = obj(raw)
      if (!o) return { error: NOT_OBJECT }
      if (o.refresh === undefined) return { input: {} }
      return typeof o.refresh === 'boolean' ? { input: { refresh: o.refresh } } : { error: 'refresh must be a boolean.' }
    }, async (input, { hosts }) => ({ ok: true, value: { hosts: await hosts.list(input.refresh === true) } }))

    register('hosts.matchFocus', (raw) => {
      const o = obj(raw)
      if (!o) return { error: NOT_OBJECT }
      const { displayName, branch, terminalIds } = o
      if (isString(displayName) && isString(branch) && Array.isArray(terminalIds) && terminalIds.every(isString)) {
        return { input: { displayName, branch, terminalIds } }
      }
      return { error: 'The focus must have displayName, branch and terminalIds.' }
    }, async (input, { hosts }) => ({ ok: true, value: { hostId: await hosts.matchFocus(input) } }))

    register('docker.snapshot', (raw) => {
      const o = obj(raw)
      if (!o) return { error: NOT_OBJECT }
      return isHostId(o.hostId) ? { input: { hostId: o.hostId } } : { error: BAD_HOST }
    }, async (input, { service }, options) => service.snapshot(input.hostId, options))

    register('docker.action', (raw) => {
      const o = obj(raw)
      if (!o) return { error: NOT_OBJECT }
      if (!isHostId(o.hostId)) return { error: BAD_HOST }
      if (!isAction(o.action)) return { error: 'action must be start, stop, restart or remove.' }
      return isString(o.containerId) ? { input: { hostId: o.hostId, action: o.action, containerId: o.containerId } } : { error: 'containerId must be a string.' }
    }, async (input, { service }, options) =>
      service.action(input.hostId, input.action, input.containerId, options))

    register('docker.logs', (raw) => {
      const o = obj(raw)
      if (!o) return { error: NOT_OBJECT }
      if (!isHostId(o.hostId)) return { error: BAD_HOST }
      return isString(o.containerId) ? { input: { hostId: o.hostId, containerId: o.containerId } } : { error: 'containerId must be a string.' }
    }, async (input, { service }, options) =>
      service.logs(input.hostId, input.containerId, options))

    register('docker.openTerminal', (raw) => {
      const o = obj(raw)
      if (!o) return { error: NOT_OBJECT }
      if (!isHostId(o.hostId)) return { error: BAD_HOST }
      if (!isKind(o.kind)) return { error: 'kind must be logs or shell.' }
      if (!isString(o.containerId)) return { error: 'containerId must be a string.' }
      if (!isString(o.containerName)) return { error: 'containerName must be a string.' }
      return { input: { hostId: o.hostId, kind: o.kind, containerId: o.containerId, containerName: o.containerName } }
    }, async (input, { service }, options) =>
      service.openTerminal(input.hostId, input.kind, input.containerId, input.containerName, await readFocus(), options))

    // Only the shape here; the service checks `ref` against the kind's own rule.
    register('docker.removeResource', (raw) => {
      const o = obj(raw)
      if (!o) return { error: NOT_OBJECT }
      if (!isHostId(o.hostId)) return { error: BAD_HOST }
      if (!isResourceKind(o.kind)) return { error: 'kind must be image, volume or network.' }
      return isString(o.ref) ? { input: { hostId: o.hostId, kind: o.kind, ref: o.ref } } : { error: 'ref must be a string.' }
    }, async (input, { service }, options) =>
      service.removeResource(input.hostId, input.kind, input.ref, options))

    register('docker.pullTerminal', (raw) => {
      const o = obj(raw)
      if (!o) return { error: NOT_OBJECT }
      if (!isHostId(o.hostId)) return { error: BAD_HOST }
      return isString(o.ref) ? { input: { hostId: o.hostId, ref: o.ref } } : { error: 'ref must be a string.' }
    }, async (input, { service }, options) =>
      service.pullTerminal(input.hostId, input.ref, await readFocus(), options))

    // Only the shape here; the service checks the project name and the member id.
    register('docker.composeAction', (raw) => {
      const o = obj(raw)
      if (!o) return { error: NOT_OBJECT }
      if (!isHostId(o.hostId)) return { error: BAD_HOST }
      if (!isString(o.project)) return { error: 'project must be a string.' }
      if (!isString(o.memberId)) return { error: 'memberId must be a string.' }
      if (!isComposeAction(o.action)) return { error: 'action must be start, stop, restart or down.' }
      return { input: { hostId: o.hostId, project: o.project, memberId: o.memberId, action: o.action } }
    }, async (input, { service }, options) =>
      service.composeAction(input.hostId, input.project, input.memberId, input.action, options))

    register('docker.composeUp', (raw) => {
      const o = obj(raw)
      if (!o) return { error: NOT_OBJECT }
      if (!isHostId(o.hostId)) return { error: BAD_HOST }
      if (!isString(o.project)) return { error: 'project must be a string.' }
      return isString(o.memberId) ? { input: { hostId: o.hostId, project: o.project, memberId: o.memberId } } : { error: 'memberId must be a string.' }
    }, async (input, { service }, options) =>
      service.composeUp(input.hostId, input.project, input.memberId, await readFocus(), options))
  }

  // Nothing to close (no terminal is kept open): the requests still running are stopped, and new ones answer timeout.
  async function deactivate(): Promise<void> {
    stopped = true
    for (const controller of running) controller.abort()
  }

  return { default: activate, deactivate }
}

const real = createWorkerModule({
  makeCli: () => createOrcaCli(resolveOrcaCliPath(process.env, existsSync, process.platform), nodeExec()),
  makeLocal: () => createLocalRunner(nodeLocalDeps()),
  makeSshExec: () => nodeSshExec(),
  platform: process.platform,
  now: Date.now,
  randomHex: () => randomBytes(4).toString('hex'),
})
export default real.default
export const deactivate = real.deactivate
