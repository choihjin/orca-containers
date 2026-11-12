import { assert, mockHost, mountWorker, test } from 'orca/testing'
import type { OrcaWorkerApi } from 'orca/worker'
import { createWorkerModule, type WorkerDeps } from './worker'
import { FakeCli } from './remote/fake-cli'
import { CliError } from './remote/orca-cli'
import type { LocalRunner } from './local/runner'
import type { CommandResult } from './docker/parse'
import { MARK, startupScript } from './remote/script'
import { SSH_PATH, type SshExec, type SshExecResult } from './remote/ssh'

const versionLine = JSON.stringify({ Server: { Version: '27.0.1' } })
const okResults = (): CommandResult[] => [
  { name: 'version', code: 0, lines: [versionLine] },
  { name: 'ps', code: 0, lines: [] },
  { name: 'images', code: 0, lines: [] },
  { name: 'volumes', code: 0, lines: [] },
  { name: 'networks', code: 0, lines: [] },
]
const WORKSPACES = { workspaces: [{ id: 'ws1', kind: 'worktree', name: 'proj', path: '/Users/x/proj', branch: 'main', hostId: null }], truncated: false }
const CONTEXT = { branch: 'main', displayName: 'proj', terminals: [{ id: 't1', title: 'a' }] }
const ID = 'a'.repeat(12)
// The labels of a member container of Compose project `shop`, as docker inspect prints them.
const LABELS = JSON.stringify({
  'com.docker.compose.project': 'shop', 'com.docker.compose.project.working_dir': '/srv/shop',
  'com.docker.compose.project.config_files': '/srv/shop/compose.yml', 'com.docker.compose.service': 'web',
})
const SHOP_ARGV = ['compose', '--project-directory', '/srv/shop', '-p', 'shop', '-f', '/srv/shop/compose.yml']

// What the remote `sh -s` would print for the script on stdin: READY Linux, then every section with its result.
function remoteOutput(script: string, results: Record<string, { code: number; lines: string[] }> = {}): string {
  const nonce = /^N=([0-9a-f]{8})$/m.exec(script)?.[1] ?? ''
  const names = [...script.matchAll(/SEC_\$\{N\}__ (\w+)"/g)].map((m) => m[1] ?? '')
  const lines = [`${MARK}READY_${nonce}__ Linux`, `${MARK}BEGIN_${nonce}__ 1`]
  for (const name of names) {
    const r = results[name] ?? { code: 0, lines: name === 'version' ? [versionLine] : [] }
    lines.push(`${MARK}SEC_${nonce}__ ${name}`, ...r.lines, `${MARK}RC_${nonce}__ ${name} ${r.code}`)
  }
  lines.push(`${MARK}END_${nonce}__ 2`, '')
  return lines.join('\n')
}

type ExecCall = { file: string; args: string[]; input: string; timeoutMs: number; signal?: AbortSignal }

function setup(results: Record<string, unknown> = {}, cliSetup?: (cli: FakeCli) => void, platform = 'darwin') {
  const counts = { cli: 0, local: 0, sshExec: 0 }
  const runs: { deadline: number; hasSignal: boolean; argv: string[][] }[] = []
  const cli = new FakeCli()
  cliSetup?.(cli)
  const local: LocalRunner = {
    async run(commands, options) {
      runs.push({ deadline: options.deadline, hasSignal: options.signal instanceof AbortSignal, argv: commands.map((c) => c.argv) })
      if (commands.some((c) => c.name === 'logs')) return [{ name: 'logs', code: 0, lines: ['l1', 'l2'] }]
      if (commands.some((c) => c.name === 'remove')) return [{ name: 'remove', code: 0, lines: [] }]
      if (commands.some((c) => c.name === 'labels')) return [{ name: 'labels', code: 0, lines: [LABELS] }]
      if (commands.some((c) => c.name === 'compose')) return [{ name: 'compose', code: 0, lines: [] }]
      return commands.some((c) => c.name === 'action') ? [{ name: 'action', code: 0, lines: [] }] : okResults()
    },
  }
  // Never a real ssh: every exec is recorded and answered here (or held by a test through `answer`).
  const execs: ExecCall[] = []
  const ssh = {
    answer: async (call: ExecCall): Promise<SshExecResult> => ({ code: 0, stdout: remoteOutput(call.input), stderr: '', timedOut: false }),
  }
  const exec: SshExec = async (file, args, o) => {
    const call: ExecCall = { file, args, ...o }
    execs.push(call)
    return ssh.answer(call)
  }
  const deps: WorkerDeps = {
    makeCli: () => { counts.cli++; return cli },
    makeLocal: () => { counts.local++; return local },
    makeSshExec: () => { counts.sshExec++; return exec },
    platform,
    now: () => 1_000,
    randomHex: () => 'deadbeef',
  }
  const host = mockHost({ results: { 'workspace.readContext': CONTEXT, 'workspace.list': WORKSPACES, 'terminal.create': { terminalId: 'term_x' }, ...results } })
  return { counts, runs, cli, host, execs, ssh, module: createWorkerModule(deps) }
}

const sshHost = (cli: FakeCli) => {
  cli.environments = ['GPU1']
  cli.worktrees = { GPU1: [{ path: '/home/u/proj', displayName: 'proj', branch: 'main' }] }
}

// mountWorker hands each request a signal that never aborts. This bare host keeps the handlers the worker registers
// and calls them with a signal the test owns.
type Handler = (raw: unknown, ctx: { signal: AbortSignal }) => Promise<unknown>
function bareHost(module: ReturnType<typeof createWorkerModule>) {
  const handlers = new Map<string, Handler>()
  const data = new Map<string, unknown>()
  const orca = {
    host: { call: async (method: string) => (method === 'workspace.list' ? WORKSPACES : method === 'workspace.readContext' ? CONTEXT : null) },
    panels: { handle: (name: string, handler: Handler) => { handlers.set(name, handler) } },
    storage: {
      get: async (key: string) => data.get(key),
      set: async (key: string, value: unknown) => { data.set(key, value) },
      delete: async (key: string) => { data.delete(key) },
    },
    log: () => {},
  }
  module.default(orca as unknown as OrcaWorkerApi)
  return { request: (name: string, raw: unknown, signal: AbortSignal) => handlers.get(name)!(raw, { signal }) }
}

// Counts the abort listeners added to `signal` and not yet removed.
function abortListeners(signal: AbortSignal): () => number {
  let count = 0
  const add = signal.addEventListener.bind(signal)
  const remove = signal.removeEventListener.bind(signal)
  Object.assign(signal, {
    addEventListener: (type: string, listener: EventListener, options?: AddEventListenerOptions) => {
      if (type === 'abort') count++
      add(type, listener, options)
    },
    removeEventListener: (type: string, listener: EventListener, options?: EventListenerOptions) => {
      if (type === 'abort') count--
      remove(type, listener, options)
    },
  })
  return () => count
}

// An exec that waits until its signal aborts, then answers as a stopped run.
function holdUntilAborted(s: ReturnType<typeof setup>): Promise<void> {
  return new Promise<void>((started) => {
    s.ssh.answer = (call) => new Promise((resolve) => {
      started()
      call.signal?.addEventListener('abort', () => resolve({ code: null, stdout: '', stderr: '', timedOut: true }), { once: true })
    })
  })
}

test('activate does not start any external process', async () => {
  const s = setup()
  await mountWorker(s.module, { host: s.host })
  assert.equal(s.counts.cli, 0)
  assert.equal(s.counts.local, 0)
  assert.equal(s.counts.sshExec, 0)
})

test('answers hosts.list as a Result', async () => {
  const s = setup({}, (cli) => { cli.environments = ['A'] })
  const w = await mountWorker(s.module, { host: s.host })
  const r = await w.request('hosts.list', {}) as { ok: boolean; value: { hosts: { id: string }[] } }
  assert.equal(r.ok, true)
  assert.ok(r.value.hosts.some((h) => h.id === 'local'))
  assert.ok(r.value.hosts.some((h) => h.id === 'ssh:A'))
  assert.equal(s.counts.cli, 1)
})

// Ruling I3 (was: a failed Result): the Orca CLI failing leaves this Mac listed and working, and is logged.
test('a CLI failure listing SSH hosts still lists this Mac, and local Docker keeps working', async () => {
  const s = setup({}, (cli) => { cli.listSshEnvironments = async () => { throw new CliError('cli_failed', 'boom') } })
  const w = await mountWorker(s.module, { host: s.host })
  const r = await w.request('hosts.list', {})
  assert.deepEqual(r, { ok: true, value: { hosts: [{ id: 'local', label: 'This Mac', kind: 'local', status: 'ready' }] } })
  assert.ok(w.logs.some((line) => String(line).includes('boom')), JSON.stringify(w.logs))
  const snapshot = await w.request('docker.snapshot', { hostId: 'local' }) as { ok: boolean }
  assert.equal(snapshot.ok, true)
  assert.deepEqual(w.refusals, [])
})

test('answers docker.snapshot for local with no refusals', async () => {
  const s = setup()
  const w = await mountWorker(s.module, { host: s.host })
  const r = await w.request('docker.snapshot', { hostId: 'local' }) as { ok: boolean }
  assert.equal(r.ok, true)
  assert.deepEqual(w.refusals, [])
  assert.equal(s.runs.length, 1)
  assert.equal(s.runs[0]?.deadline, 101_000)
  assert.equal(s.runs[0]?.hasSignal, true)
})

test('works when readContext is null', async () => {
  const s = setup({ 'workspace.readContext': null })
  const w = await mountWorker(s.module, { host: s.host })
  const r = await w.request('docker.snapshot', { hostId: 'local' }) as { ok: boolean }
  assert.equal(r.ok, true)
  assert.deepEqual(w.refusals, [])
})

test('opens a local terminal with terminal.create', async () => {
  const s = setup()
  const w = await mountWorker(s.module, { host: s.host })
  const r = await w.request('docker.openTerminal', { hostId: 'local', kind: 'logs', containerId: 'a'.repeat(12), containerName: 'web' })
  assert.deepEqual(r, { ok: true, value: { opened: true, workspace: 'proj' } }) // ruling I2: names the workspace
  const calls = s.host.callsOf('terminal.create') as unknown[]
  assert.equal(calls.length, 1)
  const params = calls[0] as { workspaceId: string; title: string; command: string }
  assert.equal(params.workspaceId, 'ws1')
  assert.equal(params.title, 'logs: web')
  assert.ok(params.command.includes('docker'))
})

// Ruling M10: workspace.list rows of other hosts are not local workspaces.
test('uses only workspaces of this Mac for local terminals', async () => {
  const remoteFirst = { workspaces: [
    { id: 'remote1', kind: 'worktree', name: 'gpu', path: '/home/u/gpu', branch: 'main', hostId: 'ssh-GPU1' },
    { id: 'ws0', kind: 'worktree', name: 'mac', path: '/Users/x/mac', branch: 'main', hostId: 'local' },
    WORKSPACES.workspaces[0],
  ], truncated: false }
  const s = setup({ 'workspace.list': remoteFirst, 'workspace.readContext': null })
  const w = await mountWorker(s.module, { host: s.host })
  const r = await w.request('docker.openTerminal', { hostId: 'local', kind: 'logs', containerId: 'a'.repeat(12), containerName: 'web' })
  assert.deepEqual(r, { ok: true, value: { opened: true, workspace: 'mac' } })
  assert.equal((s.host.callsOf('terminal.create')[0] as { workspaceId: string }).workspaceId, 'ws0')
})

// Ruling R1: the local auto refresh (every 10 s) must not list Orca's terminals; only a local Logs/Shell does, with 5 s.
test('a local snapshot or action lists no terminals; a local terminal finds its workspace by terminal id', async () => {
  const twoProj = { workspaces: [
    WORKSPACES.workspaces[0],
    { id: 'ws2', kind: 'worktree', name: 'proj', path: '/Users/x/proj2', branch: 'main', hostId: null },
  ], truncated: false }
  const s = setup({ 'workspace.list': twoProj }, (cli) => { cli.localTerminals = [{ handle: 't1', worktreePath: '/Users/x/proj2' }] })
  const w = await mountWorker(s.module, { host: s.host })
  const lookups = () => s.cli.calls.filter((c) => c.method === 'listLocalTerminals')
  assert.equal((await w.request('docker.snapshot', { hostId: 'local' }) as { ok: boolean }).ok, true)
  assert.deepEqual(await w.request('docker.action', { hostId: 'local', action: 'start', containerId: 'a'.repeat(12) }), { ok: true, value: { done: true } })
  assert.deepEqual(lookups(), [])
  const r = await w.request('docker.openTerminal', { hostId: 'local', kind: 'shell', containerId: 'a'.repeat(12), containerName: 'web' })
  assert.deepEqual(r, { ok: true, value: { opened: true, workspace: 'proj' } })
  assert.equal((s.host.callsOf('terminal.create')[0] as { workspaceId: string }).workspaceId, 'ws2')
  assert.deepEqual(lookups(), [{ method: 'listLocalTerminals', timeoutMs: 5_000 }])
})

// Fix round 1, item 1: this Mac's readiness comes from the platform, so a hung SSH host listing never delays local Docker.
test('a hung SSH host listing does not delay local Docker: no listing for a local snapshot, action or terminal', async () => {
  const listing = { asks: 0 }
  const s = setup({}, (cli) => {
    cli.listSshEnvironments = async () => { listing.asks++; throw new CliError('cli_timeout', 'Orca CLI timed out after 10000 ms') }
  })
  const w = await mountWorker(s.module, { host: s.host })
  assert.equal((await w.request('docker.snapshot', { hostId: 'local' }) as { ok: boolean }).ok, true)
  assert.deepEqual(await w.request('docker.action', { hostId: 'local', action: 'start', containerId: 'a'.repeat(12) }), { ok: true, value: { done: true } })
  assert.deepEqual(await w.request('docker.openTerminal', { hostId: 'local', kind: 'logs', containerId: 'a'.repeat(12), containerName: 'web' }),
    { ok: true, value: { opened: true, workspace: 'proj' } })
  assert.equal(listing.asks, 0)
  assert.equal(s.runs.length, 2) // docker ran for the snapshot and the action
  // An SSH id still needs the listing, and asks again while it fails (R3).
  const ssh = await w.request('docker.snapshot', { hostId: 'ssh:A' }) as { ok: boolean; problem: { kind: string } }
  assert.equal(ssh.problem.kind, 'invalid')
  assert.equal(listing.asks, 1)
})

test('answers hosts.matchFocus with the exact shape', async () => {
  const s = setup({}, (cli) => { cli.environments = ['A']; cli.worktrees = { A: [{ path: '/h/p', displayName: 'remote-proj', branch: 'dev' }] } })
  const w = await mountWorker(s.module, { host: s.host })
  assert.deepEqual(await w.request('hosts.matchFocus', { displayName: 'proj', branch: 'main', terminalIds: ['t1'] }), { ok: true, value: { hostId: 'local' } })
  assert.deepEqual(await w.request('hosts.matchFocus', { displayName: 'nothing', branch: 'x', terminalIds: [] }), { ok: true, value: { hostId: null } })
})

test('answers docker.action with the exact shape', async () => {
  const s = setup()
  const w = await mountWorker(s.module, { host: s.host })
  const r = await w.request('docker.action', { hostId: 'local', action: 'start', containerId: 'a'.repeat(12) })
  assert.deepEqual(r, { ok: true, value: { done: true } })
})

test('answers docker.logs with the exact shape', async () => {
  const s = setup()
  const w = await mountWorker(s.module, { host: s.host })
  const r = await w.request('docker.logs', { hostId: 'local', containerId: 'a'.repeat(12) })
  assert.deepEqual(r, { ok: true, value: { lines: ['l1', 'l2'], takenAt: 1_000 } })
  assert.deepEqual(JSON.parse(JSON.stringify(r)), r)
  assert.deepEqual(w.refusals, [])
  const bad = await w.request('docker.logs', { hostId: 'local', containerId: 'web' }) as { ok: boolean; problem: { kind: string } }
  assert.equal(bad.problem.kind, 'invalid')
})

test('rejects invalid input before calling the service', async () => {
  const s = setup()
  const w = await mountWorker(s.module, { host: s.host })
  for (const [name, input] of [
    ['docker.snapshot', { hostId: 'ssh:' }],
    ['docker.snapshot', { hostId: 'remote' }],
    ['docker.logs', { hostId: 'remote', containerId: 'abc' }],
    ['docker.logs', { hostId: 'local', containerId: 5 }],
    ['docker.action', { hostId: 'local', action: 'kill', containerId: 'abc' }],
    ['docker.openTerminal', { hostId: 'local', kind: 'exec', containerId: 'a', containerName: 'b' }],
    ['docker.removeResource', null],
    ['docker.removeResource', ['local', 'image', 'nginx']],
    ['docker.removeResource', { hostId: 'remote', kind: 'image', ref: 'nginx' }],
    ['docker.removeResource', { hostId: 'local', kind: 'container', ref: 'nginx' }],
    ['docker.removeResource', { hostId: 'local', kind: 'constructor', ref: 'nginx' }],
    ['docker.removeResource', { hostId: 'local', ref: 'nginx' }],
    ['docker.removeResource', { hostId: 'local', kind: 'image' }],
    ['docker.removeResource', { hostId: 'local', kind: 'image', ref: 5 }],
    ['docker.removeResource', { hostId: 'local', kind: 'volume', ref: ['pgdata'] }],
    ['docker.pullTerminal', null],
    ['docker.pullTerminal', { hostId: 'ssh:', ref: 'nginx' }],
    ['docker.pullTerminal', { hostId: 'local' }],
    ['docker.pullTerminal', { hostId: 'local', ref: null }],
    ['docker.pullTerminal', { hostId: 'local', ref: { name: 'nginx' } }],
    ['hosts.list', { refresh: 'yes' }],
    ['hosts.matchFocus', { displayName: 1 }],
  ] as const) {
    const r = await w.request(name as 'hosts.list', input as never) as { ok: boolean; problem: { kind: string } }
    assert.equal(r.ok, false, name)
    assert.equal(r.problem.kind, 'invalid', name)
  }
  assert.equal(s.counts.cli, 0)
})

test('answers docker.removeResource with the exact shape, running the fixed command', async () => {
  const s = setup()
  const w = await mountWorker(s.module, { host: s.host })
  const r = await w.request('docker.removeResource', { hostId: 'local', kind: 'image', ref: 'nginx:1.27' })
  assert.deepEqual(r, { ok: true, value: { done: true } })
  assert.deepEqual(JSON.parse(JSON.stringify(r)), r)
  assert.deepEqual(s.runs.map((run) => run.argv), [[['image', 'rm', 'nginx:1.27']]])
  assert.equal(s.runs[0]?.deadline, 101_000)
  assert.deepEqual(s.host.callsOf('workspace.readContext'), [])
  assert.deepEqual(s.host.callsOf('terminal.create'), [])
  assert.deepEqual(w.refusals, [])
})

test('an SSH remove reaches the injected ssh exec with the fixed command, and opens no terminal', async () => {
  const s = setup({}, sshHost)
  const w = await mountWorker(s.module, { host: s.host })
  const r = await w.request('docker.removeResource', { hostId: 'ssh:GPU1', kind: 'volume', ref: 'pgdata' })
  assert.deepEqual(r, { ok: true, value: { done: true } })
  assert.equal(s.execs.length, 1)
  assert.deepEqual(s.execs[0]!.args.slice(-3), ['--', 'GPU1', 'sh -s'])
  assert.ok(s.execs[0]!.input.includes('"$D" volume rm pgdata </dev/null'), s.execs[0]!.input)
  assert.equal(s.cli.calls.some((c) => c.method === 'createTerminal'), false)
  assert.deepEqual(s.host.callsOf('terminal.create'), [])
  // The daemon refusing it comes back as its own message.
  s.ssh.answer = async (call) => ({
    code: 0, timedOut: false, stderr: '',
    stdout: remoteOutput(call.input, { remove: { code: 1, lines: ['Error response from daemon: remove pgdata: volume is in use - [0123456789ab]'] } }),
  })
  assert.deepEqual(await w.request('docker.removeResource', { hostId: 'ssh:GPU1', kind: 'volume', ref: 'pgdata' }),
    { ok: false, problem: { kind: 'failed', message: 'remove pgdata: volume is in use - [0123456789ab]' } })
  assert.deepEqual(w.refusals, [])
})

test('a remove or pull with a hostile ref is invalid and runs or opens nothing', async () => {
  const s = setup({}, sshHost)
  const w = await mountWorker(s.module, { host: s.host })
  for (const ref of ['-f', '--force', 'nginx -f', 'a;b', '$(id)', 'a\nb', '../x', 'a@b@c']) {
    for (const hostId of ['local', 'ssh:GPU1'] as const) {
      for (const kind of ['image', 'volume', 'network'] as const) {
        const r = await w.request('docker.removeResource', { hostId, kind, ref }) as { ok: boolean; problem: { kind: string } }
        assert.equal(r.problem.kind, 'invalid', `${hostId} ${kind} ${JSON.stringify(ref)}`)
      }
      const pull = await w.request('docker.pullTerminal', { hostId, ref }) as { ok: boolean; problem: { kind: string } }
      assert.equal(pull.problem.kind, 'invalid', `${hostId} pull ${JSON.stringify(ref)}`)
    }
  }
  assert.equal(s.runs.length, 0)
  assert.equal(s.execs.length, 0)
  assert.deepEqual(s.host.callsOf('terminal.create'), [])
  assert.equal(s.cli.calls.some((c) => c.method === 'createTerminal'), false)
})

test('answers docker.pullTerminal by opening a local terminal with docker pull and its title', async () => {
  const s = setup()
  const w = await mountWorker(s.module, { host: s.host })
  const r = await w.request('docker.pullTerminal', { hostId: 'local', ref: 'nginx:latest' })
  assert.deepEqual(r, { ok: true, value: { opened: true, workspace: 'proj' } })
  assert.deepEqual(JSON.parse(JSON.stringify(r)), r)
  assert.deepEqual(s.host.callsOf('terminal.create'), [{ workspaceId: 'ws1', title: 'pull: nginx:latest', command: 'docker pull nginx:latest' }])
  assert.equal(s.host.callsOf('workspace.readContext').length, 1)
  assert.equal(s.runs.length, 0)
  assert.deepEqual(w.refusals, [])
})

test('an SSH pull opens an Orca terminal on that host after the kernel check and startup scan, and runs no docker command', async () => {
  const s = setup({}, sshHost)
  const w = await mountWorker(s.module, { host: s.host })
  const r = await w.request('docker.pullTerminal', { hostId: 'ssh:GPU1', ref: 'ghcr.io/org/app:1.2' })
  assert.deepEqual(r, { ok: true, value: { opened: true, workspace: 'proj' } })
  assert.equal(s.execs.length, 1)
  assert.equal(s.execs[0]!.input, startupScript('deadbeef'))
  const created = s.cli.calls.filter((c) => c.method === 'createTerminal')
  assert.deepEqual(created, [{
    method: 'createTerminal', environment: 'GPU1', worktreePath: '/home/u/proj', title: 'pull: ghcr.io/org/app:1.2',
    command: 'docker pull ghcr.io/org/app:1.2', focus: true,
  }])
  assert.deepEqual(s.cli.calls.filter((c) => c.method === 'switchTo').map((c) => c.environment), ['GPU1'])
})

test('answers docker.composeAction with the exact shape: the labels lookup, then one compose command on this Mac', async () => {
  for (const action of ['start', 'stop', 'restart', 'down'] as const) {
    const s = setup()
    const w = await mountWorker(s.module, { host: s.host })
    const r = await w.request('docker.composeAction', { hostId: 'local', project: 'shop', memberId: ID, action })
    assert.deepEqual(r, { ok: true, value: { done: true } }, action)
    assert.deepEqual(JSON.parse(JSON.stringify(r)), r)
    assert.deepEqual(s.runs.map((run) => run.argv), [[['inspect', '--format', '{{json .Config.Labels}}', ID]], [[...SHOP_ARGV, action]]], action)
    assert.deepEqual(s.runs.map((run) => run.deadline), [101_000, 101_000])
    assert.deepEqual(s.host.callsOf('workspace.readContext'), [])
    assert.deepEqual(s.host.callsOf('terminal.create'), [])
    assert.deepEqual(w.refusals, [])
  }
})

test('an SSH compose action is two ssh runs, labels then compose under its 55 s limit, and opens no terminal', async () => {
  const s = setup({}, sshHost)
  const w = await mountWorker(s.module, { host: s.host })
  s.ssh.answer = async (call) => ({
    code: 0, timedOut: false, stderr: '', stdout: remoteOutput(call.input, { labels: { code: 0, lines: [LABELS] } }),
  })
  assert.deepEqual(await w.request('docker.composeAction', { hostId: 'ssh:GPU1', project: 'shop', memberId: ID, action: 'down' }), { ok: true, value: { done: true } })
  assert.equal(s.execs.length, 2)
  assert.ok(s.execs[0]!.input.includes(`$T "$D" inspect --format '{{json .Config.Labels}}' ${ID} </dev/null`), s.execs[0]!.input)
  assert.equal(s.execs[0]!.input.includes('compose'), false)
  assert.ok(s.execs[1]!.input.includes('${T:+timeout 55} "$D" compose --project-directory /srv/shop -p shop -f /srv/shop/compose.yml down </dev/null'), s.execs[1]!.input)
  assert.equal(s.cli.calls.some((c) => c.method === 'createTerminal'), false)
  assert.deepEqual(s.host.callsOf('terminal.create'), [])
  assert.deepEqual(s.host.callsOf('workspace.readContext'), [])
  // Labels of another project stop before compose.
  s.ssh.answer = async (call) => ({
    code: 0, timedOut: false, stderr: '',
    stdout: remoteOutput(call.input, { labels: { code: 0, lines: [LABELS.replace('"shop"', '"other"')] } }),
  })
  assert.deepEqual(await w.request('docker.composeAction', { hostId: 'ssh:GPU1', project: 'shop', memberId: ID, action: 'stop' }),
    { ok: false, problem: { kind: 'failed', message: 'This container is not part of Compose project shop' } })
  assert.equal(s.execs.length, 3)
  assert.deepEqual(w.refusals, [])
})

test('an SSH compose that timeout 55 ended (rc 124) answers unknown-result through the real ssh runner', async () => {
  const s = setup({}, sshHost)
  const w = await mountWorker(s.module, { host: s.host })
  s.ssh.answer = async (call) => ({
    code: 0, timedOut: false, stderr: '',
    stdout: remoteOutput(call.input, { labels: { code: 0, lines: [LABELS] }, compose: { code: 124, lines: [' Container shop-web-1  Stopping'] } }),
  })
  assert.deepEqual(await w.request('docker.composeAction', { hostId: 'ssh:GPU1', project: 'shop', memberId: ID, action: 'stop' }),
    { ok: false, problem: { kind: 'unknown-result', message: 'sent; result unknown' } })
  assert.equal(s.execs.length, 2)
  assert.deepEqual(w.refusals, [])
})

test('answers docker.composeUp by opening a local terminal with docker compose ... up -d and its title', async () => {
  const s = setup()
  const w = await mountWorker(s.module, { host: s.host })
  const r = await w.request('docker.composeUp', { hostId: 'local', project: 'shop', memberId: ID })
  assert.deepEqual(r, { ok: true, value: { opened: true, workspace: 'proj' } })
  assert.deepEqual(JSON.parse(JSON.stringify(r)), r)
  assert.deepEqual(s.runs.map((run) => run.argv), [[['inspect', '--format', '{{json .Config.Labels}}', ID]]])
  assert.deepEqual(s.host.callsOf('terminal.create'), [{
    workspaceId: 'ws1', title: 'compose up: shop', command: 'docker compose --project-directory /srv/shop -p shop -f /srv/shop/compose.yml up -d',
  }])
  assert.equal(s.host.callsOf('workspace.readContext').length, 1)
  assert.deepEqual(w.refusals, [])
})

test('an SSH compose up checks the kernel and scans, looks up the labels, then opens an Orca terminal on that host', async () => {
  const s = setup({}, sshHost)
  const w = await mountWorker(s.module, { host: s.host })
  s.ssh.answer = async (call) => ({
    code: 0, timedOut: false, stderr: '', stdout: remoteOutput(call.input, { labels: { code: 0, lines: [LABELS] } }),
  })
  const r = await w.request('docker.composeUp', { hostId: 'ssh:GPU1', project: 'shop', memberId: ID })
  assert.deepEqual(r, { ok: true, value: { opened: true, workspace: 'proj' } })
  assert.equal(s.execs.length, 2)
  assert.equal(s.execs[0]!.input, startupScript('deadbeef'))
  assert.ok(s.execs[1]!.input.includes('"$D" inspect'), s.execs[1]!.input)
  assert.deepEqual(s.cli.calls.filter((c) => c.method === 'createTerminal'), [{
    method: 'createTerminal', environment: 'GPU1', worktreePath: '/home/u/proj', title: 'compose up: shop',
    command: 'docker compose --project-directory /srv/shop -p shop -f /srv/shop/compose.yml up -d', focus: true,
  }])
  assert.deepEqual(s.cli.calls.filter((c) => c.method === 'switchTo').map((c) => c.environment), ['GPU1'])
})

test('compose requests with a bad shape or a bad value are invalid and run or open nothing', async () => {
  const s = setup({}, sshHost)
  const w = await mountWorker(s.module, { host: s.host })
  const good = { hostId: 'local', project: 'shop', memberId: ID }
  const cases: [string, unknown][] = [
    ['docker.composeAction', null],
    ['docker.composeAction', ['local', 'shop', ID, 'stop']],
    ['docker.composeAction', { ...good, hostId: 'remote', action: 'stop' }],
    ['docker.composeAction', { ...good, hostId: 'ssh:', action: 'stop' }],
    ['docker.composeAction', { ...good, project: undefined, action: 'stop' }],
    ['docker.composeAction', { ...good, project: 5, action: 'stop' }],
    ['docker.composeAction', { ...good, memberId: undefined, action: 'stop' }],
    ['docker.composeAction', { ...good, memberId: [ID], action: 'stop' }],
    ['docker.composeAction', good],
    ['docker.composeAction', { ...good, action: 'remove' }],
    ['docker.composeAction', { ...good, action: 'up' }],
    ['docker.composeAction', { ...good, action: 'down -v' }],
    ['docker.composeAction', { ...good, action: 'constructor' }],
    ['docker.composeUp', null],
    ['docker.composeUp', { ...good, hostId: 'ssh:' }],
    ['docker.composeUp', { ...good, project: null }],
    ['docker.composeUp', { ...good, memberId: 5 }],
    ['docker.composeUp', { hostId: 'local', project: 'shop' }],
  ]
  // Shaped right, but the service refuses the value.
  for (const hostId of ['local', 'ssh:GPU1']) {
    for (const project of ['-p', 'Shop', 'a b', '$(id)', 'a\nb', '']) {
      cases.push(['docker.composeAction', { hostId, project, memberId: ID, action: 'stop' }], ['docker.composeUp', { hostId, project, memberId: ID }])
    }
    for (const memberId of ['web', '-f', 'x; reboot', '']) {
      cases.push(['docker.composeAction', { hostId, project: 'shop', memberId, action: 'stop' }], ['docker.composeUp', { hostId, project: 'shop', memberId }])
    }
  }
  for (const [name, input] of cases) {
    const r = await w.request(name as 'docker.composeUp', input as never) as { ok: boolean; problem: { kind: string } }
    assert.equal(r.ok, false, `${name} ${JSON.stringify(input)}`)
    assert.equal(r.problem.kind, 'invalid', `${name} ${JSON.stringify(input)}`)
  }
  assert.equal(s.runs.length, 0)
  assert.equal(s.execs.length, 0)
  assert.deepEqual(s.host.callsOf('terminal.create'), [])
  assert.equal(s.cli.calls.some((c) => c.method === 'createTerminal'), false)
  assert.deepEqual(w.refusals, [])
})

// The three terminal requests, on this Mac and on SSH host GPU1.
const TERMINAL_REQUESTS = [
  ['docker.openTerminal', { kind: 'shell', containerId: ID, containerName: 'web' }],
  ['docker.openTerminal', { kind: 'logs', containerId: ID, containerName: 'web' }],
  ['docker.pullTerminal', { ref: 'nginx:1.27' }],
  ['docker.composeUp', { project: 'shop', memberId: ID }],
] as const

test('the terminal requests take allowStartupShell only as an optional boolean', async () => {
  const s = setup({}, sshHost)
  const w = await mountWorker(s.module, { host: s.host })
  for (const [name, input] of TERMINAL_REQUESTS) {
    for (const hostId of ['local', 'ssh:GPU1']) {
      for (const allowStartupShell of ['true', 1, 0, null, {}, [true]]) {
        const r = await w.request(name as 'docker.composeUp', { hostId, ...input, allowStartupShell } as never)
        assert.deepEqual(r, { ok: false, problem: { kind: 'invalid', message: 'allowStartupShell must be a boolean.' } }, `${name} ${JSON.stringify(allowStartupShell)}`)
      }
    }
  }
  assert.equal(s.runs.length, 0)
  assert.equal(s.execs.length, 0)
  assert.deepEqual(s.host.callsOf('terminal.create'), [])
  assert.equal(s.cli.calls.some((c) => c.method === 'createTerminal'), false)
  // On this Mac a flag of either value is accepted, and nothing is scanned.
  for (const [name, input] of TERMINAL_REQUESTS) {
    for (const allowStartupShell of [true, false]) {
      const r = await w.request(name as 'docker.composeUp', { hostId: 'local', ...input, allowStartupShell } as never)
      assert.deepEqual(r, { ok: true, value: { opened: true, workspace: 'proj' } }, `${name} ${allowStartupShell}`)
    }
  }
  assert.equal(s.execs.length, 0)
  assert.deepEqual(w.refusals, [])
})

// Through the real ssh runner: the remote startup section names .bashrc and fish's file, by their paths in $HOME.
test('an SSH terminal request whose login files start tmux answers startup-shell and opens nothing; with allowStartupShell it opens', async () => {
  for (const [name, input] of TERMINAL_REQUESTS) {
    const s = setup({}, sshHost)
    const w = await mountWorker(s.module, { host: s.host })
    s.ssh.answer = async (call) => ({
      code: 0, timedOut: false, stderr: '',
      stdout: remoteOutput(call.input, { startup: { code: 0, lines: ['.bashrc', '.config/fish/config.fish'] }, labels: { code: 0, lines: [LABELS] } }),
    })
    const blocked = await w.request(name as 'docker.composeUp', { hostId: 'ssh:GPU1', ...input } as never)
    assert.deepEqual(blocked, { ok: false, problem: { kind: 'startup-shell', message: '.bashrc, .config/fish/config.fish' } }, name)
    assert.deepEqual(s.execs.map((e) => e.input), [startupScript('deadbeef')], name)
    assert.equal(s.cli.calls.some((c) => c.method === 'createTerminal'), false, name)
    assert.deepEqual(await w.request(name as 'docker.composeUp', { hostId: 'ssh:GPU1', ...input, allowStartupShell: false } as never), blocked, name)
    const opened = await w.request(name as 'docker.composeUp', { hostId: 'ssh:GPU1', ...input, allowStartupShell: true } as never)
    assert.deepEqual(opened, { ok: true, value: { opened: true, workspace: 'proj' } }, name)
    // The kernel is stored by now: no scan and no check, only Up's labels lookup.
    assert.equal(s.execs.slice(2).some((e) => e.input.includes('startup')), false, name)
    assert.equal(s.execs.length, name === 'docker.composeUp' ? 3 : 2, name)
    assert.equal(s.cli.calls.filter((c) => c.method === 'createTerminal').length, 1, name)
    assert.deepEqual(w.refusals, [])
  }
})

test('deactivate does not create the dependencies', async () => {
  const s = setup()
  const w = await mountWorker(s.module, { host: s.host })
  await w.deactivate()
  assert.equal(s.counts.cli, 0)
})

test('worker wires the ssh runner: an SSH snapshot reaches the injected exec as ssh to that host', async () => {
  const s = setup({}, sshHost)
  const w = await mountWorker(s.module, { host: s.host })
  const r = await w.request('docker.snapshot', { hostId: 'ssh:GPU1' }) as { ok: boolean; value: { hostId: string; serverVersion: string } }
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.equal(r.value.hostId, 'ssh:GPU1')
  assert.equal(r.value.serverVersion, '27.0.1')
  assert.equal(s.execs.length, 1)
  const call = s.execs[0]!
  assert.equal(call.file, SSH_PATH)
  assert.deepEqual(call.args.slice(-3), ['--', 'GPU1', 'sh -s'])
  assert.ok(call.input.includes('N=deadbeef'), call.input)
  assert.equal(call.timeoutMs, 60_000)
  assert.equal(call.signal instanceof AbortSignal, true)
  assert.equal(s.counts.sshExec, 1)
  assert.deepEqual(w.refusals, [])
})

test('an SSH snapshot, action and logs open, type into, read or close no terminal', async () => {
  const s = setup({}, sshHost)
  const w = await mountWorker(s.module, { host: s.host })
  s.ssh.answer = async (call) => ({
    code: 0, timedOut: false, stderr: '',
    stdout: remoteOutput(call.input, { action: { code: 0, lines: [ID] }, logs: { code: 0, lines: ['remote line'] } }),
  })
  assert.equal((await w.request('docker.snapshot', { hostId: 'ssh:GPU1' }) as { ok: boolean }).ok, true)
  assert.deepEqual(await w.request('docker.action', { hostId: 'ssh:GPU1', action: 'stop', containerId: ID }), { ok: true, value: { done: true } })
  assert.deepEqual(await w.request('docker.logs', { hostId: 'ssh:GPU1', containerId: ID }), { ok: true, value: { lines: ['remote line'], takenAt: 1_000 } })
  assert.equal(s.execs.length, 3)
  assert.deepEqual([...new Set(s.cli.calls.map((c) => c.method))].sort(), ['listSshEnvironments', 'listWorktrees'])
  assert.deepEqual(s.host.callsOf('terminal.create'), [])
  assert.deepEqual(w.refusals, [])
})

// The scan run goes through the real ssh runner: READY with the kernel, BEGIN, an empty startup section, END.
test('an SSH Shell checks a kernel it does not know with the startup scan run, then opens an Orca terminal on that host', async () => {
  const s = setup({}, sshHost)
  const w = await mountWorker(s.module, { host: s.host })
  const r = await w.request('docker.openTerminal', { hostId: 'ssh:GPU1', kind: 'shell', containerId: ID, containerName: 'web' })
  assert.deepEqual(r, { ok: true, value: { opened: true, workspace: 'proj' } })
  assert.equal(s.execs.length, 1)
  assert.deepEqual(s.execs[0]!.args.slice(-3), ['--', 'GPU1', 'sh -s'])
  assert.equal(s.execs[0]!.input, startupScript('deadbeef'))
  assert.equal(s.cli.calls.filter((c) => c.method === 'createTerminal').length, 1)
  assert.deepEqual(s.cli.calls.filter((c) => c.method === 'switchTo').map((c) => c.environment), ['GPU1'])
  // The run stored the kernel: the next terminal on that host only scans, in its own small run.
  await w.request('docker.openTerminal', { hostId: 'ssh:GPU1', kind: 'logs', containerId: ID, containerName: 'web' })
  assert.equal(s.execs.length, 2)
  assert.equal(s.execs[1]!.input, startupScript('deadbeef'))
  assert.equal(s.cli.calls.filter((c) => c.method === 'createTerminal').length, 2)
})

test('an SSH Shell on a host the check finds unsupported (not Linux or macOS) opens no terminal', async () => {
  const s = setup({}, sshHost)
  const w = await mountWorker(s.module, { host: s.host })
  s.ssh.answer = async (call) => {
    const nonce = /^N=([0-9a-f]{8})$/m.exec(call.input)?.[1] ?? ''
    return { code: 0, stdout: `${MARK}READY_${nonce}__ FreeBSD\n`, stderr: '', timedOut: false }
  }
  const r = await w.request('docker.openTerminal', { hostId: 'ssh:GPU1', kind: 'shell', containerId: ID, containerName: 'web' }) as { ok: boolean; problem: { kind: string } }
  assert.equal(r.problem.kind, 'unsupported', JSON.stringify(r))
  assert.equal(s.cli.calls.some((c) => c.method === 'createTerminal'), false)
})

test('a snapshot, action and logs request reads no workspace context, on this Mac or over ssh', async () => {
  const s = setup({}, sshHost)
  const w = await mountWorker(s.module, { host: s.host })
  s.ssh.answer = async (call) => ({
    code: 0, timedOut: false, stderr: '',
    stdout: remoteOutput(call.input, { action: { code: 0, lines: [ID] }, logs: { code: 0, lines: ['remote line'] } }),
  })
  for (const hostId of ['local', 'ssh:GPU1'] as const) {
    assert.equal((await w.request('docker.snapshot', { hostId }) as { ok: boolean }).ok, true, hostId)
    assert.equal((await w.request('docker.action', { hostId, action: 'start', containerId: ID }) as { ok: boolean }).ok, true, hostId)
    assert.equal((await w.request('docker.logs', { hostId, containerId: ID }) as { ok: boolean }).ok, true, hostId)
  }
  assert.deepEqual(s.host.callsOf('workspace.readContext'), [])
  // A terminal still reads it, to find the focused workspace.
  await w.request('docker.openTerminal', { hostId: 'local', kind: 'shell', containerId: ID, containerName: 'web' })
  assert.equal(s.host.callsOf('workspace.readContext').length, 1)
})

test('deactivate aborts an ssh run that is still going', async () => {
  const s = setup({}, sshHost)
  const w = await mountWorker(s.module, { host: s.host })
  const running = holdUntilAborted(s)
  const request = w.request('docker.snapshot', { hostId: 'ssh:GPU1' })
  await running
  assert.equal(s.execs[0]!.signal?.aborted, false)
  await w.deactivate()
  assert.equal(s.execs[0]!.signal?.aborted, true)
  const r = await request as { ok: boolean; problem: { kind: string } }
  assert.equal(r.problem.kind, 'timeout', JSON.stringify(r))
})

test('the request signal aborting reaches the ssh exec', async () => {
  const s = setup({}, sshHost)
  const bare = bareHost(s.module)
  const running = holdUntilAborted(s)
  const outer = new AbortController()
  const request = bare.request('docker.snapshot', { hostId: 'ssh:GPU1' }, outer.signal)
  await running
  assert.equal(s.execs[0]!.signal?.aborted, false)
  outer.abort()
  const r = await request as { ok: boolean; problem: { kind: string } }
  assert.equal(s.execs[0]!.signal?.aborted, true)
  assert.equal(r.problem.kind, 'timeout', JSON.stringify(r))
})

test('a finished request leaves no listener on its signal, and deactivate no longer reaches it', async () => {
  const s = setup({}, sshHost)
  const bare = bareHost(s.module)
  const outer = new AbortController()
  const listening = abortListeners(outer.signal)
  const r = await bare.request('docker.snapshot', { hostId: 'ssh:GPU1' }, outer.signal) as { ok: boolean }
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.equal(listening(), 0)
  await s.module.deactivate()
  assert.equal(s.execs[0]!.signal?.aborted, false)
})

test('after deactivate a request answers timeout at once, without listing hosts or running anything', async () => {
  const s = setup({}, sshHost)
  const w = await mountWorker(s.module, { host: s.host })
  await s.module.deactivate() // the module's own: the mounted handlers stay registered
  for (const [name, input] of [
    ['docker.snapshot', { hostId: 'ssh:GPU1' }],
    ['docker.snapshot', { hostId: 'local' }],
    ['hosts.list', {}],
  ] as const) {
    const r = await w.request(name as 'hosts.list', input as never) as { ok: boolean; problem: { kind: string } }
    assert.equal(r.problem.kind, 'timeout', name)
  }
  assert.deepEqual(s.cli.calls, [])
  assert.equal(s.execs.length, 0)
  assert.equal(s.runs.length, 0)
})

// Orca on Linux: the local host is "This computer", and ssh messages name it the same way.
test('on Linux the worker lists This computer and its ssh messages say this computer', async () => {
  const s = setup({}, sshHost, 'linux')
  const w = await mountWorker(s.module, { host: s.host })
  const hosts = await w.request('hosts.list', {}) as { ok: boolean; value: { hosts: { id: string; label: string; status: string }[] } }
  assert.deepEqual(hosts.value.hosts[0], { id: 'local', label: 'This computer', kind: 'local', status: 'ready' })
  s.ssh.answer = async () => ({ code: 255, stdout: '', stderr: 'ssh: Could not resolve hostname gpu1: Name or service not known', timedOut: false })
  const r = await w.request('docker.snapshot', { hostId: 'ssh:GPU1' }) as { ok: boolean; problem: { kind: string; message: string } }
  assert.equal(r.problem.kind, 'ssh-failed')
  assert.match(r.problem.message, / on this computer\./)
})
