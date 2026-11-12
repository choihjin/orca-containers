import { assert, describe, test } from 'orca/testing'
import type { ContainerAction, FocusContext, HostId, HostInfo, HostStatus, Result } from './protocol'
import type { Hosts } from './hosts'
import type { LocalRunner } from './local/runner'
import { kernelKey, type KeyValueStore, type SshRunner } from './remote/ssh'
import { CliError, type OrcaCli } from './remote/orca-cli'
import type { DockerCommand } from './docker/commands'
import type { CommandResult } from './docker/parse'
import { createService, terminalTitle } from './service'

const ID = 'a'.repeat(12)
const OPTIONS = { deadline: 1_000 }
const FOCUS: FocusContext = { displayName: 'main', branch: 'main', terminalIds: [] }

const versionLine = JSON.stringify({ Server: { Version: '27.0.1' } })
const okResults = (): CommandResult[] => [
  { name: 'version', code: 0, lines: [versionLine] },
  { name: 'ps', code: 0, lines: [] },
  { name: 'images', code: 0, lines: [] },
  { name: 'volumes', code: 0, lines: [] },
  { name: 'networks', code: 0, lines: [] },
]

// The kernel the last ssh run stored for host A: Linux unless a test says otherwise (null: none stored yet).
function setup(opts: { status?: HostStatus; anchor?: { path: string; workspaceId?: string } | null; kernel?: string | null } = {}) {
  const calls: string[] = []
  const log = {
    localRuns: [] as { commands: readonly DockerCommand[]; options: unknown }[],
    sshRuns: [] as { env: string; commands: readonly DockerCommand[]; options: unknown }[],
    created: [] as { environment: string; worktreePath: string; title: string; command: string; focus?: boolean }[],
    switched: [] as { environment?: string; handle: string }[],
    logs: [] as string[],
    localTerminals: [] as { workspaceId: string; title: string; command: string }[],
    remembered: [] as { hostId: HostId; path: string }[],
    anchors: [] as { hostId: HostId; focus: FocusContext | null }[],
    order: [] as string[], // every call, the host lookups included
  }
  let localResults: CommandResult[] = okResults()
  let sshResult: Result<CommandResult[]> = { ok: true, value: okResults() }
  let createError: Error | null = null
  let switchError: Error | null = null
  const status = opts.status ?? 'ready'
  const anchor = opts.anchor === undefined ? { path: '/w', workspaceId: 'ws1', name: 'proj' } : opts.anchor
  const hosts = {
    async list(): Promise<HostInfo[]> {
      return [{ id: 'local', label: 'This Mac', kind: 'local', status }, { id: 'ssh:A', label: 'A', kind: 'ssh', status }]
    },
    localHost(): HostInfo { return { id: 'local', label: 'This Mac', kind: 'local', status } },
    async anchor(hostId: HostId, focus: FocusContext | null) { log.order.push('anchor'); log.anchors.push({ hostId, focus }); return anchor },
    async remember(hostId: HostId, path: string) { log.order.push('remember'); log.remembered.push({ hostId, path }) },
  } as unknown as Hosts
  const stored = new Map<string, unknown>()
  const kernel = opts.kernel === undefined ? 'Linux' : opts.kernel
  if (kernel !== null) stored.set(kernelKey('A'), kernel)
  let storageFails = false
  const storage: KeyValueStore = {
    async get(key) {
      log.order.push(`storage.get ${key}`)
      if (storageFails) throw new Error('storage unavailable')
      return stored.get(key)
    },
    async set(key, value) { stored.set(key, value) },
    async delete(key) { stored.delete(key) },
  }
  const local: LocalRunner = {
    async run(commands, options) { calls.push('local.run'); log.order.push('local.run'); log.localRuns.push({ commands, options }); return localResults },
  }
  const ssh: SshRunner = {
    async run(env, commands, options) { calls.push('ssh.run'); log.order.push('ssh.run'); log.sshRuns.push({ env, commands, options }); return sshResult },
  }
  const cli = {
    async createTerminal(o: { environment: string; worktreePath: string; title: string; command: string; focus?: boolean }) {
      calls.push('createTerminal'); log.order.push('createTerminal')
      if (createError) throw createError
      log.created.push(o)
      return 'term_1'
    },
    async switchTo(o: { environment?: string; handle: string }) {
      calls.push('switchTo'); log.order.push('switchTo')
      log.switched.push(o)
      if (switchError) throw switchError
    },
  } as unknown as OrcaCli
  const service = createService({
    hosts, local, ssh, cli, storage, now: () => 4242, log: (m) => { log.logs.push(m) },
    async openLocalTerminal(o) { calls.push('openLocalTerminal'); log.localTerminals.push(o); return 'local_term' },
  })
  return {
    service, calls, log,
    setLocal(r: CommandResult[]) { localResults = r },
    setSsh(r: Result<CommandResult[]>) { sshResult = r },
    failCreate(e: Error) { createError = e },
    failSwitch(e: Error) { switchError = e },
    failStorageRead() { storageFails = true },
  }
}

// Every Orca CLI and host lookup a terminal or a workspace anchor would need throws: a request that answers did not use them.
function noTerminalSetup() {
  const used: string[] = []
  const refuse = (name: string) => async () => { used.push(name); throw new Error(`${name} must not be called`) }
  const cli = {
    listSshEnvironments: refuse('cli.listSshEnvironments'), listWorktrees: refuse('cli.listWorktrees'),
    listLocalTerminals: refuse('cli.listLocalTerminals'), createTerminal: refuse('cli.createTerminal'), switchTo: refuse('cli.switchTo'),
  } satisfies OrcaCli
  const hosts = {
    async list(): Promise<HostInfo[]> { return [{ id: 'local', label: 'This Mac', kind: 'local', status: 'ready' }, { id: 'ssh:A', label: 'A', kind: 'ssh', status: 'ready' }] },
    localHost(): HostInfo { return { id: 'local', label: 'This Mac', kind: 'local', status: 'ready' } },
    matchFocus: refuse('hosts.matchFocus'), anchor: refuse('hosts.anchor'), remember: refuse('hosts.remember'),
  } satisfies Hosts
  const runs: { env: string; names: string[] }[] = []
  const answers: Record<string, CommandResult[]> = {
    snapshot: okResults(), action: [{ name: 'action', code: 0, lines: [ID] }], logs: [{ name: 'logs', code: 0, lines: ['ssh log'] }],
  }
  const ssh: SshRunner = {
    async run(env, commands) {
      const names = commands.map((c) => c.name)
      runs.push({ env, names })
      return { ok: true, value: answers[names.includes('action') ? 'action' : names.includes('logs') ? 'logs' : 'snapshot']! }
    },
  }
  const local: LocalRunner = { async run() { used.push('local.run'); return [] } }
  const storage: KeyValueStore = { get: refuse('storage.get'), set: refuse('storage.set'), delete: refuse('storage.delete') }
  const service = createService({
    hosts, local, ssh, cli, storage, now: () => 4242, log: () => {},
    openLocalTerminal: refuse('openLocalTerminal'),
  })
  return { service, used, runs }
}

describe('service', () => {
  test('local snapshot runs the fixed commands through the local runner', async () => {
    const t = setup()
    const r = await t.service.snapshot('local', OPTIONS)
    assert.equal(r.ok, true)
    if (r.ok) { assert.equal(r.value.takenAt, 4242); assert.equal(r.value.hostId, 'local'); assert.equal(r.value.serverVersion, '27.0.1') }
    assert.equal(t.log.localRuns.length, 1)
    assert.deepEqual(t.log.localRuns[0]!.commands.map((c) => c.name), ['version', 'ps', 'images', 'volumes', 'networks'])
    assert.equal(t.log.localRuns[0]!.options, OPTIONS)
  })

  test('ssh snapshot runs the fixed commands through the ssh runner, with no anchor lookup and nothing remembered', async () => {
    const t = setup({ anchor: { path: '/home/me/main' } })
    const r = await t.service.snapshot('ssh:A', OPTIONS)
    assert.equal(r.ok, true)
    if (r.ok) { assert.equal(r.value.hostId, 'ssh:A'); assert.equal(r.value.serverVersion, '27.0.1') }
    assert.equal(t.log.sshRuns.length, 1)
    assert.equal(t.log.sshRuns[0]!.env, 'A')
    assert.deepEqual(t.log.sshRuns[0]!.commands.map((c) => c.name), ['version', 'ps', 'images', 'volumes', 'networks'])
    assert.equal(t.log.sshRuns[0]!.options, OPTIONS)
    assert.deepEqual(t.log.order, ['ssh.run'])
  })

  test('no terminal for snapshot, action or logs on SSH', async () => {
    const t = noTerminalSetup()
    const snapshot = await t.service.snapshot('ssh:A', OPTIONS)
    assert.equal(snapshot.ok && snapshot.value.serverVersion, '27.0.1', JSON.stringify(snapshot))
    assert.deepEqual(await t.service.action('ssh:A', 'restart', ID, OPTIONS), { ok: true, value: { done: true } })
    assert.deepEqual(await t.service.logs('ssh:A', ID, OPTIONS), { ok: true, value: { lines: ['ssh log'], takenAt: 4242 } })
    assert.deepEqual(t.runs, [
      { env: 'A', names: ['version', 'ps', 'images', 'volumes', 'networks'] },
      { env: 'A', names: ['action'] },
      { env: 'A', names: ['logs'] },
    ])
    assert.deepEqual(t.used, [])
  })

  test('ssh problems pass through and nothing is remembered', async () => {
    const t = setup()
    const problem = { kind: 'ssh-failed' as const, message: 'No ssh host named "A" on this Mac.' }
    t.setSsh({ ok: false, problem })
    assert.deepEqual(await t.service.snapshot('ssh:A', OPTIONS), { ok: false, problem })
    assert.deepEqual(await t.service.action('ssh:A', 'stop', ID, OPTIONS), { ok: false, problem })
    assert.deepEqual(await t.service.logs('ssh:A', ID, OPTIONS), { ok: false, problem })
    assert.deepEqual(t.log.remembered, [])
    assert.deepEqual(t.log.anchors, [])
  })

  test('a host that is not ready answers its own problem without running anything', async () => {
    for (const status of ['unsupported', 'unreachable', 'no-workspace'] as const) {
      const t = setup({ status })
      const r = await t.service.snapshot('ssh:A', OPTIONS)
      assert.equal(!r.ok && r.problem.kind, status)
      const a = await t.service.action('local', 'start', ID, OPTIONS)
      assert.equal(!a.ok && a.problem.kind, status)
      const o = await t.service.openTerminal('ssh:A', 'logs', ID, 'web', null, OPTIONS)
      assert.equal(!o.ok && o.problem.kind, status)
      assert.deepEqual(t.calls, [])
    }
  })

  // Ruling R1: local Docker needs no workspace, so a local snapshot or action never looks one up (on this Mac that
  // costs an Orca CLI terminal list); a local Logs/Shell does. Over ssh only Logs/Shell terminals need one.
  test('only a terminal looks up a workspace: no lookup for a snapshot, action or logs on either host', async () => {
    const t = setup({ anchor: null })
    assert.equal((await t.service.snapshot('local', OPTIONS)).ok, true)
    t.setLocal([{ name: 'action', code: 0, lines: [ID] }])
    assert.deepEqual(await t.service.action('local', 'start', ID, OPTIONS), { ok: true, value: { done: true } })
    assert.deepEqual(t.log.anchors, [])
    assert.equal(t.log.localRuns.length, 2)
    const opened = await t.service.openTerminal('local', 'logs', ID, 'web', FOCUS, OPTIONS)
    assert.equal(!opened.ok && opened.problem.kind, 'no-workspace')
    assert.deepEqual(t.log.anchors, [{ hostId: 'local', focus: FOCUS }])
    const ssh = setup({ anchor: null })
    assert.equal((await ssh.service.snapshot('ssh:A', OPTIONS)).ok, true)
    ssh.setSsh({ ok: true, value: [{ name: 'action', code: 0, lines: [ID] }] })
    assert.equal((await ssh.service.action('ssh:A', 'stop', ID, OPTIONS)).ok, true)
    ssh.setSsh({ ok: true, value: [{ name: 'logs', code: 0, lines: [] }] })
    assert.equal((await ssh.service.logs('ssh:A', ID, OPTIONS)).ok, true)
    assert.deepEqual(ssh.log.anchors, [])
    const sshTerminal = await ssh.service.openTerminal('ssh:A', 'shell', ID, 'web', FOCUS, OPTIONS)
    assert.equal(!sshTerminal.ok && sshTerminal.problem.kind, 'no-workspace')
    assert.deepEqual(ssh.log.anchors, [{ hostId: 'ssh:A', focus: FOCUS }])
  })

  test('a ready SSH host without an anchor still lists over ssh but opens no terminal', async () => {
    const t = setup({ anchor: null })
    assert.equal((await t.service.snapshot('ssh:A', OPTIONS)).ok, true)
    const r = await t.service.openTerminal('ssh:A', 'logs', ID, 'web', null, OPTIONS)
    assert.equal(!r.ok && r.problem.kind, 'no-workspace')
    assert.deepEqual(t.log.order, ['ssh.run', 'anchor'])
  })

  test('an unknown host id is invalid', async () => {
    const t = setup()
    const r = await t.service.snapshot('ssh:nope', OPTIONS)
    assert.equal(!r.ok && r.problem.kind, 'invalid')
    assert.deepEqual(t.calls, [])
  })

  test('refuses an invalid container id before touching any runner', async () => {
    const t = setup()
    const a = await t.service.action('local', 'stop', 'web; rm -rf /', OPTIONS)
    assert.equal(!a.ok && a.problem.kind, 'invalid')
    const b = await t.service.action('ssh:A', 'stop', 'xyz', OPTIONS)
    assert.equal(!b.ok && b.problem.kind, 'invalid')
    const c = await t.service.openTerminal('ssh:A', 'shell', '$(id)', 'web', null, OPTIONS)
    assert.equal(!c.ok && c.problem.kind, 'invalid')
    const d = await t.service.action('local', 'explode' as ContainerAction, ID, OPTIONS)
    assert.equal(!d.ok && d.problem.kind, 'invalid')
    assert.deepEqual(t.calls, [])
  })

  test('an action runs the fixed command and succeeds on code 0', async () => {
    const t = setup()
    t.setLocal([{ name: 'action', code: 0, lines: [ID] }])
    const r = await t.service.action('local', 'remove', ID, OPTIONS)
    assert.deepEqual(r, { ok: true, value: { done: true } })
    assert.deepEqual(t.log.localRuns[0]!.commands, [{ name: 'action', argv: ['rm', ID] }])
    const t2 = setup()
    t2.setSsh({ ok: true, value: [{ name: 'action', code: 0, lines: [ID] }] })
    const r2 = await t2.service.action('ssh:A', 'stop', ID, OPTIONS)
    assert.equal(r2.ok, true)
    assert.deepEqual(t2.log.sshRuns[0]!.commands, [{ name: 'action', argv: ['stop', ID] }])
    assert.deepEqual(t2.log.remembered, [])
  })

  test('an action failure is classified', async () => {
    const t = setup()
    t.setLocal([{ name: 'action', code: 1, lines: ['permission denied while trying to connect'] }])
    const r = await t.service.action('local', 'start', ID, OPTIONS)
    assert.equal(!r.ok && r.problem.kind, 'permission-denied')
    const t2 = setup()
    t2.setSsh({ ok: true, value: [{ name: 'action', code: 1, lines: ['Error: No such container'] }] })
    const r2 = await t2.service.action('ssh:A', 'start', ID, OPTIONS)
    assert.equal(!r2.ok && r2.problem.kind, 'failed')
  })

  test('logs run the fixed command locally and remotely', async () => {
    const t = setup()
    t.setLocal([{ name: 'logs', code: 0, lines: ['a', 'b'] }])
    assert.deepEqual(await t.service.logs('local', ID, OPTIONS), { ok: true, value: { lines: ['a', 'b'], takenAt: 4242 } })
    assert.deepEqual(t.log.localRuns[0]!.commands, [{ name: 'logs', argv: ['logs', '--tail', '200', ID] }])
    assert.deepEqual(t.log.anchors, [])
    const t2 = setup({ anchor: { path: '/home/me/main' } })
    t2.setSsh({ ok: true, value: [{ name: 'logs', code: 0, lines: ['x'] }] })
    assert.deepEqual(await t2.service.logs('ssh:A', ID, OPTIONS), { ok: true, value: { lines: ['x'], takenAt: 4242 } })
    assert.deepEqual(t2.log.sshRuns[0]!.commands, [{ name: 'logs', argv: ['logs', '--tail', '200', ID] }])
    assert.deepEqual(t2.log.remembered, [])
  })

  test('logs cut each line to 2 000 characters, so the answer stays far under the 1 MiB request limit', async () => {
    const t = setup()
    t.setLocal([{ name: 'logs', code: 0, lines: ['x'.repeat(2_500), 'short', 'y'.repeat(2_000), ''] }])
    assert.deepEqual(await t.service.logs('local', ID, OPTIONS), {
      ok: true, value: { lines: ['x'.repeat(2_000) + '…', 'short', 'y'.repeat(2_000), ''], takenAt: 4242 },
    })
    const t2 = setup({ anchor: { path: '/home/me/main' } })
    t2.setSsh({ ok: true, value: [{ name: 'logs', code: 0, lines: ['z'.repeat(100_000)] }] })
    assert.deepEqual(await t2.service.logs('ssh:A', ID, OPTIONS), { ok: true, value: { lines: ['z'.repeat(2_000) + '…'], takenAt: 4242 } })
  })

  test('logs keep only the newest lines that fit in 100 000 characters, counted after the cut', async () => {
    const linesOf = async (lines: string[]) => {
      const t = setup()
      t.setLocal([{ name: 'logs', code: 0, lines }])
      const r = await t.service.logs('local', ID, OPTIONS)
      return r.ok ? r.value.lines : r
    }
    // Each line starts with its number, so the order shows.
    const numbered = (count: number, length: number) => Array.from({ length: count }, (_, i) => String(i).padStart(4, '0').padEnd(length, 'x'))
    const full = numbered(200, 2_000)
    assert.deepEqual(await linesOf(full), full.slice(150))
    // Cut lines are 2 001 characters: 49 fit, 50 would not.
    const long = numbered(200, 5_000)
    assert.deepEqual(await linesOf(long), long.slice(151).map((line) => `${line.slice(0, 2_000)}…`))
    assert.deepEqual(await linesOf(['a', '', 'b']), ['a', '', 'b'])
  })

  test('a logs failure is classified', async () => {
    const t = setup()
    t.setLocal([{ name: 'logs', code: 1, lines: ['permission denied while trying to connect'] }])
    const r = await t.service.logs('local', ID, OPTIONS)
    assert.equal(!r.ok && r.problem.kind, 'permission-denied')
    const t2 = setup()
    t2.setSsh({ ok: true, value: [{ name: 'logs', code: 1, lines: ['Error: No such container'] }] })
    const r2 = await t2.service.logs('ssh:A', ID, OPTIONS)
    assert.equal(!r2.ok && r2.problem.kind, 'failed')
  })

  test('logs refuse an invalid id before any runner, and a host that is not ready answers its problem', async () => {
    const t = setup()
    for (const host of ['local', 'ssh:A'] as const) {
      const r = await t.service.logs(host, 'web; rm -rf /', OPTIONS)
      assert.equal(!r.ok && r.problem.kind, 'invalid')
    }
    assert.deepEqual(t.calls, [])
    const down = setup({ status: 'unreachable' })
    const r = await down.service.logs('ssh:A', ID, OPTIONS)
    assert.equal(!r.ok && r.problem.kind, 'unreachable')
    assert.deepEqual(down.calls, [])
  })

  test('opens remote logs in a focused terminal on the anchor workspace, remembers it and switches to it, with no ssh run', async () => {
    const t = setup({ anchor: { path: '/home/me/main' } })
    const r = await t.service.openTerminal('ssh:A', 'logs', ID, 'web', null, OPTIONS)
    assert.deepEqual(r, { ok: true, value: { opened: true, workspace: 'main' } }) // ruling I2: the path's basename
    assert.deepEqual(t.log.created, [{
      environment: 'A', worktreePath: '/home/me/main', title: 'logs: web', command: `docker logs -f --tail 200 ${ID}`, focus: true,
    }])
    assert.deepEqual(t.log.remembered, [{ hostId: 'ssh:A', path: '/home/me/main' }])
    assert.deepEqual(t.log.switched, [{ environment: 'A', handle: 'term_1' }])
    assert.deepEqual(t.log.order, ['anchor', `storage.get ${kernelKey('A')}`, 'createTerminal', 'remember', 'switchTo'])
    assert.deepEqual(t.log.sshRuns, [])
  })

  test('an SSH terminal on a host whose kernel is not known yet checks it with one empty ssh run first', async () => {
    const t = setup({ kernel: null, anchor: { path: '/home/me/main' } })
    const r = await t.service.openTerminal('ssh:A', 'shell', ID, 'web', FOCUS, OPTIONS)
    assert.deepEqual(r, { ok: true, value: { opened: true, workspace: 'main' } })
    assert.deepEqual(t.log.sshRuns, [{ env: 'A', commands: [], options: OPTIONS }])
    assert.deepEqual(t.log.order, ['anchor', `storage.get ${kernelKey('A')}`, 'ssh.run', 'createTerminal', 'remember', 'switchTo'])
  })

  test('a failing kernel check answers its own problem and opens no terminal', async () => {
    const problems = [
      { kind: 'unsupported' as const, message: 'Remote kernel Darwin is not supported' },
      { kind: 'ssh-failed' as const, message: 'No ssh host named "A" on this Mac.' },
      { kind: 'timeout' as const, message: 'The ssh session to "A" did not finish in time' },
    ]
    for (const problem of problems) {
      const t = setup({ kernel: null })
      t.setSsh({ ok: false, problem })
      assert.deepEqual(await t.service.openTerminal('ssh:A', 'logs', ID, 'web', null, OPTIONS), { ok: false, problem })
      assert.equal(t.log.sshRuns.length, 1)
      assert.deepEqual(t.log.created, [])
      assert.deepEqual(t.log.remembered, [])
      assert.deepEqual(t.log.switched, [])
    }
  })

  test('a stored Linux kernel opens the SSH terminal without an ssh run; a local terminal never checks one', async () => {
    const t = setup({ kernel: 'Linux' })
    assert.equal((await t.service.openTerminal('ssh:A', 'shell', ID, 'web', null, OPTIONS)).ok, true)
    assert.equal((await t.service.openTerminal('local', 'shell', ID, 'web', FOCUS, OPTIONS)).ok, true)
    assert.deepEqual(t.log.sshRuns, [])
    assert.equal(t.log.order.filter((step) => step.startsWith('storage.get')).length, 1)
  })

  test('a stored kernel other than Linux answers unsupported at once: no ssh run, no terminal', async () => {
    const t = setup({ kernel: 'Darwin' })
    assert.deepEqual(await t.service.openTerminal('ssh:A', 'shell', ID, 'web', null, OPTIONS),
      { ok: false, problem: { kind: 'unsupported', message: 'This host is not supported.' } })
    assert.deepEqual(t.log.sshRuns, [])
    assert.deepEqual(t.log.created, [])
    assert.deepEqual(t.log.remembered, [])
  })

  test('a kernel record that cannot be read counts as unknown: one check run, then the terminal', async () => {
    const t = setup({ kernel: 'Linux' })
    t.failStorageRead()
    assert.equal((await t.service.openTerminal('ssh:A', 'shell', ID, 'web', null, OPTIONS)).ok, true)
    assert.deepEqual(t.log.sshRuns.map((r) => r.commands), [[]])
    assert.equal(t.log.created.length, 1)
  })

  test('the kernel check comes after the container id and the workspace are known', async () => {
    const bad = setup({ kernel: null })
    assert.equal((await bad.service.openTerminal('ssh:A', 'shell', '$(id)', 'web', null, OPTIONS)).ok, false)
    const noAnchor = setup({ kernel: null, anchor: null })
    assert.equal((await noAnchor.service.openTerminal('ssh:A', 'shell', ID, 'web', null, OPTIONS)).ok, false)
    assert.deepEqual([...bad.log.sshRuns, ...noAnchor.log.sshRuns], [])
  })

  test('remote Logs/Shell switch Orca to the created terminal', async () => {
    const t = setup()
    await t.service.openTerminal('ssh:A', 'logs', ID, 'web', null, OPTIONS)
    assert.deepEqual(t.log.switched, [{ environment: 'A', handle: 'term_1' }])
  })

  test('a local terminal switches to the plugin terminal id without an environment', async () => {
    const t = setup()
    await t.service.openTerminal('local', 'shell', ID, 'web', FOCUS, OPTIONS)
    assert.deepEqual(t.log.switched, [{ handle: 'local_term' }])
  })

  test('a failing switch is logged once and the terminal still counts as opened', async () => {
    for (const hostId of ['ssh:A', 'local'] as const) {
      const t = setup()
      t.failSwitch(new CliError('cli_timeout', 'slow'))
      const r = await t.service.openTerminal(hostId, 'logs', ID, 'web', FOCUS, OPTIONS)
      assert.equal(r.ok && r.value.opened, true)
      assert.equal(t.log.logs.length, 1)
    }
  })

  test('any switch failure is swallowed, logged once, and the host is still remembered', async () => {
    for (const hostId of ['ssh:A', 'local'] as const) {
      const t = setup()
      t.failSwitch(new TypeError('x'))
      const r = await t.service.openTerminal(hostId, 'logs', ID, 'web', FOCUS, OPTIONS)
      assert.equal(r.ok && r.value.opened, true)
      assert.deepEqual(t.log.logs, ['terminal switch failed: x'])
      if (hostId === 'ssh:A') assert.deepEqual(t.log.remembered, [{ hostId: 'ssh:A', path: '/w' }])
    }
  })

  test('no switch when the terminal was not opened', async () => {
    const t = setup()
    t.failCreate(new CliError('cli_exec_failed', 'cannot reach'))
    await t.service.openTerminal('ssh:A', 'logs', ID, 'web', null, OPTIONS)
    const t2 = setup({ anchor: { path: '/w' } })
    const r = await t2.service.openTerminal('local', 'logs', ID, 'web', null, OPTIONS)
    assert.equal(!r.ok && r.problem.kind, 'no-workspace')
    assert.deepEqual(t.log.switched, [])
    assert.deepEqual(t2.log.switched, [])
    assert.equal(t.calls.includes('switchTo') || t2.calls.includes('switchTo'), false)
  })

  test('a CliError while opening a terminal is unreachable; other errors propagate', async () => {
    const t = setup()
    t.failCreate(new CliError('cli_exec_failed', 'cannot reach'))
    const r = await t.service.openTerminal('ssh:A', 'logs', ID, 'web', null, OPTIONS)
    assert.deepEqual(r, { ok: false, problem: { kind: 'unreachable', message: 'cannot reach' } })
    assert.deepEqual(t.log.remembered, [])
    const t2 = setup()
    t2.failCreate(new TypeError('boom'))
    let thrown: unknown = null
    try { await t2.service.openTerminal('ssh:A', 'logs', ID, 'web', null, OPTIONS) } catch (e) { thrown = e }
    assert.equal(thrown instanceof TypeError, true)
  })

  test('opens a local shell through the plugin terminal API', async () => {
    const t = setup()
    const r = await t.service.openTerminal('local', 'shell', ID, 'web', FOCUS, OPTIONS)
    assert.deepEqual(r, { ok: true, value: { opened: true, workspace: 'proj' } }) // ruling I2: the local workspace's name
    assert.equal(t.log.localTerminals.length, 1)
    assert.equal(t.log.localTerminals[0]!.workspaceId, 'ws1')
    assert.equal(t.log.localTerminals[0]!.title, 'shell: web')
    assert.equal(t.log.localTerminals[0]!.command.includes(`'${ID}'`) || t.log.localTerminals[0]!.command.includes(ID), true)
    assert.equal(t.log.localTerminals[0]!.command.startsWith('docker exec -it'), true)
    assert.equal(t.calls.includes('createTerminal'), false)
  })

  test('a local terminal without a workspace id is no-workspace', async () => {
    const t = setup({ anchor: { path: '/w' } })
    const r = await t.service.openTerminal('local', 'logs', ID, 'web', null, OPTIONS)
    assert.equal(!r.ok && r.problem.kind, 'no-workspace')
    assert.deepEqual(t.calls, [])
  })

  test('sanitizes the container name in terminal titles', () => {
    assert.equal(terminalTitle('logs', 'web\u001b[31m'), 'logs: web[31m')
    assert.equal(terminalTitle('shell', 'x'.repeat(50)), 'shell: ' + 'x'.repeat(40) + '…')
  })
})
