import type { FocusContext, HostId, HostInfo, HostStatus } from './protocol'
import { isSupportedLocalPlatform, isSupportedRemoteKernel } from './platform'
import { CliError, type OrcaCli } from './remote/orca-cli'
import { kernelKey, type KeyValueStore } from './remote/ssh'

export type LocalWorkspace = { id: string; name: string; path: string; branch: string | null }
export type HostsDeps = {
  cli: OrcaCli; listLocalWorkspaces: () => Promise<LocalWorkspace[]>; platform: string; storage: KeyValueStore; now: () => number
  log: (message: string) => void
}
export const HOSTS_TTL_MS = 300_000
export const LISTING_TIMEOUT_MS = 10_000 // each Orca CLI host listing
export const TERMINAL_LOOKUP_TIMEOUT_MS = 5_000 // the Orca CLI list of this Mac's terminals
export const anchorKey = (env: string) => `anchor:${env}`

export function normalizeBranch(branch: string | null | undefined): string {
  return (branch ?? '').replace(/^refs\/heads\//, '')
}

export type Hosts = {
  list(refresh?: boolean): Promise<HostInfo[]>
  // This Mac's entry, from the platform alone: no Orca CLI call, so a failing SSH listing never delays local Docker.
  localHost(): HostInfo
  matchFocus(focus: FocusContext): Promise<HostId | null>
  // `name` is the local workspace's name; SSH anchors have only the path.
  anchor(hostId: HostId, focus: FocusContext | null): Promise<{ path: string; workspaceId?: string; name?: string } | null>
  remember(hostId: HostId, path: string): Promise<void>
}

type Worktree = { path: string; displayName: string; branch: string }
// What the last read of one SSH host gave: its rows, or null when the read failed.
type Read = Worktree[] | null
// listed: the SSH host list came from the CLI (false: listing failed and only this Mac is shown).
type Snapshot = { at: number; envs: string[]; reads: Map<string, Read>; listed: boolean }

const envOf = (hostId: HostId): string | null => (hostId.startsWith('ssh:') ? hostId.slice(4) : null)
const sameWorkspace = (focus: FocusContext, name: string, branch: string | null | undefined) =>
  name === focus.displayName && normalizeBranch(branch) === normalizeBranch(focus.branch)

export function createHosts(deps: HostsDeps): Hosts {
  const { cli, storage } = deps
  let cached: Snapshot | null = null
  // Last successful worktree read per SSH host, so a transient failure does not hide a host from focus matching.
  const lastKnown = new Map<string, Worktree[]>()
  // The SSH host listing is failing. A failed list is not cached, so each call asks again; the log gets one line per outage.
  let listingDown = false

  // A CLI failure listing the SSH hosts leaves this Mac alone: the list is local-only until the next read.
  async function compute(refresh: boolean): Promise<Snapshot> {
    let envs: string[]
    let listed = true
    try {
      envs = await cli.listSshEnvironments({ timeoutMs: LISTING_TIMEOUT_MS })
    } catch (error) {
      if (!(error instanceof CliError)) throw error
      if (!listingDown) deps.log(`Listing SSH hosts failed, showing this Mac only: ${error.code}: ${error.message}`)
      envs = []
      listed = false
    }
    listingDown = !listed
    if (refresh) await Promise.all(envs.map((env) => storage.delete(kernelKey(env))))
    const reads = new Map<string, Read>()
    await Promise.all(envs.map(async (env) => {
      try {
        const rows = await cli.listWorktrees(env, { timeoutMs: LISTING_TIMEOUT_MS })
        reads.set(env, rows)
        lastKnown.set(env, rows)
      } catch (error) {
        if (!(error instanceof CliError)) throw error
        reads.set(env, null)
      }
    }))
    return { at: deps.now(), envs, reads, listed }
  }

  async function snapshot(refresh = false): Promise<Snapshot> {
    if (!refresh && cached && deps.now() - cached.at < HOSTS_TTL_MS) return cached
    const snap = await compute(refresh)
    // A local-only list after a failure is not kept (an older list is dropped too): the next call asks the CLI again.
    cached = snap.listed ? snap : null
    return snap
  }

  const localHost = (): HostInfo =>
    ({ id: 'local', label: 'This Mac', kind: 'local', status: isSupportedLocalPlatform(deps.platform) ? 'ready' : 'unsupported' })

  // Status is derived on every call: a kernel recorded by an ssh run shows up without a new read.
  // Off a supported local platform nothing is tried, SSH hosts included (spec 2.1).
  async function hostsOf(snap: Snapshot): Promise<HostInfo[]> {
    const local = localHost()
    const supported = local.status === 'ready'
    const ssh = await Promise.all(snap.envs.map(async (env): Promise<HostInfo> => {
      const info = (status: HostStatus): HostInfo => ({ id: `ssh:${env}`, label: env, kind: 'ssh', status })
      if (!supported) return info('unsupported')
      const kernel = await storage.get(kernelKey(env))
      if (typeof kernel === 'string' && !isSupportedRemoteKernel(kernel)) return info('unsupported')
      const rows = snap.reads.get(env)
      if (!rows) return info('unreachable')
      return info(rows.length === 0 ? 'no-workspace' : 'ready')
    }))
    return [local, ...ssh]
  }

  // The local terminals among the focused workspace's terminals; none when the CLI cannot list them.
  async function focusedLocalTerminals(focus: FocusContext): Promise<{ handle: string; worktreePath: string }[]> {
    if (focus.terminalIds.length === 0) return []
    try {
      return (await cli.listLocalTerminals({ timeoutMs: TERMINAL_LOOKUP_TIMEOUT_MS })).filter((t) => focus.terminalIds.includes(t.handle))
    } catch {
      return [] // fall through to name matching
    }
  }

  // The one host whose workspaces match the focus by name and branch, if exactly one does. None when this Mac's
  // list fails: local is unknown, so a unique match cannot be claimed.
  async function onlyByName(snap: Snapshot, focus: FocusContext): Promise<HostId | undefined> {
    const candidates: HostId[] = []
    try {
      if ((await deps.listLocalWorkspaces()).some((w) => sameWorkspace(focus, w.name, w.branch))) candidates.push('local')
    } catch {
      return undefined
    }
    for (const env of snap.envs) {
      const rows = [...(snap.reads.get(env) ?? []), ...(lastKnown.get(env) ?? [])]
      if (rows.some((w) => sameWorkspace(focus, w.displayName, w.branch))) candidates.push(`ssh:${env}`)
    }
    return candidates.length === 1 ? candidates[0] : undefined
  }

  async function matchFocus(focus: FocusContext): Promise<HostId | null> {
    const snap = await snapshot()
    const hosts = await hostsOf(snap)
    const status = (id: HostId) => hosts.find((h) => h.id === id)?.status
    if (status('local') === 'ready' && (await focusedLocalTerminals(focus)).length > 0) return 'local'
    const only = await onlyByName(snap, focus)
    return only && status(only) === 'ready' ? only : null
  }

  // The focused local workspace: the one a focused local terminal runs in, else a name+branch match only when it is
  // unique on this Mac (many workspaces are "main/main"), else the first.
  async function localAnchor(focus: FocusContext | null): Promise<{ path: string; workspaceId: string; name: string } | null> {
    let all: LocalWorkspace[]
    try { all = await deps.listLocalWorkspaces() } catch { return null }
    const terminals = focus ? await focusedLocalTerminals(focus) : []
    const byTerminal = all.find((w) => terminals.some((t) => t.worktreePath === w.path))
    const named = focus ? all.filter((w) => sameWorkspace(focus, w.name, w.branch)) : []
    const pick = byTerminal ?? (named.length === 1 ? named[0] : undefined) ?? all[0]
    return pick ? { path: pick.path, workspaceId: pick.id, name: pick.name } : null
  }

  return {
    async list(refresh) {
      return hostsOf(await snapshot(refresh === true))
    },
    localHost,
    matchFocus,
    async anchor(hostId, focus) {
      const env = envOf(hostId)
      if (env === null) return localHost().status === 'ready' ? localAnchor(focus) : null
      const snap = await snapshot()
      if ((await hostsOf(snap)).find((h) => h.id === hostId)?.status !== 'ready') return null
      const rows = snap.reads.get(env) ?? []
      // A same-name workspace on another host must not decide: the focused row counts only when its name is on this
      // host alone. Unlike matchFocus no local terminal lookup: a focused local terminal could only point away from
      // this host.
      // So if this Mac's workspace list misses the focused local workspace, a same-name workspace on this host is used.
      const focused = focus && rows.find((w) => sameWorkspace(focus, w.displayName, w.branch))
      if (focused && focus && (await onlyByName(snap, focus)) === hostId) return { path: focused.path }
      const remembered = await storage.get(anchorKey(env))
      const kept = typeof remembered === 'string' ? rows.find((w) => w.path === remembered) : undefined
      if (kept) return { path: kept.path }
      return rows[0] ? { path: rows[0].path } : null
    },
    async remember(hostId, path) {
      const env = envOf(hostId)
      if (env !== null) await storage.set(anchorKey(env), path)
    },
  }
}
