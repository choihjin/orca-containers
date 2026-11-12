import { assert, describe, test } from 'orca/testing'
import type { ComposeAction, ContainerAction, FocusContext, HostId, HostInfo, HostStatus, Problem, ResourceKind, Result } from './protocol'
import { createHosts, type Anchor, type Hosts, type NoAnchor } from './hosts'
import { createLocalRunner, type LocalRunner } from './local/runner'
import { kernelKey, type KeyValueStore, type SshRunner } from './remote/ssh'
import { CliError, type CallOptions, type OrcaCli } from './remote/orca-cli'
import { FakeCli } from './remote/fake-cli'
import { composeCommand, composeLabelsCommand, composeUpArgv, pullArgv, terminalArgv, type ComposeTarget, type DockerCommand } from './docker/commands'
import { shellCommand } from './platform'
import { macTerminalArgv } from './remote/script'
import type { CommandResult } from './docker/parse'
import { createService, terminalTitle } from './service'

const ID = 'a'.repeat(12)
const OPTIONS = { deadline: 1_000 }
const FOCUS: FocusContext = { displayName: 'main', branch: 'main', terminalIds: [] }

// One member container of Compose project `shop`, and the labels docker inspect gives for it.
const MEMBER = 'c'.repeat(12)
const SHOP: ComposeTarget = { project: 'shop', dir: '/srv/shop', files: ['/srv/shop/compose.yml', '/srv/shop/compose.gpu.yml'] }
const labelsLine = (o: Record<string, unknown> = {}): string => JSON.stringify({
  'com.docker.compose.project': 'shop', 'com.docker.compose.project.working_dir': SHOP.dir,
  'com.docker.compose.project.config_files': SHOP.files.join(','), 'com.docker.compose.service': 'web', ...o,
})
const LABELS_OK: CommandResult = { name: 'labels', code: 0, lines: [labelsLine()] }
const COMPOSE_OK: CommandResult = { name: 'compose', code: 0, lines: [' Container shop-web-1  Stopped'] }
// Answers each command of a run by its name.
const byName = (answers: Record<string, CommandResult>) => (commands: readonly DockerCommand[]): CommandResult[] =>
  commands.flatMap((c) => (answers[c.name] ? [answers[c.name]!] : []))

const versionLine = JSON.stringify({ Server: { Version: '27.0.1' } })
const okResults = (): CommandResult[] => [
  { name: 'version', code: 0, lines: [versionLine] },
  { name: 'ps', code: 0, lines: [] },
  { name: 'images', code: 0, lines: [] },
  { name: 'volumes', code: 0, lines: [] },
  { name: 'networks', code: 0, lines: [] },
]

// The kernel the last ssh run stored for host A: Linux unless a test says otherwise (null: none stored yet).
function setup(opts: { status?: HostStatus; anchor?: Anchor | NoAnchor; kernel?: string | null } = {}) {
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
  // A fixed answer, or one built from the commands of each run.
  let localResults: CommandResult[] | ((commands: readonly DockerCommand[]) => CommandResult[]) = okResults()
  let sshResult: Result<CommandResult[]> | ((commands: readonly DockerCommand[]) => Result<CommandResult[]>) = { ok: true, value: okResults() }
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
  let checkKernel: string | null = null
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
    async run(commands, options) {
      calls.push('local.run'); log.order.push('local.run'); log.localRuns.push({ commands, options })
      return typeof localResults === 'function' ? localResults(commands) : localResults
    },
  }
  const ssh: SshRunner = {
    async run(env, commands, options) {
      calls.push('ssh.run'); log.order.push('ssh.run'); log.sshRuns.push({ env, commands, options })
      // The real runner stores the kernel on every run that reaches READY.
      if (checkKernel !== null) stored.set(kernelKey(env), checkKernel)
      return typeof sshResult === 'function' ? sshResult(commands) : sshResult
    },
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
    setLocal(r: CommandResult[] | ((commands: readonly DockerCommand[]) => CommandResult[])) { localResults = r },
    setSsh(r: Result<CommandResult[]> | ((commands: readonly DockerCommand[]) => Result<CommandResult[]>)) { sshResult = r },
    failCreate(e: Error) { createError = e },
    failSwitch(e: Error) { switchError = e },
    failStorageRead() { storageFails = true },
    setCheckKernel(k: string) { checkKernel = k },
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
    remove: [{ name: 'remove', code: 0, lines: ['pgdata'] }], labels: [LABELS_OK], compose: [COMPOSE_OK],
  }
  const ssh: SshRunner = {
    async run(env, commands) {
      const names = commands.map((c) => c.name)
      runs.push({ env, names })
      const single = ['action', 'logs', 'remove', 'labels', 'compose'].find((name) => names.includes(name as DockerCommand['name']))
      return { ok: true, value: answers[single ?? 'snapshot']! }
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

  test('an unsupported host answers unsupported without running anything', async () => {
    const t = setup({ status: 'unsupported' })
    const unsupported = { ok: false, problem: { kind: 'unsupported', message: 'This host is not supported.' } }
    assert.deepEqual(await t.service.snapshot('ssh:A', OPTIONS), unsupported)
    assert.deepEqual(await t.service.action('local', 'start', ID, OPTIONS), unsupported)
    assert.deepEqual(await t.service.logs('ssh:A', ID, OPTIONS), unsupported)
    assert.deepEqual(await t.service.openTerminal('ssh:A', 'logs', ID, 'web', null, OPTIONS), unsupported)
    assert.deepEqual(t.calls, [])
    assert.deepEqual(t.log.anchors, [])
  })

  // Ruling R1: local Docker needs no workspace, so a local snapshot or action never looks one up (on this Mac that
  // costs an Orca CLI terminal list); a local Logs/Shell does. Over ssh only Logs/Shell terminals need one.
  test('only a terminal looks up a workspace: no lookup for a snapshot, action or logs on either host', async () => {
    const t = setup({ anchor: { missing: 'no-workspace' } })
    assert.equal((await t.service.snapshot('local', OPTIONS)).ok, true)
    t.setLocal([{ name: 'action', code: 0, lines: [ID] }])
    assert.deepEqual(await t.service.action('local', 'start', ID, OPTIONS), { ok: true, value: { done: true } })
    assert.deepEqual(t.log.anchors, [])
    assert.equal(t.log.localRuns.length, 2)
    const opened = await t.service.openTerminal('local', 'logs', ID, 'web', FOCUS, OPTIONS)
    assert.equal(!opened.ok && opened.problem.kind, 'no-workspace')
    assert.deepEqual(t.log.anchors, [{ hostId: 'local', focus: FOCUS }])
    const ssh = setup({ anchor: { missing: 'no-workspace' } })
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

  test('a ready SSH host without an anchor still lists over ssh but opens no terminal, and says why', async () => {
    const messages = { unreachable: 'Orca could not reach this host.', 'no-workspace': 'This host has no workspace.' }
    for (const missing of ['unreachable', 'no-workspace'] as const) {
      const t = setup({ anchor: { missing }, kernel: null })
      assert.equal((await t.service.snapshot('ssh:A', OPTIONS)).ok, true)
      const r = await t.service.openTerminal('ssh:A', 'logs', ID, 'web', null, OPTIONS)
      assert.deepEqual(r, { ok: false, problem: { kind: missing, message: messages[missing] } })
      assert.deepEqual(t.log.order, ['ssh.run', 'anchor'])
      assert.deepEqual(t.log.created, [])
    }
  })

  // A missing local anchor is no-workspace, whatever reason hosts gives.
  test('a local terminal without an anchor is no-workspace', async () => {
    for (const missing of ['unreachable', 'no-workspace'] as const) {
      const t = setup({ anchor: { missing } })
      const r = await t.service.openTerminal('local', 'shell', ID, 'web', FOCUS, OPTIONS)
      assert.deepEqual(r, { ok: false, problem: { kind: 'no-workspace', message: 'This host has no workspace.' } })
      assert.deepEqual(t.calls, [])
    }
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
    const down = setup({ status: 'unsupported' })
    const r = await down.service.logs('ssh:A', ID, OPTIONS)
    assert.equal(!r.ok && r.problem.kind, 'unsupported')
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
    assert.deepEqual(t.log.order, ['anchor', `storage.get ${kernelKey('A')}`, 'ssh.run', `storage.get ${kernelKey('A')}`, 'createTerminal', 'remember', 'switchTo'])
  })

  test('a failing kernel check answers its own problem and opens no terminal', async () => {
    const problems = [
      { kind: 'unsupported' as const, message: 'Remote kernel FreeBSD is not supported' },
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

  test('a stored Linux kernel types the plain docker command', async () => {
    const t = setup({ kernel: 'Linux' })
    assert.equal((await t.service.openTerminal('ssh:A', 'shell', ID, 'web', null, OPTIONS)).ok, true)
    assert.equal(t.log.created[0]?.command, shellCommand(terminalArgv('shell', ID)))
  })

  // A Mac host's terminal shell may not be a login shell, so /usr/local/bin may be missing from its PATH: the command
  // looks docker up the way the ssh script does.
  test('a stored Darwin kernel opens the SSH terminal without an ssh run, with the macOS docker lookup', async () => {
    const t = setup({ kernel: 'Darwin' })
    assert.equal((await t.service.openTerminal('ssh:A', 'shell', ID, 'web', null, OPTIONS)).ok, true)
    assert.equal((await t.service.pullTerminal('ssh:A', 'nginx:1.27', null, OPTIONS)).ok, true)
    assert.deepEqual(t.log.sshRuns, [])
    assert.deepEqual(t.log.created.map((c) => c.command), [
      shellCommand(macTerminalArgv(terminalArgv('shell', ID))),
      shellCommand(macTerminalArgv(pullArgv('nginx:1.27'))),
    ])
  })

  test('a kernel check that finds Darwin also types the macOS docker lookup', async () => {
    const t = setup({ kernel: null })
    t.setCheckKernel('Darwin')
    assert.equal((await t.service.openTerminal('ssh:A', 'logs', ID, 'web', null, OPTIONS)).ok, true)
    assert.equal(t.log.created[0]?.command, shellCommand(macTerminalArgv(terminalArgv('logs', ID))))
  })

  // The lookup is plain POSIX and still prefers docker on PATH, so a host whose kernel cannot be read back gets it too.
  test('a kernel check whose result cannot be read back types the macOS docker lookup', async () => {
    const t = setup({ kernel: null })
    t.failStorageRead()
    assert.equal((await t.service.openTerminal('ssh:A', 'shell', ID, 'web', null, OPTIONS)).ok, true)
    assert.equal(t.log.created[0]?.command, shellCommand(macTerminalArgv(terminalArgv('shell', ID))))
  })

  test('a local terminal on this Mac keeps the plain docker command', async () => {
    const t = setup({ kernel: 'Darwin' })
    assert.equal((await t.service.openTerminal('local', 'shell', ID, 'web', FOCUS, OPTIONS)).ok, true)
    assert.equal(t.log.localTerminals[0]?.command, shellCommand(terminalArgv('shell', ID)))
  })

  test('a stored unsupported kernel answers unsupported at once: no ssh run, no terminal', async () => {
    const t = setup({ kernel: 'FreeBSD' })
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
    const noAnchor = setup({ kernel: null, anchor: { missing: 'no-workspace' } })
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

const DIGEST = `sha256:${'0123456789abcdef'.repeat(4)}`
const NET = 'b'.repeat(64)
const DAEMON = 'Error response from daemon: '
// A few of the values the command tests refuse: options, spaces, shell syntax, a newline, "..", a second "@".
const BAD_REFS = ['-f', '--force', 'a b', 'a;b', '$(id)', 'a\nb', '../x', `a@b@${DIGEST}`, '']

describe('service: remove an image, volume or network', () => {
  test('a local remove runs the fixed command and succeeds on code 0, with no anchor lookup', async () => {
    const t = setup({ anchor: { missing: 'no-workspace' } })
    t.setLocal([{ name: 'remove', code: 0, lines: ['Untagged: nginx:1.27'] }])
    assert.deepEqual(await t.service.removeResource('local', 'image', 'nginx:1.27', OPTIONS), { ok: true, value: { done: true } })
    assert.deepEqual(t.log.localRuns, [{ commands: [{ name: 'remove', argv: ['image', 'rm', 'nginx:1.27'] }], options: OPTIONS }])
    assert.deepEqual(t.log.anchors, [])
    assert.deepEqual(t.log.sshRuns, [])
  })

  test('an SSH remove goes to the ssh runner for each kind, with no anchor, no terminal and nothing remembered', async () => {
    const cases = [
      { kind: 'image' as const, ref: DIGEST, argv: ['image', 'rm', DIGEST] },
      { kind: 'volume' as const, ref: 'pgdata', argv: ['volume', 'rm', 'pgdata'] },
      { kind: 'network' as const, ref: NET, argv: ['network', 'rm', NET] },
    ]
    for (const { kind, ref, argv } of cases) {
      const t = setup({ anchor: { path: '/home/me/main' } })
      t.setSsh({ ok: true, value: [{ name: 'remove', code: 0, lines: [ref] }] })
      assert.deepEqual(await t.service.removeResource('ssh:A', kind, ref, OPTIONS), { ok: true, value: { done: true } }, kind)
      assert.deepEqual(t.log.sshRuns, [{ env: 'A', commands: [{ name: 'remove', argv }], options: OPTIONS }], kind)
      assert.deepEqual(t.log.order, ['ssh.run'], kind)
      assert.deepEqual(t.log.remembered, [])
    }
    const bare = noTerminalSetup()
    assert.deepEqual(await bare.service.removeResource('ssh:A', 'volume', 'pgdata', OPTIONS), { ok: true, value: { done: true } })
    assert.deepEqual(bare.runs, [{ env: 'A', names: ['remove'] }])
    assert.deepEqual(bare.used, [])
  })

  test('a remove the daemon refuses is classified: its message for an item in use, the usual kinds otherwise', async () => {
    const inUse = 'conflict: unable to remove repository reference "nginx:1.27" (must force) - container 0123456789ab is using its referenced image 5f1e6a2b'
    const t = setup()
    t.setLocal([{ name: 'remove', code: 1, lines: [`${DAEMON}${inUse}`] }])
    assert.deepEqual(await t.service.removeResource('local', 'image', 'nginx:1.27', OPTIONS), { ok: false, problem: { kind: 'failed', message: inUse } })
    const volume = 'remove pgdata: volume is in use - [0123456789ab]'
    const t2 = setup()
    t2.setSsh({ ok: true, value: [{ name: 'remove', code: 1, lines: [`${DAEMON}${volume}`] }] })
    assert.deepEqual(await t2.service.removeResource('ssh:A', 'volume', 'pgdata', OPTIONS), { ok: false, problem: { kind: 'failed', message: volume } })
    const t3 = setup()
    t3.setLocal([{ name: 'remove', code: 1, lines: ['permission denied while trying to connect to the Docker daemon socket'] }])
    const denied = await t3.service.removeResource('local', 'network', NET, OPTIONS)
    assert.equal(!denied.ok && denied.problem.kind, 'permission-denied')
    const t4 = setup()
    t4.setLocal([{ name: 'remove', code: 124, lines: [] }])
    const slow = await t4.service.removeResource('local', 'volume', 'pgdata', OPTIONS)
    assert.equal(!slow.ok && slow.problem.kind, 'timeout')
    // No result for the command at all is a failure, not a success.
    const t5 = setup()
    t5.setLocal([])
    const none = await t5.service.removeResource('local', 'volume', 'pgdata', OPTIONS)
    assert.deepEqual(none, { ok: false, problem: { kind: 'failed', message: 'remove produced no result' } })
  })

  test('a network with endpoints, a predefined network and an image in several repositories are failed with the daemon\'s line', async () => {
    const cases = [
      { kind: 'network' as const, ref: NET, line: `error while removing network: network ml_default id ${NET} has active endpoints` },
      { kind: 'network' as const, ref: NET, line: 'bridge is a pre-defined network and cannot be removed' },
      { kind: 'image' as const, ref: '5f1e6a2b0c3d', line: 'conflict: unable to delete 5f1e6a2b0c3d (must be forced) - image is referenced in multiple repositories' },
    ]
    for (const { kind, ref, line } of cases) {
      for (const hostId of ['local', 'ssh:A'] as const) {
        const t = setup()
        const answer = [{ name: 'remove', code: 1, lines: [`${DAEMON}${line}`] }]
        t.setLocal(answer)
        t.setSsh({ ok: true, value: answer })
        assert.deepEqual(await t.service.removeResource(hostId, kind, ref, OPTIONS), { ok: false, problem: { kind: 'failed', message: line } }, `${hostId} ${line}`)
      }
    }
  })

  test('ssh problems pass through a remove', async () => {
    const t = setup()
    const problem = { kind: 'ssh-failed' as const, message: 'No ssh host named "A" on this Mac.' }
    t.setSsh({ ok: false, problem })
    assert.deepEqual(await t.service.removeResource('ssh:A', 'image', 'nginx', OPTIONS), { ok: false, problem })
  })

  test('an invalid ref or kind is refused before any runner, on either host', async () => {
    const t = setup()
    for (const hostId of ['local', 'ssh:A'] as const) {
      for (const kind of ['image', 'volume', 'network'] as const) {
        for (const ref of BAD_REFS) {
          const r = await t.service.removeResource(hostId, kind, ref, OPTIONS)
          assert.equal(!r.ok && r.problem.kind, 'invalid', `${hostId} ${kind} ${JSON.stringify(ref)}`)
        }
      }
      const kind = await t.service.removeResource(hostId, 'container' as ResourceKind, ID, OPTIONS)
      assert.equal(!kind.ok && kind.problem.kind, 'invalid')
      // A network name is not its id.
      const name = await t.service.removeResource(hostId, 'network', 'bridge', OPTIONS)
      assert.equal(!name.ok && name.problem.kind, 'invalid')
    }
    assert.deepEqual(t.calls, [])
  })

  test('a remove on a host that is not ready, or not known, runs nothing', async () => {
    const t = setup({ status: 'unsupported' })
    assert.deepEqual(await t.service.removeResource('ssh:A', 'image', 'nginx', OPTIONS),
      { ok: false, problem: { kind: 'unsupported', message: 'This host is not supported.' } })
    assert.deepEqual(await t.service.removeResource('local', 'volume', 'pgdata', OPTIONS),
      { ok: false, problem: { kind: 'unsupported', message: 'This host is not supported.' } })
    const unknown = await setup().service.removeResource('ssh:nope', 'image', 'nginx', OPTIONS)
    assert.equal(!unknown.ok && unknown.problem.kind, 'invalid')
    assert.deepEqual(t.calls, [])
  })
})

describe('service: pull an image in a terminal', () => {
  test('a local pull opens a plugin terminal with docker pull and the title, and switches to it', async () => {
    const t = setup()
    const r = await t.service.pullTerminal('local', 'nginx:latest', FOCUS, OPTIONS)
    assert.deepEqual(r, { ok: true, value: { opened: true, workspace: 'proj' } })
    assert.deepEqual(t.log.localTerminals, [{ workspaceId: 'ws1', title: 'pull: nginx:latest', command: 'docker pull nginx:latest' }])
    assert.deepEqual(t.log.anchors, [{ hostId: 'local', focus: FOCUS }])
    assert.deepEqual(t.log.switched, [{ handle: 'local_term' }])
    assert.deepEqual(t.log.localRuns, [])
    assert.equal(t.calls.includes('createTerminal'), false)
  })

  test('an SSH pull opens a focused Orca terminal on the anchor, remembers it and switches to it, with no docker run', async () => {
    const t = setup({ anchor: { path: '/home/me/main' } })
    const r = await t.service.pullTerminal('ssh:A', 'ghcr.io/org/app:1.2', null, OPTIONS)
    assert.deepEqual(r, { ok: true, value: { opened: true, workspace: 'main' } })
    assert.deepEqual(t.log.created, [{
      environment: 'A', worktreePath: '/home/me/main', title: 'pull: ghcr.io/org/app:1.2', command: 'docker pull ghcr.io/org/app:1.2', focus: true,
    }])
    assert.deepEqual(t.log.remembered, [{ hostId: 'ssh:A', path: '/home/me/main' }])
    assert.deepEqual(t.log.switched, [{ environment: 'A', handle: 'term_1' }])
    assert.deepEqual(t.log.order, ['anchor', `storage.get ${kernelKey('A')}`, 'createTerminal', 'remember', 'switchTo'])
    assert.deepEqual(t.log.sshRuns, [])
  })

  test('a pull by digest keeps the whole reference in the command', async () => {
    const t = setup()
    await t.service.pullTerminal('local', `name@${DIGEST}`, FOCUS, OPTIONS)
    assert.equal(t.log.localTerminals[0]!.command, `docker pull name@${DIGEST}`)
  })

  test('a pull follows the Shell rules: kernel check, anchor, host status', async () => {
    const unknownKernel = setup({ kernel: null, anchor: { path: '/home/me/main' } })
    assert.equal((await unknownKernel.service.pullTerminal('ssh:A', 'nginx', null, OPTIONS)).ok, true)
    assert.deepEqual(unknownKernel.log.sshRuns, [{ env: 'A', commands: [], options: OPTIONS }])
    assert.deepEqual(unknownKernel.log.order, ['anchor', `storage.get ${kernelKey('A')}`, 'ssh.run', `storage.get ${kernelKey('A')}`, 'createTerminal', 'remember', 'switchTo'])
    const unsupported = { ok: false, problem: { kind: 'unsupported', message: 'This host is not supported.' } }
    const other = setup({ kernel: 'FreeBSD' })
    assert.deepEqual(await other.service.pullTerminal('ssh:A', 'nginx', null, OPTIONS), unsupported)
    const down = setup({ status: 'unsupported' })
    assert.deepEqual(await down.service.pullTerminal('local', 'nginx', FOCUS, OPTIONS), unsupported)
    assert.deepEqual(await down.service.pullTerminal('ssh:A', 'nginx', null, OPTIONS), unsupported)
    for (const missing of ['unreachable', 'no-workspace'] as const) {
      const t = setup({ anchor: { missing } })
      assert.deepEqual(await t.service.pullTerminal('ssh:A', 'nginx', null, OPTIONS),
        { ok: false, problem: { kind: missing, message: missing === 'unreachable' ? 'Orca could not reach this host.' : 'This host has no workspace.' } })
      assert.deepEqual(await t.service.pullTerminal('local', 'nginx', FOCUS, OPTIONS),
        { ok: false, problem: { kind: 'no-workspace', message: 'This host has no workspace.' } })
      assert.deepEqual(t.calls, [])
    }
    for (const t of [other, down]) {
      assert.deepEqual([...t.log.created, ...t.log.localTerminals, ...t.log.sshRuns], [])
    }
    const cliDown = setup()
    cliDown.failCreate(new CliError('cli_exec_failed', 'cannot reach'))
    assert.deepEqual(await cliDown.service.pullTerminal('ssh:A', 'nginx', null, OPTIONS), { ok: false, problem: { kind: 'unreachable', message: 'cannot reach' } })
    assert.deepEqual(cliDown.log.switched, [])
  })

  test('an invalid ref opens no terminal and runs nothing, on either host', async () => {
    for (const ref of [...BAD_REFS, 'nginx..latest', 'nginx@latest', `name@${DIGEST.slice(0, 20)}`]) {
      const t = setup({ kernel: null })
      for (const hostId of ['local', 'ssh:A'] as const) {
        const r = await t.service.pullTerminal(hostId, ref, FOCUS, OPTIONS)
        assert.equal(!r.ok && r.problem.kind, 'invalid', `${hostId} ${JSON.stringify(ref)}`)
      }
      assert.deepEqual(t.calls, [], JSON.stringify(ref))
      assert.deepEqual(t.log.remembered, [])
    }
  })

  test('the pull title is the reference, cut to 40 characters', async () => {
    assert.equal(terminalTitle('pull', 'nginx:latest'), 'pull: nginx:latest')
    const long = `registry.example.com/${'a'.repeat(40)}:1`
    assert.equal(terminalTitle('pull', long), `pull: ${long.slice(0, 40)}…`)
    const t = setup()
    await t.service.pullTerminal('local', long, FOCUS, OPTIONS)
    assert.equal(t.log.localTerminals[0]!.title, `pull: ${long.slice(0, 40)}…`)
    assert.equal(t.log.localTerminals[0]!.command, `docker pull ${long}`)
  })
})

const NOT_SHOP = { ok: false, problem: { kind: 'failed', message: 'This container is not part of Compose project shop' } }
const NO_FILES = { ok: false, problem: { kind: 'failed', message: "Compose did not record where this project's files are" } }
const COMPOSE_ACTIONS: readonly ComposeAction[] = ['start', 'stop', 'restart', 'down']
const BAD_PROJECTS = ['', 'Shop', '-p', '--volumes', 'a b', 'a;b', '$(id)', 'a\nb', '_shop', 'a'.repeat(64)]
const BAD_MEMBERS = ['', 'web', '-f', 'x; reboot', 'C'.repeat(12), 'c'.repeat(11), 'c'.repeat(65)]

describe('service: Compose project actions', () => {
  test('a local action looks up the member\'s labels, then runs one compose command for the whole project, with no anchor lookup', async () => {
    for (const action of COMPOSE_ACTIONS) {
      const t = setup({ anchor: { missing: 'no-workspace' } })
      t.setLocal(byName({ labels: LABELS_OK, compose: COMPOSE_OK }))
      assert.deepEqual(await t.service.composeAction('local', 'shop', MEMBER, action, OPTIONS), { ok: true, value: { done: true } }, action)
      assert.deepEqual(t.log.localRuns, [
        { commands: [composeLabelsCommand(MEMBER)], options: OPTIONS },
        { commands: [composeCommand(SHOP, action)], options: OPTIONS },
      ], action)
      assert.deepEqual(t.log.order, ['local.run', 'local.run'], action)
      assert.deepEqual([...t.log.anchors, ...t.log.sshRuns, ...t.log.created, ...t.log.localTerminals], [], action)
    }
  })

  test('an SSH action is two ssh runs, labels then compose, with no anchor, terminal, storage or memory', async () => {
    for (const action of COMPOSE_ACTIONS) {
      const t = setup({ anchor: { path: '/home/me/main' } })
      t.setSsh((commands) => ({ ok: true, value: byName({ labels: LABELS_OK, compose: COMPOSE_OK })(commands) }))
      assert.deepEqual(await t.service.composeAction('ssh:A', 'shop', MEMBER, action, OPTIONS), { ok: true, value: { done: true } }, action)
      assert.deepEqual(t.log.sshRuns, [
        { env: 'A', commands: [composeLabelsCommand(MEMBER)], options: OPTIONS },
        { env: 'A', commands: [composeCommand(SHOP, action)], options: OPTIONS },
      ], action)
      assert.deepEqual(t.log.order, ['ssh.run', 'ssh.run'], action)
      assert.deepEqual(t.log.remembered, [])
    }
    const bare = noTerminalSetup()
    assert.deepEqual(await bare.service.composeAction('ssh:A', 'shop', MEMBER, 'down', OPTIONS), { ok: true, value: { done: true } })
    assert.deepEqual(bare.runs, [{ env: 'A', names: ['labels'] }, { env: 'A', names: ['compose'] }])
    assert.deepEqual(bare.used, [])
  })

  test('down is compose down: volumes and images are kept', async () => {
    const t = setup()
    t.setLocal(byName({ labels: LABELS_OK, compose: COMPOSE_OK }))
    await t.service.composeAction('local', 'shop', MEMBER, 'down', OPTIONS)
    const argv = t.log.localRuns[1]!.commands[0]!.argv
    assert.deepEqual(argv.slice(-1), ['down'])
    for (const word of ['-v', '--volumes', '--rmi']) assert.equal(argv.includes(word), false, word)
  })

  test('a labels failure stops before compose', async () => {
    const cases: [string, CommandResult[] | Result<CommandResult[]>, unknown][] = [
      ['no such container', [{ name: 'labels', code: 1, lines: ['Error: No such object: cccccccccccc'] }],
        { ok: false, problem: { kind: 'failed', message: 'Error: No such object: cccccccccccc' } }],
      ['daemon down', [{ name: 'labels', code: 1, lines: ['Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?'] }],
        { ok: false, problem: { kind: 'daemon-down', message: 'The Docker daemon is not running' } }],
      ['no result', [], { ok: false, problem: { kind: 'failed', message: 'labels produced no result' } }],
      ['another project', [{ name: 'labels', code: 0, lines: [labelsLine({ 'com.docker.compose.project': 'other' })] }], NOT_SHOP],
      ['no labels', [{ name: 'labels', code: 0, lines: ['null'] }], NOT_SHOP],
      ['a relative file', [{ name: 'labels', code: 0, lines: [labelsLine({ 'com.docker.compose.project.config_files': 'compose.yml' })] }], NO_FILES],
      ['17 files', [{ name: 'labels', code: 0, lines: [labelsLine({
        'com.docker.compose.project.config_files': Array.from({ length: 17 }, (_, i) => `/srv/${i}.yml`).join(','),
      })] }], NO_FILES],
      ['a dir with a newline', [{ name: 'labels', code: 0, lines: [labelsLine({ 'com.docker.compose.project.working_dir': '/srv\n/shop' })] }], NO_FILES],
    ]
    for (const [label, answer, expected] of cases) {
      const results = answer as CommandResult[]
      const local = setup()
      local.setLocal(results)
      assert.deepEqual(await local.service.composeAction('local', 'shop', MEMBER, 'stop', OPTIONS), expected, `local ${label}`)
      assert.deepEqual(local.log.localRuns.map((r) => r.commands.map((c) => c.name)), [['labels']], `local ${label}`)
      const remote = setup()
      remote.setSsh({ ok: true, value: results })
      assert.deepEqual(await remote.service.composeAction('ssh:A', 'shop', MEMBER, 'stop', OPTIONS), expected, `ssh ${label}`)
      assert.deepEqual(remote.log.sshRuns.map((r) => r.commands.map((c) => c.name)), [['labels']], `ssh ${label}`)
    }
    const problem = { kind: 'ssh-failed' as const, message: 'No ssh host named "A" on this Mac.' }
    const t = setup()
    t.setSsh({ ok: false, problem })
    assert.deepEqual(await t.service.composeAction('ssh:A', 'shop', MEMBER, 'restart', OPTIONS), { ok: false, problem })
    assert.equal(t.log.sshRuns.length, 1)
  })

  test('a compose failure is classified; a compose run cut off over ssh stays unknown-result', async () => {
    const answer = (compose: CommandResult | undefined) => byName({ labels: LABELS_OK, ...(compose ? { compose } : {}) })
    const t = setup()
    t.setLocal(answer({ name: 'compose', code: 1, lines: ['Error response from daemon: Cannot restart container shop-web-1: boom'] }))
    assert.deepEqual(await t.service.composeAction('local', 'shop', MEMBER, 'restart', OPTIONS),
      { ok: false, problem: { kind: 'failed', message: 'Cannot restart container shop-web-1: boom' } })
    const none = setup()
    none.setLocal(answer(undefined))
    assert.deepEqual(await none.service.composeAction('local', 'shop', MEMBER, 'stop', OPTIONS),
      { ok: false, problem: { kind: 'failed', message: 'compose produced no result' } })
    const unknown = { kind: 'unknown-result' as const, message: 'sent; result unknown' }
    const cut = setup()
    cut.setSsh((commands) => (commands.some((c) => c.name === 'compose') ? { ok: false, problem: unknown } : { ok: true, value: [LABELS_OK] }))
    assert.deepEqual(await cut.service.composeAction('ssh:A', 'shop', MEMBER, 'stop', OPTIONS), { ok: false, problem: unknown })
  })

  // A compose stopped by its own 55 s limit may have changed some of the project's containers and not others.
  test('a compose that started and hit its 55 s limit (code 124) is unknown-result; one never started is a timeout', async () => {
    const UNKNOWN = { ok: false, problem: { kind: 'unknown-result', message: 'sent; result unknown' } }
    const TIMEOUT = { ok: false, problem: { kind: 'timeout', message: 'The command timed out' } }
    for (const action of COMPOSE_ACTIONS) {
      const local = setup()
      local.setLocal(byName({ labels: LABELS_OK, compose: { name: 'compose', code: 124, lines: [' Container shop-web-1  Stopping'] } }))
      assert.deepEqual(await local.service.composeAction('local', 'shop', MEMBER, action, OPTIONS), UNKNOWN, `local ${action}`)
      // ssh: `timeout 55` ended it on the host and the script reported rc 124.
      const remote = setup()
      remote.setSsh((commands) => ({ ok: true, value: byName({ labels: LABELS_OK, compose: { name: 'compose', code: 124, lines: [] } })(commands) }))
      assert.deepEqual(await remote.service.composeAction('ssh:A', 'shop', MEMBER, action, OPTIONS), UNKNOWN, `ssh ${action}`)
      const skipped = setup()
      skipped.setLocal(byName({ labels: LABELS_OK, compose: { name: 'compose', code: 124, lines: [], skipped: true } }))
      assert.deepEqual(await skipped.service.composeAction('local', 'shop', MEMBER, action, OPTIONS), TIMEOUT, `skipped ${action}`)
    }
    // The labels lookup changes nothing: its 124 stays a timeout.
    const labels = setup()
    labels.setLocal([{ name: 'labels', code: 124, lines: [] }])
    assert.deepEqual(await labels.service.composeAction('local', 'shop', MEMBER, 'stop', OPTIONS), TIMEOUT)
  })

  // Through the real local runner, with a fake exec: the runner's own marks decide.
  test('on this Mac, a compose cut off by its exec limit is unknown-result; one left no time before exec is a timeout', async () => {
    const realLocal = (reply: (args: string[]) => { code: number; stdout: string; stderr: string; timedOut: boolean }, clock: { now: number }) => {
      const execs: { args: string[]; timeoutMs: number }[] = []
      const local = createLocalRunner({
        exec: async (_file, args, o) => { execs.push({ args, timeoutMs: o.timeoutMs }); return reply(args) },
        exists: (path) => path === '/usr/bin/docker', loginShellWhich: async () => null, now: () => clock.now,
      })
      const hosts = {
        localHost: (): HostInfo => ({ id: 'local', label: 'This Mac', kind: 'local', status: 'ready' }),
      } as unknown as Hosts
      const unused = async () => { throw new Error('must not be called') }
      const service = createService({
        hosts, local, ssh: { run: unused }, cli: {} as OrcaCli, storage: { get: unused }, now: () => clock.now, openLocalTerminal: unused,
      })
      return { service, execs }
    }
    const labelsOut = { code: 0, stdout: `${labelsLine()}\n`, stderr: '', timedOut: false }
    const cut = realLocal((args) => (args[0] === 'inspect' ? labelsOut : { code: 1, stdout: '', stderr: ' Container shop-web-1  Stopping\n', timedOut: true }), { now: 0 })
    assert.deepEqual(await cut.service.composeAction('local', 'shop', MEMBER, 'stop', { deadline: 100_000 }),
      { ok: false, problem: { kind: 'unknown-result', message: 'sent; result unknown' } })
    assert.deepEqual(cut.execs.map((e) => [e.args[0], e.timeoutMs]), [['inspect', 20_000], ['compose', 55_000]])
    const clock = { now: 0 }
    const late = realLocal(() => { clock.now = 100_000; return labelsOut }, clock)
    assert.deepEqual(await late.service.composeAction('local', 'shop', MEMBER, 'stop', { deadline: 100_000 }),
      { ok: false, problem: { kind: 'timeout', message: 'The command timed out' } })
    assert.deepEqual(late.execs.map((e) => e.args[0]), ['inspect'])
  })

  // Compose prints progress first and its error last.
  test('a failed compose shows its last meaningful output line; the kinds are decided as before', async () => {
    const progress = [' Container shop-db-1  Starting', ' Container shop-db-1  Started', ' Container shop-web-1  Starting']
    const error = 'Error response from daemon: driver failed programming external connectivity on endpoint shop-web-1: port is already allocated'
    const compose: CommandResult = { name: 'compose', code: 1, lines: [...progress, error, ''] }
    const local = setup()
    local.setLocal(byName({ labels: LABELS_OK, compose }))
    const expected = { ok: false, problem: { kind: 'failed', message: 'driver failed programming external connectivity on endpoint shop-web-1: port is already allocated' } }
    assert.deepEqual(await local.service.composeAction('local', 'shop', MEMBER, 'start', OPTIONS), expected)
    const remote = setup()
    remote.setSsh((commands) => ({ ok: true, value: byName({ labels: LABELS_OK, compose })(commands) }))
    assert.deepEqual(await remote.service.composeAction('ssh:A', 'shop', MEMBER, 'start', OPTIONS), expected)
    const denied = setup()
    denied.setLocal(byName({ labels: LABELS_OK, compose: { name: 'compose', code: 1, lines: ['permission denied while trying to connect to the Docker daemon socket', 'more'] } }))
    const r = await denied.service.composeAction('local', 'shop', MEMBER, 'stop', OPTIONS)
    assert.equal(!r.ok && r.problem.kind, 'permission-denied')
    // The labels lookup keeps the first line.
    const labels = setup()
    labels.setLocal([{ name: 'labels', code: 1, lines: ['Error: No such object: cccccccccccc', 'second'] }])
    assert.deepEqual(await labels.service.composeAction('local', 'shop', MEMBER, 'stop', OPTIONS),
      { ok: false, problem: { kind: 'failed', message: 'Error: No such object: cccccccccccc' } })
  })

  // The docker CLI without the compose plugin ends with "See 'docker --help'", which says nothing on its own.
  test('a host without the compose plugin is failed with a clear message, in both CLI wordings', async () => {
    const MISSING = { ok: false, problem: { kind: 'failed', message: 'Docker Compose is not installed on this host (the docker compose plugin is missing).' } }
    const outputs = [
      ["docker: 'compose' is not a docker command.", "See 'docker --help'"],
      ['unknown command "compose" for "docker"', '', "Run 'docker --help' for more information"],
      ['docker: unknown command: docker compose', '', "Run 'docker --help' for more information"],
      ["DOCKER: 'COMPOSE' IS NOT A DOCKER COMMAND.", 'See docker --help'],
      ['Unknown Command "Compose" for "docker"'],
    ]
    for (const lines of outputs) {
      const compose: CommandResult = { name: 'compose', code: 1, lines }
      const local = setup()
      local.setLocal(byName({ labels: LABELS_OK, compose }))
      assert.deepEqual(await local.service.composeAction('local', 'shop', MEMBER, 'stop', OPTIONS), MISSING, `local ${lines[0]}`)
      const remote = setup()
      remote.setSsh((commands) => ({ ok: true, value: byName({ labels: LABELS_OK, compose })(commands) }))
      assert.deepEqual(await remote.service.composeAction('ssh:A', 'shop', MEMBER, 'down', OPTIONS), MISSING, `ssh ${lines[0]}`)
    }
    // Another unknown command or a plain failure is not taken for a missing plugin.
    const other = setup()
    other.setLocal(byName({ labels: LABELS_OK, compose: { name: 'compose', code: 1, lines: ['unknown command "stopp" for "docker compose"'] } }))
    assert.deepEqual(await other.service.composeAction('local', 'shop', MEMBER, 'stop', OPTIONS),
      { ok: false, problem: { kind: 'failed', message: 'unknown command "stopp" for "docker compose"' } })
  })

  test('invalid input causes no run, on either host', async () => {
    const t = setup()
    for (const hostId of ['local', 'ssh:A'] as const) {
      for (const project of BAD_PROJECTS) {
        const r = await t.service.composeAction(hostId, project, MEMBER, 'stop', OPTIONS)
        assert.equal(!r.ok && r.problem.kind, 'invalid', `${hostId} project ${JSON.stringify(project)}`)
      }
      for (const member of BAD_MEMBERS) {
        const r = await t.service.composeAction(hostId, 'shop', member, 'stop', OPTIONS)
        assert.equal(!r.ok && r.problem.kind, 'invalid', `${hostId} member ${JSON.stringify(member)}`)
      }
      for (const action of ['remove', 'up', 'kill', 'down -v', '', 'constructor', '__proto__']) {
        const r = await t.service.composeAction(hostId, 'shop', MEMBER, action as ComposeAction, OPTIONS)
        assert.equal(!r.ok && r.problem.kind, 'invalid', `${hostId} action ${JSON.stringify(action)}`)
      }
    }
    assert.deepEqual(t.calls, [])
  })

  test('a host that is not ready, or not known, runs nothing', async () => {
    const t = setup({ status: 'unsupported' })
    const unsupported = { ok: false, problem: { kind: 'unsupported', message: 'This host is not supported.' } }
    assert.deepEqual(await t.service.composeAction('ssh:A', 'shop', MEMBER, 'stop', OPTIONS), unsupported)
    assert.deepEqual(await t.service.composeAction('local', 'shop', MEMBER, 'stop', OPTIONS), unsupported)
    assert.deepEqual(await t.service.composeUp('ssh:A', 'shop', MEMBER, null, OPTIONS), unsupported)
    assert.deepEqual(await t.service.composeUp('local', 'shop', MEMBER, FOCUS, OPTIONS), unsupported)
    const unknown = setup()
    const r = await unknown.service.composeAction('ssh:nope', 'shop', MEMBER, 'stop', OPTIONS)
    assert.equal(!r.ok && r.problem.kind, 'invalid')
    const up = await unknown.service.composeUp('ssh:nope', 'shop', MEMBER, null, OPTIONS)
    assert.equal(!up.ok && up.problem.kind, 'invalid')
    assert.deepEqual([...t.calls, ...unknown.calls], [])
  })
})

describe('service: Compose up in a terminal', () => {
  test('a local up looks up the labels, then opens a plugin terminal with compose up -d and the title, and switches to it', async () => {
    const t = setup()
    t.setLocal([LABELS_OK])
    const r = await t.service.composeUp('local', 'shop', MEMBER, FOCUS, OPTIONS)
    assert.deepEqual(r, { ok: true, value: { opened: true, workspace: 'proj' } })
    assert.deepEqual(t.log.localRuns, [{ commands: [composeLabelsCommand(MEMBER)], options: OPTIONS }])
    assert.deepEqual(t.log.localTerminals, [{ workspaceId: 'ws1', title: 'compose up: shop', command: shellCommand(composeUpArgv(SHOP)) }])
    assert.equal(t.log.localTerminals[0]!.command,
      'docker compose --project-directory /srv/shop -p shop -f /srv/shop/compose.yml -f /srv/shop/compose.gpu.yml up -d')
    assert.deepEqual(t.log.anchors, [{ hostId: 'local', focus: FOCUS }])
    assert.deepEqual(t.log.switched, [{ handle: 'local_term' }])
    assert.deepEqual(t.log.order, ['anchor', 'local.run', 'switchTo'])
    assert.equal(t.calls.includes('createTerminal'), false)
  })

  test('an SSH up on a Linux host: anchor, kernel, labels, then the plain command in an Orca terminal, remembered and switched to', async () => {
    const t = setup({ anchor: { path: '/home/me/main' } })
    t.setSsh({ ok: true, value: [LABELS_OK] })
    const r = await t.service.composeUp('ssh:A', 'shop', MEMBER, null, OPTIONS)
    assert.deepEqual(r, { ok: true, value: { opened: true, workspace: 'main' } })
    assert.deepEqual(t.log.sshRuns, [{ env: 'A', commands: [composeLabelsCommand(MEMBER)], options: OPTIONS }])
    assert.deepEqual(t.log.created, [{
      environment: 'A', worktreePath: '/home/me/main', title: 'compose up: shop', command: shellCommand(composeUpArgv(SHOP)), focus: true,
    }])
    assert.deepEqual(t.log.remembered, [{ hostId: 'ssh:A', path: '/home/me/main' }])
    assert.deepEqual(t.log.switched, [{ environment: 'A', handle: 'term_1' }])
    assert.deepEqual(t.log.order, ['anchor', `storage.get ${kernelKey('A')}`, 'ssh.run', 'createTerminal', 'remember', 'switchTo'])
  })

  test('an SSH up on a Darwin host types the macOS docker lookup', async () => {
    const t = setup({ kernel: 'Darwin' })
    t.setSsh({ ok: true, value: [LABELS_OK] })
    assert.equal((await t.service.composeUp('ssh:A', 'shop', MEMBER, null, OPTIONS)).ok, true)
    assert.equal(t.log.created[0]?.command, shellCommand(macTerminalArgv(composeUpArgv(SHOP))))
    const checked = setup({ kernel: null })
    checked.setCheckKernel('Darwin')
    checked.setSsh((commands) => ({ ok: true, value: byName({ labels: LABELS_OK })(commands) }))
    assert.equal((await checked.service.composeUp('ssh:A', 'shop', MEMBER, null, OPTIONS)).ok, true)
    assert.deepEqual(checked.log.sshRuns.map((run) => run.commands.map((c) => c.name)), [[], ['labels']])
    assert.equal(checked.log.created[0]?.command, shellCommand(macTerminalArgv(composeUpArgv(SHOP))))
  })

  test('up follows the Shell rules: host status, anchor, kernel check; a stored unsupported kernel runs nothing', async () => {
    const unsupported = { ok: false, problem: { kind: 'unsupported', message: 'This host is not supported.' } }
    const other = setup({ kernel: 'FreeBSD' })
    assert.deepEqual(await other.service.composeUp('ssh:A', 'shop', MEMBER, null, OPTIONS), unsupported)
    assert.deepEqual([...other.log.sshRuns, ...other.log.created], [])
    for (const missing of ['unreachable', 'no-workspace'] as const) {
      const t = setup({ anchor: { missing } })
      assert.deepEqual(await t.service.composeUp('ssh:A', 'shop', MEMBER, null, OPTIONS),
        { ok: false, problem: { kind: missing, message: missing === 'unreachable' ? 'Orca could not reach this host.' : 'This host has no workspace.' } })
      assert.deepEqual(await t.service.composeUp('local', 'shop', MEMBER, FOCUS, OPTIONS),
        { ok: false, problem: { kind: 'no-workspace', message: 'This host has no workspace.' } })
      assert.deepEqual(t.calls, [])
    }
    // A local anchor without a workspace id: nothing runs.
    const noId = setup({ anchor: { path: '/w' } })
    assert.deepEqual(await noId.service.composeUp('local', 'shop', MEMBER, FOCUS, OPTIONS),
      { ok: false, problem: { kind: 'no-workspace', message: 'This host has no workspace.' } })
    assert.deepEqual(noId.calls, [])
    const problem = { kind: 'timeout' as const, message: 'The ssh session to "A" did not finish in time' }
    const check = setup({ kernel: null })
    check.setSsh({ ok: false, problem })
    assert.deepEqual(await check.service.composeUp('ssh:A', 'shop', MEMBER, null, OPTIONS), { ok: false, problem })
    assert.deepEqual(check.log.sshRuns.map((run) => run.commands), [[]])
    assert.deepEqual(check.log.created, [])
  })

  test('a labels failure opens no terminal', async () => {
    const local = setup()
    local.setLocal([{ name: 'labels', code: 0, lines: [labelsLine({ 'com.docker.compose.project': 'other' })] }])
    assert.deepEqual(await local.service.composeUp('local', 'shop', MEMBER, FOCUS, OPTIONS), NOT_SHOP)
    const remote = setup()
    remote.setSsh({ ok: true, value: [{ name: 'labels', code: 0, lines: [labelsLine({ 'com.docker.compose.project.working_dir': 'relative' })] }] })
    assert.deepEqual(await remote.service.composeUp('ssh:A', 'shop', MEMBER, null, OPTIONS), NO_FILES)
    const failed = setup()
    failed.setSsh({ ok: true, value: [{ name: 'labels', code: 1, lines: ['Error: No such object: cccccccccccc'] }] })
    const r = await failed.service.composeUp('ssh:A', 'shop', MEMBER, null, OPTIONS)
    assert.deepEqual(r, { ok: false, problem: { kind: 'failed', message: 'Error: No such object: cccccccccccc' } })
    for (const t of [local, remote, failed]) {
      assert.deepEqual([...t.log.created, ...t.log.localTerminals, ...t.log.switched, ...t.log.remembered], [])
    }
  })

  test('invalid input opens no terminal and runs nothing, on either host', async () => {
    const t = setup({ kernel: null })
    for (const hostId of ['local', 'ssh:A'] as const) {
      for (const project of BAD_PROJECTS) {
        const r = await t.service.composeUp(hostId, project, MEMBER, FOCUS, OPTIONS)
        assert.equal(!r.ok && r.problem.kind, 'invalid', `${hostId} project ${JSON.stringify(project)}`)
      }
      for (const member of BAD_MEMBERS) {
        const r = await t.service.composeUp(hostId, 'shop', member, FOCUS, OPTIONS)
        assert.equal(!r.ok && r.problem.kind, 'invalid', `${hostId} member ${JSON.stringify(member)}`)
      }
    }
    assert.deepEqual(t.calls, [])
    assert.deepEqual(t.log.remembered, [])
  })

  // Review Focus 1: awkward but absolute label paths reach the terminal as single quoted words.
  test('awkward paths from the labels stay single words in the typed command', async () => {
    const dir = "/srv/my shop/it's $(id)"
    const t = setup()
    t.setSsh({ ok: true, value: [{ name: 'labels', code: 0, lines: [labelsLine({
      'com.docker.compose.project.working_dir': dir, 'com.docker.compose.project.config_files': `${dir}/compose.yml`,
    })] }] })
    assert.equal((await t.service.composeUp('ssh:A', 'shop', MEMBER, null, OPTIONS)).ok, true)
    assert.equal(t.log.created[0]?.command,
      `docker compose --project-directory '/srv/my shop/it'\\''s $(id)' -p shop -f '/srv/my shop/it'\\''s $(id)/compose.yml' up -d`)
  })

  test('a CliError while opening is unreachable and nothing is remembered', async () => {
    const t = setup()
    t.setSsh({ ok: true, value: [LABELS_OK] })
    t.failCreate(new CliError('cli_exec_failed', 'cannot reach'))
    assert.deepEqual(await t.service.composeUp('ssh:A', 'shop', MEMBER, null, OPTIONS), { ok: false, problem: { kind: 'unreachable', message: 'cannot reach' } })
    assert.deepEqual([...t.log.remembered, ...t.log.switched], [])
  })

  test('the up title is the project, cut to 40 characters', async () => {
    assert.equal(terminalTitle('compose up', 'shop'), 'compose up: shop')
    const long = 'a'.repeat(63)
    assert.equal(terminalTitle('compose up', long), `compose up: ${'a'.repeat(40)}…`)
    const t = setup()
    t.setLocal([{ name: 'labels', code: 0, lines: [labelsLine({ 'com.docker.compose.project': long })] }])
    assert.equal((await t.service.composeUp('local', long, MEMBER, FOCUS, OPTIONS)).ok, true)
    assert.equal(t.log.localTerminals[0]!.title, `compose up: ${'a'.repeat(40)}…`)
  })
})

// The real host list over a fake Orca CLI: GPU2's workspace listing fails (Orca's runtime there is down), cloud-gpu lists none,
// and GPU3's listing answers without covering the host (connected, but no repo there). Orca's listing must not keep any
// of them from ssh.
class ListingCli extends FakeCli {
  failing = new Set<string>()
  notCovered = new Set<string>()
  override async listWorktrees(environment: string, options?: CallOptions) {
    const rows = await super.listWorktrees(environment, options)
    if (this.failing.has(environment)) throw new CliError('remote_runtime_unavailable', 'down')
    if (this.notCovered.has(environment)) throw new CliError('host_not_covered', `Orca could not cover host ${environment}`)
    return rows
  }
}

// `sshProblem`: every ssh run fails with it.
function listingSetup(opts: { sshProblem?: Problem } = {}) {
  const cli = new ListingCli()
  cli.environments = ['GPU2', 'cloud-gpu', 'GPU3']
  cli.worktrees = { GPU2: [{ path: '/home/me/a5', displayName: 'a5', branch: 'main' }], 'cloud-gpu': [] }
  cli.failing.add('GPU2')
  cli.notCovered.add('GPU3')
  const data = new Map<string, unknown>([[kernelKey('GPU2'), 'Linux'], [kernelKey('cloud-gpu'), 'Linux'], [kernelKey('GPU3'), 'Linux']])
  const storage: KeyValueStore = {
    async get(key) { return data.get(key) },
    async set(key, value) { data.set(key, value) },
    async delete(key) { data.delete(key) },
  }
  const hosts = createHosts({ cli, listLocalWorkspaces: async () => [], platform: 'darwin', storage, now: () => 1_000, log: () => {} })
  const runs: { env: string; names: string[] }[] = []
  const answers: Record<string, CommandResult[]> = {
    snapshot: okResults(), action: [{ name: 'action', code: 0, lines: [ID] }], logs: [{ name: 'logs', code: 0, lines: ['ssh log'] }],
  }
  const ssh: SshRunner = {
    async run(env, commands) {
      const names = commands.map((c) => c.name)
      runs.push({ env, names })
      if (opts.sshProblem) return { ok: false, problem: opts.sshProblem }
      return { ok: true, value: answers[names.includes('action') ? 'action' : names.includes('logs') ? 'logs' : 'snapshot']! }
    },
  }
  const local: LocalRunner = { async run() { throw new Error('local.run must not be called') } }
  const service = createService({
    hosts, local, ssh, cli, storage, now: () => 4242, log: () => {},
    async openLocalTerminal() { throw new Error('openLocalTerminal must not be called') },
  })
  const created = () => cli.calls.filter((c) => c.method === 'createTerminal')
  return { service, runs, created, data }
}

describe('service on SSH hosts with Orca listing trouble', () => {
  test('snapshot, action and logs reach the ssh runner on a host whose listing failed and on one with no workspace', async () => {
    const t = listingSetup()
    for (const hostId of ['ssh:GPU2', 'ssh:cloud-gpu'] as const) {
      const snapshot = await t.service.snapshot(hostId, OPTIONS)
      assert.equal(snapshot.ok && snapshot.value.serverVersion, '27.0.1', `${hostId} ${JSON.stringify(snapshot)}`)
      assert.deepEqual(await t.service.action(hostId, 'restart', ID, OPTIONS), { ok: true, value: { done: true } }, hostId)
      assert.deepEqual(await t.service.logs(hostId, ID, OPTIONS), { ok: true, value: { lines: ['ssh log'], takenAt: 4242 } }, hostId)
    }
    const all = ['version', 'ps', 'images', 'volumes', 'networks']
    assert.deepEqual(t.runs, [
      { env: 'GPU2', names: all }, { env: 'GPU2', names: ['action'] }, { env: 'GPU2', names: ['logs'] },
      { env: 'cloud-gpu', names: all }, { env: 'cloud-gpu', names: ['action'] }, { env: 'cloud-gpu', names: ['logs'] },
    ])
    assert.deepEqual(t.created(), [])
  })

  test('on such a host the ssh runner\'s problem comes back as it is', async () => {
    const problem: Problem = { kind: 'ssh-failed', message: 'ssh to "GPU2" failed: ssh: connect to host gpu2 port 22: Operation timed out.' }
    const t = listingSetup({ sshProblem: problem })
    assert.deepEqual(await t.service.snapshot('ssh:GPU2', OPTIONS), { ok: false, problem })
    assert.deepEqual(await t.service.action('ssh:GPU2', 'stop', ID, OPTIONS), { ok: false, problem })
    assert.deepEqual(await t.service.logs('ssh:GPU2', ID, OPTIONS), { ok: false, problem })
    assert.equal(t.runs.length, 3)
  })

  test('openTerminal answers unreachable when the listing failed and no-workspace when it was empty, with no terminal', async () => {
    const t = listingSetup()
    assert.deepEqual(await t.service.openTerminal('ssh:GPU2', 'shell', ID, 'web', FOCUS, OPTIONS),
      { ok: false, problem: { kind: 'unreachable', message: 'Orca could not reach this host.' } })
    assert.deepEqual(await t.service.openTerminal('ssh:cloud-gpu', 'logs', ID, 'web', null, OPTIONS),
      { ok: false, problem: { kind: 'no-workspace', message: 'This host has no workspace.' } })
    // A listing that does not cover the host is no workspace there, not an unreachable host.
    assert.deepEqual(await t.service.openTerminal('ssh:GPU3', 'shell', ID, 'web', FOCUS, OPTIONS),
      { ok: false, problem: { kind: 'no-workspace', message: 'This host has no workspace.' } })
    assert.deepEqual(t.created(), [])
    assert.deepEqual(t.runs, [])
  })

  test('a known unsupported kernel answers unsupported for everything, with no ssh run and no terminal', async () => {
    const t = listingSetup()
    t.data.set(kernelKey('GPU2'), 'FreeBSD')
    t.data.set(kernelKey('cloud-gpu'), 'FreeBSD')
    const unsupported = { ok: false, problem: { kind: 'unsupported', message: 'This host is not supported.' } }
    for (const hostId of ['ssh:GPU2', 'ssh:cloud-gpu'] as const) {
      assert.deepEqual(await t.service.snapshot(hostId, OPTIONS), unsupported, hostId)
      assert.deepEqual(await t.service.action(hostId, 'start', ID, OPTIONS), unsupported, hostId)
      assert.deepEqual(await t.service.logs(hostId, ID, OPTIONS), unsupported, hostId)
      assert.deepEqual(await t.service.openTerminal(hostId, 'shell', ID, 'web', FOCUS, OPTIONS), unsupported, hostId)
    }
    assert.deepEqual(t.runs, [])
    assert.deepEqual(t.created(), [])
  })
})
