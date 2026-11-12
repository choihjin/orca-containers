import { assert, describe, test } from 'orca/testing'
import type { FocusContext } from './protocol'
import { createHosts, HOSTS_TTL_MS, anchorKey, normalizeBranch, type LocalWorkspace } from './hosts'
import { FakeCli } from './remote/fake-cli'
import { CliError, type CallOptions } from './remote/orca-cli'
import { kernelKey, type KeyValueStore } from './remote/ssh'

function memoryStore() {
  const data = new Map<string, unknown>()
  const store: KeyValueStore = {
    async get(key) { return data.get(key) },
    async set(key, value) { data.set(key, value) },
    async delete(key) { data.delete(key) },
  }
  return { store, data }
}

// unreachable: the listing fails (remote_runtime_unavailable: Orca's runtime on that host is down). notCovered: Orca answers without
// covering the host (host_not_covered: connected, but no repo there).
class HostCli extends FakeCli {
  unreachable = new Set<string>()
  notCovered = new Set<string>()
  crash = false
  override async listWorktrees(environment: string, options?: CallOptions) {
    const rows = await super.listWorktrees(environment, options)
    if (this.crash) throw new TypeError('boom')
    if (this.unreachable.has(environment)) throw new CliError('remote_runtime_unavailable', 'down')
    if (this.notCovered.has(environment)) throw new CliError('host_not_covered', `Orca could not cover host ${environment}`)
    return rows
  }
}
const readsOf = (cli: FakeCli, env: string) => cli.calls.filter((c) => c.method === 'listWorktrees' && c.environment === env).length

const LOCAL_WS: LocalWorkspace[] = [
  { id: 'identity:wt2:local:1', name: 'main', path: '/Users/me/orca-docker', branch: 'main' },
  { id: 'identity:wt2:local:2', name: 'other', path: '/Users/me/other', branch: null },
]
const wt = (path: string, displayName: string, branch = '') => ({ path, displayName, branch })

function setup(opts: { platform?: string; localWorkspaces?: LocalWorkspace[] } = {}) {
  const cli = new HostCli()
  cli.environments = ['GPU1', 'GPU2', 'cloud-gpu']
  cli.worktrees = {
    GPU1: [wt('/home/me/main', 'main', 'refs/heads/main'), wt('/home/me/shop', 'web-shop'), wt('/home/me/x', 'x')],
    GPU2: [wt('/home/me/a5', 'a5')],
    'cloud-gpu': [],
  }
  cli.unreachable.add('GPU2')
  const mem = memoryStore()
  let t = 1_000
  const clock = { advance: (ms: number) => { t += ms } }
  const local = { fail: false }
  const logs: string[] = []
  const hosts = createHosts({
    cli, listLocalWorkspaces: async () => { if (local.fail) throw new Error('local list failed'); return opts.localWorkspaces ?? LOCAL_WS },
    platform: opts.platform ?? 'darwin', storage: mem.store, now: () => t, log: (message) => logs.push(message),
  })
  return { cli, hosts, mem, clock, local, logs }
}
const focus = (displayName: string, branch = '', terminalIds: string[] = []): FocusContext => ({ displayName, branch, terminalIds })

describe('hosts', () => {
  test('normalizeBranch strips refs/heads and null', () => {
    assert.equal(normalizeBranch('refs/heads/main'), 'main')
    assert.equal(normalizeBranch(null), '')
    assert.equal(normalizeBranch(undefined), '')
    assert.equal(normalizeBranch('dev'), 'dev')
  })

  // Orca's workspace listing does not decide whether an SSH host can be used: ssh does. GPU2's listing fails and
  // cloud-gpu lists no workspace, and both are ready.
  test('lists local and SSH hosts; a failed or empty workspace listing leaves an SSH host ready', async () => {
    const { hosts } = setup()
    assert.deepEqual(await hosts.list(), [
      { id: 'local', label: 'This Mac', kind: 'local', status: 'ready' },
      { id: 'ssh:GPU1', label: 'GPU1', kind: 'ssh', status: 'ready' },
      { id: 'ssh:GPU2', label: 'GPU2', kind: 'ssh', status: 'ready' },
      { id: 'ssh:cloud-gpu', label: 'cloud-gpu', kind: 'ssh', status: 'ready' },
    ])
  })

  // Fix round 1, item 1: this Mac's entry and anchor need no SSH host listing.
  test('this Mac answers from the platform alone, and its anchor lists no SSH hosts', async () => {
    const { hosts, cli } = setup()
    const listing = { asks: 0 }
    cli.listSshEnvironments = async () => { listing.asks++; throw new CliError('cli_timeout', 'Orca CLI timed out after 10000 ms') }
    assert.deepEqual(hosts.localHost(), { id: 'local', label: 'This Mac', kind: 'local', status: 'ready' })
    assert.deepEqual(await hosts.anchor('local', null), { path: '/Users/me/orca-docker', workspaceId: 'identity:wt2:local:1', name: 'main' })
    assert.equal(listing.asks, 0)
    const linux = setup({ platform: 'linux' })
    assert.deepEqual(linux.hosts.localHost(), { id: 'local', label: 'This Mac', kind: 'local', status: 'unsupported' })
    assert.deepEqual(await linux.hosts.anchor('local', null), { missing: 'no-workspace' })
    assert.deepEqual(linux.cli.calls, [])
  })

  test('local is unsupported off macOS', async () => {
    const { hosts } = setup({ platform: 'linux' })
    assert.equal((await hosts.list())[0]?.status, 'unsupported')
  })

  // Ruling M9 (spec 2.1): off macOS nothing is tried, SSH hosts included.
  test('off macOS the SSH hosts are unsupported too', async () => {
    const { hosts } = setup({ platform: 'linux' })
    assert.deepEqual((await hosts.list()).map((h) => [h.id, h.status]), [
      ['local', 'unsupported'], ['ssh:GPU1', 'unsupported'], ['ssh:GPU2', 'unsupported'], ['ssh:cloud-gpu', 'unsupported'],
    ])
  })

  test('a recorded non-Linux kernel makes the host unsupported at once, until refresh', async () => {
    const { hosts, mem, cli } = setup()
    const reads = () => cli.calls.filter((c) => c.method === 'listWorktrees').length
    assert.equal((await hosts.list(true)).find((h) => h.id === 'ssh:GPU1')?.status, 'ready')
    const before = reads()
    await mem.store.set(kernelKey('GPU1'), 'Darwin')
    assert.equal((await hosts.list()).find((h) => h.id === 'ssh:GPU1')?.status, 'unsupported')
    assert.equal(reads(), before)
    assert.equal((await hosts.list(true)).find((h) => h.id === 'ssh:GPU1')?.status, 'ready')
    assert.equal(mem.data.has(kernelKey('GPU1')), false)
  })

  // The kernel decides whatever Orca's listing says: a failed listing (GPU2) or an empty one (cloud-gpu) too.
  test('a stored Darwin kernel makes an SSH host unsupported, whether its listing failed, was empty or not', async () => {
    const { hosts, mem } = setup()
    for (const env of ['GPU1', 'GPU2', 'cloud-gpu']) await mem.store.set(kernelKey(env), 'Darwin')
    assert.deepEqual((await hosts.list()).map((h) => [h.id, h.status]), [
      ['local', 'ready'], ['ssh:GPU1', 'unsupported'], ['ssh:GPU2', 'unsupported'], ['ssh:cloud-gpu', 'unsupported'],
    ])
    await mem.store.set(kernelKey('GPU2'), 'Linux')
    assert.equal((await hosts.list()).find((h) => h.id === 'ssh:GPU2')?.status, 'ready')
  })

  test('prefers a local terminal id over a unique name match', async () => {
    const { hosts, cli } = setup()
    cli.localTerminals = [{ handle: 'term_x', worktreePath: '/Users/me/orca-docker' }]
    assert.equal(await hosts.matchFocus(focus('web-shop', '', ['term_x'])), 'local')
  })

  test('matches focus by name and normalized branch when one host matches', async () => {
    const { hosts } = setup()
    assert.equal(await hosts.matchFocus(focus('web-shop', '', ['term_y'])), 'ssh:GPU1')
  })

  test('returns null when names match on two hosts and no terminal decides', async () => {
    const { hosts } = setup()
    assert.equal(await hosts.matchFocus(focus('main', 'main')), null)
    assert.equal(await hosts.matchFocus(focus('nothing')), null)
  })

  test('anchors on the focused workspace, then the remembered one, then the first', async () => {
    const { hosts } = setup()
    assert.deepEqual(await hosts.anchor('ssh:GPU1', focus('x')), { path: '/home/me/x' })
    assert.deepEqual(await hosts.anchor('ssh:GPU1', null), { path: '/home/me/main' })
    await hosts.remember('ssh:GPU1', '/home/me/shop')
    assert.deepEqual(await hosts.anchor('ssh:GPU1', focus('zzz')), { path: '/home/me/shop' })
    assert.deepEqual(await hosts.anchor('ssh:GPU1', focus('x')), { path: '/home/me/x' })
    await hosts.remember('ssh:GPU1', '/gone')
    assert.deepEqual(await hosts.anchor('ssh:GPU1', null), { path: '/home/me/main' })
    // Local anchors carry the workspace name for the "Opened … in …" line (ruling I2).
    assert.deepEqual(await hosts.anchor('local', focus('other')), { path: '/Users/me/other', workspaceId: 'identity:wt2:local:2', name: 'other' })
    assert.deepEqual(await hosts.anchor('local', null), { path: '/Users/me/orca-docker', workspaceId: 'identity:wt2:local:1', name: 'main' })
  })

  // Only Shell / Open in terminal need an anchor; the service tells the person why there is none.
  test('tells why there is no anchor: unreachable when the host listing failed, no-workspace when it listed none', async () => {
    const { hosts, cli } = setup()
    assert.deepEqual(await hosts.anchor('ssh:GPU2', focus('a5')), { missing: 'unreachable' })
    assert.deepEqual(await hosts.anchor('ssh:cloud-gpu', null), { missing: 'no-workspace' })
    await hosts.remember('ssh:cloud-gpu', '/home/me/old')
    assert.deepEqual(await hosts.anchor('ssh:cloud-gpu', null), { missing: 'no-workspace' })
    // The latest read counts: rows known from an earlier read do not make an anchor while the listing fails.
    cli.unreachable.add('GPU1')
    await hosts.list(true)
    assert.deepEqual(await hosts.anchor('ssh:GPU1', focus('x')), { missing: 'unreachable' })
    cli.unreachable.delete('GPU2')
    await hosts.list(true)
    assert.deepEqual(await hosts.anchor('ssh:GPU2', null), { path: '/home/me/a5' })
    // This Mac with no workspace is no-workspace (a failing local list too: see its own test below).
    const none = setup({ localWorkspaces: [] })
    assert.deepEqual(await none.hosts.anchor('local', null), { missing: 'no-workspace' })
  })

  // Ruling I1: a same-name workspace on another host must not pick this host's anchor.
  // Ruling R1 changes the local-terminal case: an SSH anchor no longer asks for the local terminals, so a name
  // unique to this host decides (it was: a focused local terminal sent the anchor to the remembered path).
  test('anchors an SSH host on the focused workspace only when the focus resolves to that host', async () => {
    const { hosts, cli } = setup()
    await hosts.remember('ssh:GPU1', '/home/me/shop')
    // local main/main and GPU1 main/main both match, so the focus names no host.
    assert.deepEqual(await hosts.anchor('ssh:GPU1', focus('main', 'main')), { path: '/home/me/shop' })
    // The name is only on GPU1: it decides without a terminal lookup (R1).
    cli.localTerminals = [{ handle: 'term_x', worktreePath: '/Users/me/orca-docker' }]
    assert.deepEqual(await hosts.anchor('ssh:GPU1', focus('x', '', ['term_x'])), { path: '/home/me/x' })
    // Resolves to GPU1: its focused workspace wins.
    assert.deepEqual(await hosts.anchor('ssh:GPU1', focus('x', '', ['term_y'])), { path: '/home/me/x' })
    const first = setup()
    assert.deepEqual(await first.hosts.anchor('ssh:GPU1', focus('web-shop', '', ['term_x'])), { path: '/home/me/shop' })
  })

  // Ruling R1: SSH snapshots resolve an anchor on every request; that must not cost an Orca terminal list.
  test('an SSH anchor never lists the local terminals, unique or ambiguous name', async () => {
    const { hosts, cli } = setup()
    const lookups = () => cli.calls.filter((c) => c.method === 'listLocalTerminals').length
    cli.localTerminals = [{ handle: 'term_x', worktreePath: '/Users/me/orca-docker' }]
    await hosts.remember('ssh:GPU1', '/home/me/shop')
    assert.deepEqual(await hosts.anchor('ssh:GPU1', focus('x', '', ['term_x', 'term_y'])), { path: '/home/me/x' })
    // main/main is on this Mac and on GPU1: a local terminal could only say "this Mac", never GPU1.
    assert.deepEqual(await hosts.anchor('ssh:GPU1', focus('main', 'main', ['term_x'])), { path: '/home/me/shop' })
    assert.deepEqual(await hosts.anchor('ssh:GPU1', focus('zzz', '', ['term_x'])), { path: '/home/me/shop' })
    assert.equal(lookups(), 0)
    // A failing local workspace list: this Mac is unknown, so no unique match is claimed (as in matchFocus).
    const failing = setup()
    failing.local.fail = true
    await failing.hosts.remember('ssh:GPU1', '/home/me/shop')
    assert.deepEqual(await failing.hosts.anchor('ssh:GPU1', focus('x', '', ['term_x'])), { path: '/home/me/shop' })
    assert.equal(failing.cli.calls.filter((c) => c.method === 'listLocalTerminals').length, 0)
  })

  test('gives the local terminal lookup 5 s', async () => {
    const { hosts, cli } = setup()
    cli.localTerminals = [{ handle: 'term_x', worktreePath: '/Users/me/other' }]
    assert.equal(await hosts.matchFocus(focus('zzz', '', ['term_x'])), 'local')
    assert.deepEqual(await hosts.anchor('local', focus('zzz', '', ['term_x'])), { path: '/Users/me/other', workspaceId: 'identity:wt2:local:2', name: 'other' })
    const lookups = cli.calls.filter((c) => c.method === 'listLocalTerminals')
    assert.equal(lookups.length, 2)
    assert.ok(lookups.every((c) => 'timeoutMs' in c && c.timeoutMs === 5_000), JSON.stringify(lookups))
  })

  // Ruling I2: local Logs/Shell open in the focused local workspace, found by terminal first.
  test('anchors this Mac on the workspace of a focused local terminal, else a unique name match, else the first', async () => {
    const dup: LocalWorkspace[] = [
      { id: 'w1', name: 'main', path: '/Users/me/a', branch: 'main' },
      { id: 'w2', name: 'main', path: '/Users/me/b', branch: 'refs/heads/main' },
      { id: 'w3', name: 'solo', path: '/Users/me/c', branch: 'dev' },
    ]
    const { hosts, cli } = setup({ localWorkspaces: dup })
    cli.localTerminals = [{ handle: 'term_a', worktreePath: '/Users/me/a' }, { handle: 'term_b', worktreePath: '/Users/me/b' }]
    assert.deepEqual(await hosts.anchor('local', focus('main', 'main', ['term_9', 'term_b'])), { path: '/Users/me/b', workspaceId: 'w2', name: 'main' })
    // No local terminal in the focus: two main/main workspaces, so no name match; the first one.
    assert.deepEqual(await hosts.anchor('local', focus('main', 'main', ['term_9'])), { path: '/Users/me/a', workspaceId: 'w1', name: 'main' })
    assert.deepEqual(await hosts.anchor('local', focus('solo', 'dev')), { path: '/Users/me/c', workspaceId: 'w3', name: 'solo' })
    // The terminal list fails: name matching still works.
    cli.listLocalTerminals = async () => { throw new CliError('cli_exec_failed', 'no cli') }
    assert.deepEqual(await hosts.anchor('local', focus('solo', 'dev', ['term_b'])), { path: '/Users/me/c', workspaceId: 'w3', name: 'solo' })
  })

  // Ruling I3: the Orca CLI failing must not take this Mac down.
  test('a CLI failure listing SSH hosts leaves a local-only host list and logs it', async () => {
    const { hosts, cli, logs } = setup()
    cli.listSshEnvironments = async () => { throw new CliError('cli_exec_failed', 'spawn orca ENOENT') }
    assert.deepEqual(await hosts.list(), [{ id: 'local', label: 'This Mac', kind: 'local', status: 'ready' }])
    assert.deepEqual(await hosts.anchor('local', null), { path: '/Users/me/orca-docker', workspaceId: 'identity:wt2:local:1', name: 'main' })
    assert.equal(logs.length, 1)
    assert.match(logs[0] ?? '', /spawn orca ENOENT/)
    const crashing = setup()
    crashing.cli.listSshEnvironments = async () => { throw new TypeError('boom') }
    await assert.rejects(() => crashing.hosts.list(), (e: unknown) => e instanceof TypeError)
  })

  // Ruling R3: the local-only list a CLI failure leaves is not cached, so the next call asks the CLI again.
  test('does not cache the local-only list a CLI failure leaves', async () => {
    const { hosts, cli, logs } = setup()
    const listed = cli.listSshEnvironments.bind(cli)
    const cliState = { down: true, asks: 0 }
    cli.listSshEnvironments = async (options) => {
      cliState.asks++
      if (cliState.down) throw new CliError('cli_exec_failed', 'spawn orca ENOENT')
      return listed(options)
    }
    const ids = async (refresh?: boolean) => (await hosts.list(refresh)).map((h) => h.id)
    assert.deepEqual(await ids(), ['local'])
    assert.deepEqual(await ids(), ['local'])
    assert.equal(cliState.asks, 2) // no clock change: the TTL did not end, the failure just was not kept
    assert.equal(logs.length, 1) // one line per outage, not one per ask
    cliState.down = false
    assert.deepEqual(await ids(), ['local', 'ssh:GPU1', 'ssh:GPU2', 'ssh:cloud-gpu'])
    assert.equal(cliState.asks, 3)
    assert.deepEqual(await ids(), ['local', 'ssh:GPU1', 'ssh:GPU2', 'ssh:cloud-gpu'])
    assert.equal(cliState.asks, 3) // a good list is cached as before
    // A refresh that fails drops the good list too, so the next call asks again instead of serving it.
    cliState.down = true
    assert.deepEqual(await ids(true), ['local'])
    cliState.down = false
    assert.deepEqual(await ids(), ['local', 'ssh:GPU1', 'ssh:GPU2', 'ssh:cloud-gpu'])
    assert.equal(cliState.asks, 5)
    assert.equal(logs.length, 2) // the second outage is logged again
  })

  test('gives each host listing 10 s', async () => {
    const { hosts, cli } = setup()
    await hosts.list()
    const listings = cli.calls.filter((c) => c.method === 'listSshEnvironments' || c.method === 'listWorktrees')
    assert.equal(listings.length, 4)
    assert.ok(listings.every((c) => 'timeoutMs' in c && c.timeoutMs === 10_000), JSON.stringify(listings))
  })

  test('remember stores only ssh anchors', async () => {
    const { hosts, mem } = setup()
    await hosts.remember('local', '/p')
    await hosts.remember('ssh:GPU1', '/q')
    assert.deepEqual([...mem.data.keys()], [anchorKey('GPU1')])
  })

  test('caches the host list for five minutes', async () => {
    const { hosts, cli, clock } = setup()
    const count = () => cli.calls.filter((c) => c.method === 'listSshEnvironments').length
    await hosts.list()
    clock.advance(HOSTS_TTL_MS - 1)
    await hosts.list()
    assert.equal(count(), 1)
    clock.advance(2)
    await hosts.list()
    assert.equal(count(), 2)
    await hosts.list(true)
    assert.equal(count(), 3)
  })

  test('does not claim a unique local match while a host with that workspace is unreadable', async () => {
    const { hosts, cli } = setup()
    cli.worktrees.GPU1 = [wt('/home/me/main', 'main', 'refs/heads/main')]
    await hosts.list()
    cli.unreachable.add('GPU1')
    await hosts.list(true)
    assert.equal(await hosts.matchFocus(focus('main', 'main', ['term_y'])), null)
  })

  // Orca is connected but the listing does not cover the host. That is no workspace, not unreachable.
  test('a listing that does not cover the host reads as empty: no-workspace, and last known rows are kept', async () => {
    const { hosts, cli } = setup()
    await hosts.list()
    cli.notCovered.add('GPU1')
    assert.equal((await hosts.list(true)).find((h) => h.id === 'ssh:GPU1')?.status, 'ready')
    const before = readsOf(cli, 'GPU1')
    assert.deepEqual(await hosts.anchor('ssh:GPU1', focus('x')), { missing: 'no-workspace' })
    assert.equal(readsOf(cli, 'GPU1'), before) // an empty read is not read again
    // lastKnown still has GPU1's rows from the first read: the focus on 'x' still resolves to GPU1.
    assert.equal(await hosts.matchFocus(focus('x')), 'ssh:GPU1')
    // Any other CliError is a failed read: unreachable.
    cli.notCovered.delete('GPU1')
    cli.unreachable.add('GPU1')
    await hosts.list(true)
    assert.deepEqual(await hosts.anchor('ssh:GPU1', focus('x')), { missing: 'unreachable' })
  })

  // A failed read can be up to five minutes old (the host list cache): Orca may have reconnected since.
  test('before answering unreachable, anchor reads that host once more and keeps what it reads', async () => {
    const { hosts, cli } = setup()
    await hosts.list()
    const before = readsOf(cli, 'GPU2')
    // Still failing: one more read, then unreachable.
    assert.deepEqual(await hosts.anchor('ssh:GPU2', null), { missing: 'unreachable' })
    assert.equal(readsOf(cli, 'GPU2'), before + 1)
    // Recovered: the read is used and cached, and it becomes the host's last known rows.
    cli.unreachable.delete('GPU2')
    assert.deepEqual(await hosts.anchor('ssh:GPU2', focus('a5')), { path: '/home/me/a5' })
    assert.equal(readsOf(cli, 'GPU2'), before + 2)
    assert.deepEqual(await hosts.anchor('ssh:GPU2', null), { path: '/home/me/a5' })
    assert.equal(await hosts.matchFocus(focus('a5')), 'ssh:GPU2')
    assert.equal(readsOf(cli, 'GPU2'), before + 2)
    const listings = cli.calls.filter((c) => c.method === 'listWorktrees')
    assert.ok(listings.every((c) => 'timeoutMs' in c && c.timeoutMs === 10_000), JSON.stringify(listings))
  })

  test('the re-read can find the host not covered: no-workspace', async () => {
    const { hosts, cli } = setup()
    await hosts.list()
    cli.unreachable.delete('GPU2')
    cli.notCovered.add('GPU2')
    assert.deepEqual(await hosts.anchor('ssh:GPU2', null), { missing: 'no-workspace' })
    assert.deepEqual(await hosts.anchor('ssh:GPU2', null), { missing: 'no-workspace' })
    assert.equal(readsOf(cli, 'GPU2'), 2) // the list's read and one re-read
  })

  test('only a failed read is read again: a good or empty read, or a host Orca does not list, is not', async () => {
    const { hosts, cli } = setup()
    await hosts.list()
    const total = () => cli.calls.filter((c) => c.method === 'listWorktrees').length
    const before = total()
    assert.deepEqual(await hosts.anchor('ssh:GPU1', null), { path: '/home/me/main' })
    assert.deepEqual(await hosts.anchor('ssh:cloud-gpu', null), { missing: 'no-workspace' })
    assert.deepEqual(await hosts.anchor('ssh:nope', null), { missing: 'unreachable' })
    assert.equal(total(), before)
  })

  test('hosts that were never readable do not block auto-follow', async () => {
    const { hosts } = setup()
    assert.equal(await hosts.matchFocus(focus('x')), 'ssh:GPU1')
  })

  // A host whose listing fails is still ready (ssh decides), so its last known rows can still be followed.
  test('follows a host whose listing now fails, from its last known rows', async () => {
    const { hosts, cli } = setup()
    await hosts.list()
    cli.unreachable.add('GPU1')
    assert.equal((await hosts.list(true)).find((h) => h.id === 'ssh:GPU1')?.status, 'ready')
    assert.equal(await hosts.matchFocus(focus('x')), 'ssh:GPU1')
  })

  test('never returns a non-ready host, including local by terminal id', async () => {
    const { hosts, cli } = setup({ platform: 'linux' })
    cli.localTerminals = [{ handle: 'term_x', worktreePath: '/p' }]
    assert.equal(await hosts.matchFocus(focus('zzz', '', ['term_x'])), null)
    assert.equal(await hosts.matchFocus(focus('other')), null)
  })

  test('a failing local workspace list makes matchFocus null and anchor(local) no-workspace', async () => {
    const { hosts, cli, local } = setup()
    local.fail = true
    assert.equal(await hosts.matchFocus(focus('x')), null)
    assert.deepEqual(await hosts.anchor('local', null), { missing: 'no-workspace' })
    cli.localTerminals = [{ handle: 'term_x', worktreePath: '/p' }]
    assert.equal(await hosts.matchFocus(focus('x', '', ['term_x'])), 'local')
  })

  test('only a CliError counts as a failed listing; other errors propagate', async () => {
    const { hosts, cli } = setup()
    cli.crash = true
    await assert.rejects(() => hosts.list(), (e: unknown) => e instanceof TypeError)
  })

  test('the one re-read before unreachable lets a non-CliError through too', async () => {
    const { hosts, cli } = setup()
    await hosts.list() // GPU2's listing fails with a CliError and is cached as a failed read
    cli.crash = true
    await assert.rejects(() => hosts.anchor('ssh:GPU2', null), (e: unknown) => e instanceof TypeError)
  })
})
