import { assert, test } from 'orca/testing'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { composeCommand, composeLabelsCommand, type DockerCommand } from '../docker/commands'
import { createLocalRunner, createMergedOutput, execResultFromError, LOCAL_TIMEOUT_MS, runMerged, type LocalDeps, type LocalExec } from './runner'
import { sshScript } from '../remote/script'

const PS: DockerCommand = { name: 'ps', argv: ['ps'] }
const IMAGES: DockerCommand = { name: 'images', argv: ['images'] }
type Call = { file: string; args: string[]; timeoutMs: number; merge?: boolean }
type Out = { code: number; stdout: string; stderr: string; timedOut: boolean }
const ok = (stdout: string, stderr = ''): Out => ({ code: 0, stdout, stderr, timedOut: false })

function setup(opts: { existing?: string[]; shell?: string | null; reply?: (call: Call) => Out; time?: () => number } = {}) {
  const calls: Call[] = []
  let shellCalls = 0
  const exec: LocalExec = async (file, args, o) => {
    const call: Call = { file, args, timeoutMs: o.timeoutMs, ...(o.merge === undefined ? {} : { merge: o.merge }) }
    calls.push(call)
    return (opts.reply ?? (() => ok('')))(call)
  }
  const deps: LocalDeps = {
    exec,
    exists: (p) => (opts.existing ?? []).includes(p),
    loginShellWhich: async () => { shellCalls++; return opts.shell ?? null },
    now: opts.time ?? (() => 0),
  }
  return { runner: createLocalRunner(deps), calls, shellCalls: () => shellCalls }
}

test('uses the first existing docker candidate and caches it', async () => {
  const t = setup({ existing: ['/opt/homebrew/bin/docker', '/usr/bin/docker'] })
  await t.runner.run([PS, IMAGES], { deadline: 100_000 })
  await t.runner.run([PS], { deadline: 100_000 })
  assert.deepEqual(t.calls.map((c) => c.file), Array(3).fill('/opt/homebrew/bin/docker'))
  assert.deepEqual(t.calls[0]?.args, ['ps'])
  assert.equal(t.shellCalls(), 0)
})

test('falls back to the login shell lookup', async () => {
  const t = setup({ shell: '/somewhere/docker' })
  await t.runner.run([PS], { deadline: 100_000 })
  assert.equal(t.calls[0]?.file, '/somewhere/docker')
})

test('reports a missing docker as code 127', async () => {
  const t = setup()
  const res = await t.runner.run([PS, IMAGES], { deadline: 100_000 })
  assert.deepEqual(res, [
    { name: 'ps', code: 127, lines: ['docker: command not found'] },
    { name: 'images', code: 127, lines: ['docker: command not found'] },
  ])
  assert.equal(t.calls.length, 0)
})

test('puts stderr lines after stdout lines', async () => {
  const t = setup({ existing: ['/usr/bin/docker'], reply: () => ok('a\n\nb\n', 'err1\nerr2\n') })
  const [r] = await t.runner.run([PS], { deadline: 100_000 })
  assert.deepEqual(r, { name: 'ps', code: 0, lines: ['a', '', 'b', 'err1', 'err2'] })
})

test('local logs merge stdout and stderr in arrival order', async () => {
  const LOGS: DockerCommand = { name: 'logs', argv: ['logs', '--tail', '200', 'a'.repeat(12)] }
  const t = setup({ existing: ['/usr/bin/docker'], reply: () => ok('out1\nerr1\nout2\nerr2\n') })
  const [r] = await t.runner.run([PS, LOGS], { deadline: 100_000 })
  assert.equal(t.calls[0]?.merge, undefined)
  assert.equal(t.calls[1]?.merge, true)
  assert.deepEqual(t.calls[1]?.args, LOGS.argv)
  const res = await t.runner.run([LOGS], { deadline: 100_000 })
  assert.deepEqual(res, [{ name: 'logs', code: 0, lines: ['out1', 'err1', 'out2', 'err2'] }])
  assert.equal(r?.name, 'ps')
})

test('the merge helper keeps chunks from both pipes in arrival order', () => {
  const m = createMergedOutput(1_000)
  for (const chunk of ['o1\n', Buffer.from('e1\n'), 'o2\n', Buffer.from('e2\n')]) assert.equal(m.add(chunk), true)
  assert.equal(m.text(), 'o1\ne1\no2\ne2\n')
})

test('the merge helper refuses a chunk past maxBuffer and keeps what fit', () => {
  const m = createMergedOutput(5)
  assert.equal(m.add('abc'), true)
  assert.equal(m.add('def'), false)
  assert.equal(m.text(), 'abc')
})

test('a timed-out command is code 124', async () => {
  const t = setup({ existing: ['/usr/bin/docker'], reply: () => ({ code: 1, stdout: 'x\n', stderr: '', timedOut: true }) })
  const [r] = await t.runner.run([PS], { deadline: 100_000 })
  assert.deepEqual(r, { name: 'ps', code: 124, lines: ['x'] }) // started: not marked skipped
})

test('caps each command at the local timeout and the remaining budget', async () => {
  const t = setup({ existing: ['/usr/bin/docker'] })
  await t.runner.run([PS], { deadline: 100_000 })
  await t.runner.run([PS], { deadline: 5_000 })
  assert.deepEqual(t.calls.map((c) => c.timeoutMs), [LOCAL_TIMEOUT_MS, 5_000])
})

test('a compose command gets its own 55 s limit, within the remaining budget; every other command keeps 20 s', async () => {
  const COMPOSE = composeCommand({ project: 'shop', dir: '/srv/shop', files: ['/srv/shop/compose.yml'] }, 'stop')
  const LABELS = composeLabelsCommand('a'.repeat(12))
  const t = setup({ existing: ['/usr/bin/docker'] })
  await t.runner.run([PS, LABELS, COMPOSE, IMAGES], { deadline: 100_000 })
  await t.runner.run([COMPOSE], { deadline: 30_000 })
  assert.equal(LOCAL_TIMEOUT_MS, 20_000)
  assert.deepEqual(t.calls.map((c) => c.timeoutMs), [20_000, 20_000, 55_000, 20_000, 30_000])
  assert.deepEqual(t.calls[2]?.args, COMPOSE.argv)
  assert.equal(t.calls[2]?.merge, undefined)
})

// The service tells a compose command that was started and cut off (its result is unknown) from one never started.
test('only a command never started is marked skipped: no time left before exec, an abort, or no time for the lookup', async () => {
  const COMPOSE = composeCommand({ project: 'shop', dir: '/srv/shop', files: ['/srv/shop/compose.yml'] }, 'stop')
  // Started and cut off by its own limit: 124, not skipped.
  const cut = setup({ existing: ['/usr/bin/docker'], reply: () => ({ code: 1, stdout: '', stderr: '', timedOut: true }) })
  assert.deepEqual(await cut.runner.run([COMPOSE], { deadline: 100_000 }), [{ name: 'compose', code: 124, lines: [] }])
  // The labels run used the budget up: compose never starts.
  let now = 0
  const used = setup({ existing: ['/usr/bin/docker'], time: () => now, reply: () => { now = 1_000; return ok('') } })
  assert.deepEqual(await used.runner.run([composeLabelsCommand('a'.repeat(12)), COMPOSE], { deadline: 1_000 }), [
    { name: 'labels', code: 0, lines: [] }, { name: 'compose', code: 124, lines: [], skipped: true },
  ])
  const ctl = new AbortController()
  ctl.abort()
  assert.deepEqual(await setup({ existing: ['/usr/bin/docker'] }).runner.run([COMPOSE], { deadline: 100_000, signal: ctl.signal }),
    [{ name: 'compose', code: 124, lines: [], skipped: true }])
  const noLookup = setup({ shell: '/somewhere/docker' })
  assert.deepEqual(await noLookup.runner.run([COMPOSE], { deadline: 4_000 }), [{ name: 'compose', code: 124, lines: [], skipped: true }])
  // A docker that itself exits 124 was started.
  const own = setup({ existing: ['/usr/bin/docker'], reply: () => ({ code: 124, stdout: '', stderr: 'x\n', timedOut: false }) })
  assert.deepEqual(await own.runner.run([COMPOSE], { deadline: 100_000 }), [{ name: 'compose', code: 124, lines: ['x'] }])
})

test('a timeoutSeconds that is not a positive whole number is refused before anything runs, as the ssh script refuses it', async () => {
  for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    const t = setup({ existing: ['/usr/bin/docker'] })
    const command: DockerCommand = { name: 'compose', argv: ['compose'], timeoutSeconds: bad }
    let thrown: unknown = null
    try { await t.runner.run([PS, command], { deadline: 100_000 }) } catch (e) { thrown = e }
    let scriptThrown: unknown = null
    try { sshScript('abcdef01', [command]) } catch (e) { scriptThrown = e }
    assert.ok(thrown instanceof Error, String(bad))
    assert.equal((thrown as Error).message, (scriptThrown as Error).message, String(bad))
    assert.match((thrown as Error).message, /timeoutSeconds/)
    assert.equal(t.calls.length, 0, String(bad))
  }
})

test('stops at the deadline', async () => {
  let now = 0
  const t = setup({ existing: ['/usr/bin/docker'], time: () => now, reply: () => { now = 1_000; return ok('') } })
  const res = await t.runner.run([PS, IMAGES, PS], { deadline: 1_000 })
  assert.equal(t.calls.length, 1)
  assert.deepEqual(res.map((r) => r.code), [0, 124, 124])
  assert.deepEqual(res[1], { name: 'images', code: 124, lines: [], skipped: true })
})

test('an aborted signal returns code 124 without calling exec', async () => {
  const t = setup({ existing: ['/usr/bin/docker'] })
  const ctl = new AbortController()
  ctl.abort()
  const res = await t.runner.run([PS], { deadline: 100_000, signal: ctl.signal })
  assert.deepEqual(res, [{ name: 'ps', code: 124, lines: [], skipped: true }])
  assert.equal(t.calls.length, 0)
})

test('an aborted signal never starts the login shell lookup', async () => {
  const t = setup({ shell: '/somewhere/docker' })
  const ctl = new AbortController()
  ctl.abort()
  const res = await t.runner.run([PS, IMAGES], { deadline: 100_000, signal: ctl.signal })
  assert.deepEqual(res, [{ name: 'ps', code: 124, lines: [], skipped: true }, { name: 'images', code: 124, lines: [], skipped: true }])
  assert.equal(t.shellCalls(), 0)
})

test('an expired deadline never starts the login shell lookup', async () => {
  const t = setup({ shell: '/somewhere/docker', time: () => 10 })
  const res = await t.runner.run([PS], { deadline: 10 })
  assert.deepEqual(res, [{ name: 'ps', code: 124, lines: [], skipped: true }])
  assert.equal(t.shellCalls(), 0)
})

test('skips the login shell lookup when its timeout does not fit (code 124), without caching the miss', async () => {
  const t = setup({ shell: '/somewhere/docker' })
  const [short] = await t.runner.run([PS], { deadline: 4_000 })
  assert.deepEqual(short, { name: 'ps', code: 124, lines: [], skipped: true })
  assert.equal(t.shellCalls(), 0)
  await t.runner.run([PS], { deadline: 100_000 })
  assert.equal(t.shellCalls(), 1)
  assert.equal(t.calls[0]?.file, '/somewhere/docker')
})

test('execResultFromError maps a maxBuffer overflow to code 1, not a timeout', () => {
  const err = Object.assign(new Error('big'), { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER', killed: true, signal: 'SIGTERM' })
  assert.deepEqual(execResultFromError(err, 'partial', ''), { code: 1, stdout: '', stderr: 'docker output exceeded 64 MiB', timedOut: false })
})

test('execResultFromError marks a SIGTERM kill as a timeout', () => {
  const err = Object.assign(new Error('killed'), { killed: true, signal: 'SIGTERM' })
  assert.equal(execResultFromError(err, 'a\n', '').timedOut, true)
})

test('execResultFromError maps ENOENT to code 1 with the message', () => {
  const err = Object.assign(new Error('spawn docker ENOENT'), { code: 'ENOENT' })
  assert.deepEqual(execResultFromError(err, '', ''), { code: 1, stdout: '', stderr: 'spawn docker ENOENT', timedOut: false })
})

test('execResultFromError keeps a numeric exit code', () => {
  const err = Object.assign(new Error('exit'), { code: 2 })
  assert.deepEqual(execResultFromError(err, 'o', 'e'), { code: 2, stdout: 'o', stderr: 'e', timedOut: false })
})

function setupClock(afterLookup: number, deadline: number) {
  let now = 0
  const calls: number[] = []
  const runner = createLocalRunner({
    exec: async (_f, _a, o) => { calls.push(o.timeoutMs); return ok('') },
    exists: () => false,
    loginShellWhich: async () => { now = afterLookup; return '/somewhere/docker' },
    now: () => now,
  })
  return { run: () => runner.run([PS, IMAGES], { deadline }), calls }
}

test('a lookup that consumes the whole budget leaves exec uncalled', async () => {
  const t = setupClock(10_000, 10_000)
  const res = await t.run()
  assert.deepEqual(res.map((r) => r.code), [124, 124])
  assert.equal(t.calls.length, 0)
})

test('a lookup that leaves 1 ms passes timeoutMs 1 to exec', async () => {
  const t = setupClock(9_999, 10_000)
  await t.run()
  assert.equal(t.calls[0], 1)
})

// runMerged against node itself (no docker, no other process).
const node = (script: string, ...args: string[]) => [process.execPath, ['-e', script, ...args]] as const
const SIZE = 64 * 1024 * 1024

test('runMerged keeps stdout and stderr in arrival order', async () => {
  const script = "const w=(s,t)=>new Promise(r=>setTimeout(()=>{s.write(t);r()},30));" +
    "(async()=>{process.stdout.write('o1\\n');await w(process.stderr,'e1\\n');await w(process.stdout,'o2\\n')})()"
  const [file, args] = node(script)
  assert.deepEqual(await runMerged(file, [...args], 5_000, SIZE), { code: 0, stdout: 'o1\ne1\no2\n', stderr: '', timedOut: false })
})

test('runMerged marks a never-ending child as timed out, and the runner maps it to 124', async () => {
  const [file, args] = node('setInterval(()=>{},1000)')
  const out = await runMerged(file, [...args], 200, SIZE)
  assert.equal(out.timedOut, true)
  const t = setup({ existing: ['/usr/bin/docker'], reply: () => out })
  const [r] = await t.runner.run([{ name: 'logs', argv: ['logs'] }], { deadline: 100_000 })
  assert.equal(r?.code, 124)
})

test('runMerged maps an overflow to code 1 and kills the child', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'merged-'))
  try {
    const pidFile = join(dir, 'pid')
    const script = "require('fs').writeFileSync(process.argv[1],String(process.pid));" +
      "process.stdout.write('x'.repeat(100));setInterval(()=>{},1000)"
    const [file, args] = node(script, pidFile)
    const out = await runMerged(file, [...args], 5_000, 10)
    assert.deepEqual(out, { code: 1, stdout: '', stderr: 'docker output exceeded 64 MiB', timedOut: false })
    const pid = Number(readFileSync(pidFile, 'utf8'))
    let alive = true
    for (let i = 0; i < 40 && alive; i++) {
      try { process.kill(pid, 0); await new Promise((r) => setTimeout(r, 25)) } catch { alive = false }
    }
    assert.equal(alive, false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('runMerged keeps a non-zero exit code and its output', async () => {
  const [file, args] = node("process.stderr.write('bad\\n');process.exit(3)")
  assert.deepEqual(await runMerged(file, [...args], 5_000, SIZE), { code: 3, stdout: 'bad\n', stderr: '', timedOut: false })
})

test('runMerged reports a missing binary as code 1 with the message', async () => {
  const out = await runMerged('/nonexistent/docker-xyz', [], 5_000, SIZE)
  assert.equal(out.code, 1)
  assert.equal(out.timedOut, false)
  assert.ok(out.stderr.includes('ENOENT'), out.stderr)
})
