import type { ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { PassThrough } from 'node:stream'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assert, describe, test } from 'orca/testing'
import { actionCommand, InvalidInputError, logsCommand, removeCommand, SNAPSHOT_COMMANDS } from '../docker/commands'
import type { CommandResult } from '../docker/parse'
import { MARK, sshScript } from './script'
import {
  createSshRunner, kernelKey, nodeSshExec, SSH_KILL_GRACE_MS, SSH_PATH, SSH_RUN_TIMEOUT_MS, sshArgs, type KeyValueStore, type SshExec,
} from './ssh'

const NONCE = 'abcdef01'
const ENV = 'GPU1'
const ID = 'a'.repeat(12)
const STOP = actionCommand('stop', ID)

type Out = Awaited<ReturnType<SshExec>>
type Call = { file: string; args: string[]; input: string; timeoutMs: number; signal?: AbortSignal }

function memStore() {
  const data = new Map<string, unknown>()
  const store: KeyValueStore = {
    get: async (k) => data.get(k),
    set: async (k, v) => { data.set(k, v) },
    delete: async (k) => { data.delete(k) },
  }
  return { data, store }
}

function setup(reply: (call: Call) => Partial<Out> | Promise<Partial<Out>> = () => ({}),
  opts: { now?: () => number; sshPath?: string; nonces?: string[]; storage?: KeyValueStore } = {}) {
  const calls: Call[] = []
  const { data, store: mem } = memStore()
  const store = opts.storage ?? mem
  const nonces = opts.nonces ?? [NONCE]
  let hexCalls = 0
  const exec: SshExec = async (file, args, o) => {
    const call: Call = { file, args, input: o.input, timeoutMs: o.timeoutMs, ...(o.signal ? { signal: o.signal } : {}) }
    calls.push(call)
    return { code: 0, stdout: '', stderr: '', timedOut: false, ...(await reply(call)) }
  }
  const runner = createSshRunner({
    exec, storage: store, now: opts.now ?? (() => 0),
    randomHex: () => nonces[Math.min(hexCalls++, nonces.length - 1)] ?? NONCE,
    ...(opts.sshPath ? { sshPath: opts.sshPath } : {}),
  })
  return { runner, calls, data }
}

const marker = (kind: string, rest = '', nonce = NONCE) => `${MARK}${kind}_${nonce}__${rest ? ` ${rest}` : ''}`
const READY = marker('READY', 'Linux')
const BEGIN = marker('BEGIN', '1')
const section = (r: CommandResult, nonce: string) => [marker('SEC', r.name, nonce), ...r.lines, marker('RC', `${r.name} ${r.code}`, nonce)]
const output = (...lines: string[]) => `${lines.join('\n')}\n`
const completeFor = (nonce: string, ...results: CommandResult[]) => output(marker('READY', 'Linux', nonce), marker('BEGIN', '1', nonce),
  ...results.flatMap((r) => section(r, nonce)), marker('END', '2', nonce))
const complete = (...results: CommandResult[]) => completeFor(NONCE, ...results)
const nonceOf = (call: Call): string => /^N=([0-9a-f]{8})$/m.exec(call.input)?.[1] ?? ''
const OPTS = { deadline: 100_000 }

const invalidInput = (error: unknown): boolean => error instanceof InvalidInputError

const FIXED = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-o', 'ServerAliveInterval=10', '-o', 'ServerAliveCountMax=3',
  '-o', 'ClearAllForwardings=yes', '-o', 'ForwardAgent=no', '-o', 'ForwardX11=no', '-o', 'PermitLocalCommand=no',
  '-o', 'LogLevel=ERROR', '-T', '--']

describe('ssh argv', () => {
  test('argv is exact for GPU1', () => {
    assert.deepEqual(sshArgs('GPU1'), [...FIXED, 'GPU1', 'sh -s'])
  })

  test('accepts plain host names up to 255 characters', () => {
    for (const name of ['cloud-gpu', 'GPU2', 'gpu.lab.example', 'my_host', '1host', 'h'.repeat(255)]) {
      assert.deepEqual(sshArgs(name), [...FIXED, name, 'sh -s'])
    }
  })

  test('a host name starting with - is refused without spawning', async () => {
    const name = '-oProxyCommand=touch /tmp/x'
    assert.throws(() => sshArgs(name), invalidInput)
    assert.throws(() => sshArgs('-V'), invalidInput)
    const t = setup()
    const res = await t.runner.run(name, SNAPSHOT_COMMANDS, OPTS)
    assert.deepEqual(res, { ok: false, problem: { kind: 'ssh-failed', message: `"${name}" cannot be used as an ssh host name.` } })
    assert.equal(t.calls.length, 0)
  })

  test('names with a space, ;, $, an empty name and a 256-character name are refused without spawning', async () => {
    for (const name of ['my host', 'a;b', 'a$b', '', 'h'.repeat(256), '.hidden', '_x', 'a\nb', 'a/b', 'user@host']) {
      assert.throws(() => sshArgs(name), invalidInput)
      const t = setup()
      const res = await t.runner.run(name, SNAPSHOT_COMMANDS, OPTS)
      assert.equal(res.ok ? 'ok' : res.problem.kind, 'ssh-failed', JSON.stringify(name))
      assert.equal(t.calls.length, 0, JSON.stringify(name))
    }
  })

  test('a refused name is shown without escape sequences or control characters', async () => {
    const res = await setup().runner.run('a\u0007\u001b[31m\u001b]0;t\u0007\nb', SNAPSHOT_COMMANDS, OPTS)
    assert.deepEqual(res, { ok: false, problem: { kind: 'ssh-failed', message: '"ab" cannot be used as an ssh host name.' } })
  })
})

describe('ssh runner', () => {
  test('spawns SSH_PATH with the fixed argv and the ssh script on stdin', async () => {
    const t = setup(() => ({ stdout: complete() }))
    await t.runner.run(ENV, SNAPSHOT_COMMANDS, OPTS)
    assert.equal(t.calls.length, 1)
    assert.equal(t.calls[0]?.file, SSH_PATH)
    assert.equal(SSH_PATH, '/usr/bin/ssh')
    assert.deepEqual(t.calls[0]?.args, sshArgs(ENV))
    assert.equal(t.calls[0]?.input, sshScript(NONCE, SNAPSHOT_COMMANDS))
  })

  test('uses an injected ssh path', async () => {
    const t = setup(() => ({ stdout: complete() }), { sshPath: '/opt/ssh' })
    await t.runner.run(ENV, SNAPSHOT_COMMANDS, OPTS)
    assert.equal(t.calls[0]?.file, '/opt/ssh')
  })

  test('each run uses a fresh nonce', async () => {
    const t = setup((call) => ({ stdout: completeFor(nonceOf(call)) }), { nonces: ['11111111', '22222222'] })
    assert.equal((await t.runner.run(ENV, SNAPSHOT_COMMANDS, OPTS)).ok, true)
    assert.equal((await t.runner.run(ENV, SNAPSHOT_COMMANDS, OPTS)).ok, true)
    assert.equal(t.calls[0]?.input, sshScript('11111111', SNAPSHOT_COMMANDS))
    assert.equal(t.calls[1]?.input, sshScript('22222222', SNAPSHOT_COMMANDS))
  })

  test('refuses a nonce that is not 8 lowercase hex digits', async () => {
    const t = setup(() => ({}), { nonces: ['ABCDEF01'] })
    await assert.rejects(t.runner.run(ENV, SNAPSHOT_COMMANDS, OPTS), /randomHex/)
    assert.equal(t.calls.length, 0)
  })

  test('runs on the same host may overlap: each is its own ssh process', async () => {
    let release = () => {}
    const gate = new Promise<void>((resolve) => { release = resolve })
    const t = setup(async (call) => {
      await gate
      return { stdout: completeFor(nonceOf(call), { name: 'action', code: 0, lines: [nonceOf(call) === '11111111' ? 'one' : 'two'] }) }
    }, { nonces: ['11111111', '22222222'] })
    const both = Promise.all([t.runner.run(ENV, [STOP], OPTS), t.runner.run(ENV, [STOP], OPTS)])
    await new Promise((r) => setTimeout(r, 0))
    assert.equal(t.calls.length, 2)
    release()
    const results = await both
    assert.deepEqual(results, [
      { ok: true, value: [{ name: 'action', code: 0, lines: ['one'] }] },
      { ok: true, value: [{ name: 'action', code: 0, lines: ['two'] }] },
    ])
  })

  test('passes min(SSH_RUN_TIMEOUT_MS, deadline - now) and the signal to exec', async () => {
    const t = setup(() => ({ stdout: complete() }), { now: () => 1_000 })
    const ctl = new AbortController()
    await t.runner.run(ENV, SNAPSHOT_COMMANDS, { deadline: 100_000, signal: ctl.signal })
    await t.runner.run(ENV, SNAPSHOT_COMMANDS, { deadline: 6_000 })
    assert.equal(SSH_RUN_TIMEOUT_MS, 60_000)
    assert.deepEqual(t.calls.map((c) => c.timeoutMs), [SSH_RUN_TIMEOUT_MS, 5_000])
    assert.equal(t.calls[0]?.signal, ctl.signal)
    assert.equal(t.calls[1]?.signal, undefined)
  })

  test('a passed deadline is a timeout without spawning', async () => {
    const t = setup(() => ({ stdout: complete() }), { now: () => 100_000 })
    const res = await t.runner.run(ENV, SNAPSHOT_COMMANDS, { deadline: 100_000 })
    assert.equal(res.ok ? 'ok' : res.problem.kind, 'timeout')
    assert.equal(t.calls.length, 0)
  })

  test('an aborted signal is a timeout without spawning', async () => {
    const t = setup(() => ({ stdout: complete() }))
    const ctl = new AbortController()
    ctl.abort()
    const res = await t.runner.run(ENV, [STOP], { deadline: 100_000, signal: ctl.signal })
    assert.equal(res.ok ? 'ok' : res.problem.kind, 'timeout')
    assert.equal(t.calls.length, 0)
  })

  test('a spawn error is ssh-failed', async () => {
    const t = setup(() => ({ code: null, spawnError: 'spawn /usr/bin/ssh ENOENT' }))
    const res = await t.runner.run(ENV, SNAPSHOT_COMMANDS, OPTS)
    assert.deepEqual(res, { ok: false, problem: { kind: 'ssh-failed', message: 'The ssh command could not start on this Mac: spawn /usr/bin/ssh ENOENT.' } })
  })

  test('an overflow is truncated, even when the output looks complete', async () => {
    const t = setup(() => ({ stdout: complete({ name: 'ps', code: 0, lines: ['x'] }), overflow: true, code: null }))
    const res = await t.runner.run(ENV, SNAPSHOT_COMMANDS, OPTS)
    assert.equal(res.ok ? 'ok' : res.problem.kind, 'truncated')
    assert.equal(t.data.has(kernelKey(ENV)), false)
  })

  test('a complete run is ok with each command result, and the kernel is stored', async () => {
    const results: CommandResult[] = [
      { name: 'version', code: 0, lines: ['{"Server":{}}'] },
      { name: 'ps', code: 0, lines: ['{"ID":"1"}', '{"ID":"2"}'] },
      { name: 'images', code: 1, lines: ['Error: boom'] },
    ]
    const t = setup(() => ({ stdout: complete(...results) }))
    const res = await t.runner.run(ENV, SNAPSHOT_COMMANDS, OPTS)
    assert.deepEqual(res, { ok: true, value: results })
    assert.equal(t.data.get(kernelKey(ENV)), 'Linux')
    assert.equal(kernelKey(ENV), 'kernel:GPU1')
  })

  test('Darwin is unsupported, with the kernel stored', async () => {
    const t = setup(() => ({ stdout: output(marker('READY', 'Darwin')) }))
    const res = await t.runner.run(ENV, SNAPSHOT_COMMANDS, OPTS)
    assert.equal(res.ok ? 'ok' : res.problem.kind, 'unsupported')
    assert.equal(t.data.get(kernelKey(ENV)), 'Darwin')
  })

  test('the kernel in the unsupported message has no escape sequences', async () => {
    const t = setup(() => ({ stdout: output(marker('READY', 'Dar\u001b[1mwin\u0007')) }))
    const res = await t.runner.run(ENV, SNAPSHOT_COMMANDS, OPTS)
    assert.deepEqual(res, { ok: false, problem: { kind: 'unsupported', message: 'Remote kernel Darwin is not supported' } })
  })

  test('a kernel that cannot be stored does not change the answer', async () => {
    const storage: KeyValueStore = { get: async () => undefined, set: async () => { throw new Error('storage down') }, delete: async () => {} }
    const t = setup(() => ({ stdout: complete({ name: 'action', code: 0, lines: [ID] }) }), { storage })
    assert.deepEqual(await t.runner.run(ENV, [STOP], OPTS), { ok: true, value: [{ name: 'action', code: 0, lines: [ID] }] })
    const darwin = setup(() => ({ stdout: output(marker('READY', 'Darwin')) }), { storage })
    const res = await darwin.runner.run(ENV, [STOP], OPTS)
    assert.equal(res.ok ? 'ok' : res.problem.kind, 'unsupported')
  })

  test('a READY line of another nonce is not ours', async () => {
    const t = setup(() => ({ stdout: output(marker('READY', 'Darwin', '99999999')), code: 0 }))
    const res = await t.runner.run(ENV, SNAPSHOT_COMMANDS, OPTS)
    assert.equal(res.ok ? 'ok' : res.problem.kind, 'failed')
    assert.equal(t.data.has(kernelKey(ENV)), false)
  })

  const sshFailure = async (stderr: string) => {
    const t = setup(() => ({ code: 255, stderr }))
    const res = await t.runner.run(ENV, SNAPSHOT_COMMANDS, OPTS)
    assert.equal(t.data.has(kernelKey(ENV)), false)
    return res
  }

  test('an unknown host name is ssh-failed with the ~/.ssh/config hint', async () => {
    const res = await sshFailure('ssh: Could not resolve hostname a6000: nodename nor servname provided, or not known\n')
    assert.deepEqual(res, { ok: false, problem: { kind: 'ssh-failed',
      message: 'No ssh host named "GPU1" on this Mac. Add a "Host GPU1" entry with key login to ~/.ssh/config.' } })
  })

  test('a login that needs a prompt is ssh-failed with the key hint', async () => {
    const message = 'ssh could not log in to "GPU1" without a prompt. Run `ssh GPU1` once in a terminal on this Mac and use a key that needs no typing (ssh-agent).'
    for (const stderr of [
      'me@a6000: Permission denied (publickey,password).',
      'Host key verification failed.',
      'Received disconnect from 10.0.0.1 port 22:2: Too many authentication failures\nme@a6000: No more authentication methods to try.',
      'Load key "/Users/me/.ssh/id_ed25519": incorrect PASSPHRASE',
    ]) {
      assert.deepEqual(await sshFailure(stderr), { ok: false, problem: { kind: 'ssh-failed', message } }, stderr)
    }
  })

  test('another ssh failure names the host and its first stderr line', async () => {
    const res = await sshFailure('\n  \nssh: connect to host 10.0.0.1 port 22: Connection refused\nsecond line\n')
    assert.deepEqual(res, { ok: false, problem: { kind: 'ssh-failed',
      message: 'ssh to "GPU1" failed: ssh: connect to host 10.0.0.1 port 22: Connection refused.' } })
  })

  test('the stderr line in an ssh failure is cut to 200 characters and cleaned', async () => {
    const res = await sshFailure(`\u001b[1;31m\u001b]0;title\u0007\u001b]8;;http://x\u001b\\${'e'.repeat(300)}\u001b[0m\n`)
    assert.equal(res.ok, false)
    const message = res.ok ? '' : res.problem.message
    const line = message.slice('ssh to "GPU1" failed: '.length, -1)
    assert.ok(line.length <= 200, `${line.length}`)
    assert.ok(line.startsWith('eee'), line)
    assert.equal(/[\u0000-\u001f\u007f-\u009f]/.test(message), false)
  })

  test('an ssh failure with no stderr names the exit code', async () => {
    assert.deepEqual(await sshFailure(''), { ok: false, problem: { kind: 'ssh-failed', message: 'ssh to "GPU1" failed with exit code 255.' } })
  })

  test('code 255 after READY is not an ssh failure', async () => {
    const t = setup(() => ({ code: 255, stdout: output(READY), stderr: 'Connection to a6000 closed by remote host.' }))
    const res = await t.runner.run(ENV, SNAPSHOT_COMMANDS, OPTS)
    assert.deepEqual(res, { ok: false, problem: { kind: 'failed', message: 'The ssh session to "GPU1" ended before docker finished.' } })
    assert.equal(t.data.get(kernelKey(ENV)), 'Linux')
  })

  test('another exit code without READY is failed, not ssh-failed', async () => {
    const t = setup(() => ({ code: 127, stderr: 'sh: command not found' }))
    const res = await t.runner.run(ENV, SNAPSHOT_COMMANDS, OPTS)
    assert.deepEqual(res, { ok: false, problem: { kind: 'failed', message: 'The ssh session to "GPU1" ended before docker finished.' } })
  })

  test('a dropped connection during an action is unknown-result', async () => {
    const dropped = output(READY, BEGIN, marker('SEC', 'action'))
    for (const commands of [[STOP], [STOP, logsCommand(ID)]]) {
      const t = setup(() => ({ code: 255, stdout: dropped, stderr: 'client_loop: send disconnect: Broken pipe' }))
      assert.deepEqual(await t.runner.run(ENV, commands, OPTS), { ok: false, problem: { kind: 'unknown-result', message: 'sent; result unknown' } })
    }
  })

  test('an action that timed out after BEGIN is unknown-result', async () => {
    const t = setup(() => ({ code: null, timedOut: true, stdout: output(READY, BEGIN) }))
    const res = await t.runner.run(ENV, [STOP], OPTS)
    assert.equal(res.ok ? 'ok' : res.problem.kind, 'unknown-result')
  })

  test('an action that timed out after READY, before BEGIN, is unknown-result', async () => {
    const timedOut = await setup(() => ({ code: null, timedOut: true, stdout: output(READY) })).runner.run(ENV, [STOP], OPTS)
    assert.equal(timedOut.ok ? 'ok' : timedOut.problem.kind, 'unknown-result')
  })

  test('an action that may have been sent is unknown-result', async () => {
    const UNKNOWN = { ok: false, problem: { kind: 'unknown-result', message: 'sent; result unknown' } }
    const cases: [string, Partial<Out>][] = [
      ['timed out, nothing read', { code: null, timedOut: true, stdout: '' }],
      ['timed out, ssh ended with 255', { code: 255, timedOut: true, stdout: '', stderr: 'ssh: Could not resolve hostname a6000' }],
      ['overflow', { code: null, overflow: true, stdout: output(READY, BEGIN, marker('SEC', 'action')) }],
      ['overflow, nothing parsed', { code: null, overflow: true, stdout: 'x'.repeat(100) }],
      ['code 255 after READY, no BEGIN', { code: 255, stdout: output(READY), stderr: 'Connection to a6000 closed by remote host.' }],
      ['code 0 after READY, no BEGIN', { code: 0, stdout: output(READY) }],
    ]
    for (const [name, reply] of cases) {
      assert.deepEqual(await setup(() => reply).runner.run(ENV, [STOP], OPTS), UNKNOWN, name)
    }
  })

  test('an action aborted after spawning is unknown-result', async () => {
    const ctl = new AbortController()
    const t = setup(() => { ctl.abort(); return { code: 255, stdout: '', stderr: 'Killed by signal 15.' } })
    const res = await t.runner.run(ENV, [STOP], { deadline: 100_000, signal: ctl.signal })
    assert.deepEqual(res, { ok: false, problem: { kind: 'unknown-result', message: 'sent; result unknown' } })
  })

  test('a remove cut off after READY is unknown-result: timed out, aborted after spawning, or overflow', async () => {
    const UNKNOWN = { ok: false, problem: { kind: 'unknown-result', message: 'sent; result unknown' } }
    const remove = removeCommand('volume', 'pgdata')
    const timedOut = await setup(() => ({ code: null, timedOut: true, stdout: output(READY) })).runner.run(ENV, [remove], OPTS)
    assert.deepEqual(timedOut, UNKNOWN, 'timed out')
    const ctl = new AbortController()
    const aborted = await setup(() => { ctl.abort(); return { code: 255, stdout: output(READY), stderr: 'Killed by signal 15.' } })
      .runner.run(ENV, [remove], { deadline: 100_000, signal: ctl.signal })
    assert.deepEqual(aborted, UNKNOWN, 'aborted after spawning')
    const overflow = await setup(() => ({ code: null, overflow: true, stdout: output(READY, BEGIN, marker('SEC', 'remove')) })).runner.run(ENV, [remove], OPTS)
    assert.deepEqual(overflow, UNKNOWN, 'overflow')
  })

  test('an action keeps its answer when nothing could have been sent', async () => {
    const pure = await setup(() => ({ code: 255, stderr: 'ssh: Could not resolve hostname a6000: nodename nor servname provided' }))
      .runner.run(ENV, [STOP], OPTS)
    assert.equal(pure.ok ? 'ok' : pure.problem.kind, 'ssh-failed')
    const darwin = await setup(() => ({ code: null, timedOut: true, stdout: output(marker('READY', 'Darwin')) })).runner.run(ENV, [STOP], OPTS)
    assert.equal(darwin.ok ? 'ok' : darwin.problem.kind, 'unsupported')
    const ended = await setup(() => ({ code: 0, stdout: '' })).runner.run(ENV, [STOP], OPTS)
    assert.equal(ended.ok ? 'ok' : ended.problem.kind, 'failed')
  })

  test('markers of another nonce are not ours', async () => {
    const other = output(marker('READY', 'Linux', '99999999'), marker('BEGIN', '1', '99999999'))
    const t = setup(() => ({ code: 255, stdout: other }))
    assert.deepEqual(await t.runner.run(ENV, [STOP], OPTS), { ok: false, problem: { kind: 'ssh-failed', message: 'ssh to "GPU1" failed with exit code 255.' } })
    assert.equal(t.data.has(kernelKey(ENV)), false)
  })

  test('a run we timed out or aborted is never classified by its stderr', async () => {
    const stderr = 'ssh: Could not resolve hostname a6000: nodename nor servname provided'
    for (const commands of [SNAPSHOT_COMMANDS, [logsCommand(ID)]]) {
      const late = await setup(() => ({ code: 255, timedOut: true, stderr })).runner.run(ENV, commands, OPTS)
      assert.equal(late.ok ? 'ok' : late.problem.kind, 'timeout')
      const ctl = new AbortController()
      const aborted = await setup(() => { ctl.abort(); return { code: 255, stderr } }).runner.run(ENV, commands, { deadline: 100_000, signal: ctl.signal })
      assert.equal(aborted.ok ? 'ok' : aborted.problem.kind, 'timeout')
    }
  })

  test('a dropped connection during a snapshot is failed or timeout, never ok', async () => {
    const dropped = output(READY, BEGIN, marker('SEC', 'version'), '{"Server":{}}', marker('RC', 'version 0'), marker('SEC', 'ps'))
    const failed = await setup(() => ({ code: 255, stdout: dropped })).runner.run(ENV, SNAPSHOT_COMMANDS, OPTS)
    assert.deepEqual(failed, { ok: false, problem: { kind: 'failed', message: 'The ssh session to "GPU1" ended before docker finished.' } })
    const late = await setup(() => ({ code: null, timedOut: true, stdout: dropped })).runner.run(ENV, SNAPSHOT_COMMANDS, OPTS)
    assert.equal(late.ok ? 'ok' : late.problem.kind, 'timeout')
    const logs = await setup(() => ({ code: 255, stdout: dropped })).runner.run(ENV, [logsCommand(ID)], OPTS)
    assert.equal(logs.ok ? 'ok' : logs.problem.kind, 'failed')
  })
})

// nodeSshExec against /bin/sh (and node itself for a child that ignores SIGTERM); never ssh.
const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function gone(pid: number): Promise<boolean> {
  for (let i = 0; i < 40; i++) {
    if (!isAlive(pid)) return true
    await new Promise((r) => setTimeout(r, 25))
  }
  return false
}

async function pidFrom(file: string): Promise<number> {
  for (let i = 0; i < 200; i++) {
    const pid = existsSync(file) ? Number(readFileSync(file, 'utf8')) : 0
    if (Number.isInteger(pid) && pid > 0) return pid
    await new Promise((r) => setTimeout(r, 25))
  }
  throw new Error(`no pid in ${file}`)
}

// A child that only does what the test tells it: no 'close' unless emitted, kill() only records the signal.
function fakeChild() {
  const kills: string[] = []
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    pid: 4242, exitCode: null as number | null, signalCode: null as string | null,
    kill: (signal: string) => { kills.push(signal); return true },
  })
  return {
    child, kills,
    spawn: () => child as unknown as ChildProcess,
    exit: (code: number) => { child.exitCode = code; child.emit('exit', code, null) },
  }
}

function withTmp<T>(body: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'ctr-ssh-exec-'))
  return body(dir).finally(() => rmSync(dir, { recursive: true, force: true }))
}

describe('nodeSshExec', () => {
  const exec = nodeSshExec()

  test('stdin reaches the child; exit code, stdout and stderr are kept apart', async () => {
    const out = await exec('/bin/sh', ['-c', 'cat; echo err >&2; exit 3'], { input: 'line one\nline two\n', timeoutMs: 5_000 })
    assert.deepEqual(out, { code: 3, stdout: 'line one\nline two\n', stderr: 'err\n', timedOut: false })
  })

  test('runs a script given on stdin to sh -s', async () => {
    const out = await exec('/bin/sh', ['-s'], { input: 'echo a\necho b >&2\necho c\n', timeoutMs: 5_000 })
    assert.deepEqual(out, { code: 0, stdout: 'a\nc\n', stderr: 'b\n', timedOut: false })
  })

  test('a child that never reads its stdin does not break the call', async () => {
    const out = await exec('/bin/sh', ['-c', 'exit 0'], { input: 'x'.repeat(4 * 1024 * 1024), timeoutMs: 5_000 })
    assert.deepEqual(out, { code: 0, stdout: '', stderr: '', timedOut: false })
  })

  test('a timeout kills the child and is timedOut', async () => {
    await withTmp(async (dir) => {
      const pidFile = join(dir, 'pid')
      const out = await exec('/bin/sh', ['-c', 'echo $$ > "$1"; exec sleep 30', 'sh', pidFile], { input: '', timeoutMs: 300 })
      assert.equal(out.timedOut, true)
      assert.equal(out.code, null)
      assert.equal(await gone(Number(readFileSync(pidFile, 'utf8'))), true)
    })
  })

  test('a child that ignores SIGTERM gets SIGKILL after the grace period', async () => {
    assert.equal(SSH_KILL_GRACE_MS, 2_000)
    await withTmp(async (dir) => {
      const pidFile = join(dir, 'pid')
      // The pid file is written once the SIGTERM handler is in place, and the abort waits for the file.
      const script = "process.on('SIGTERM',()=>{});require('fs').writeFileSync(process.argv[1],String(process.pid));setInterval(()=>{},1000)"
      const ctl = new AbortController()
      const call = nodeSshExec({ killGraceMs: 300 })(process.execPath, ['-e', script, pidFile], { input: '', timeoutMs: 30_000, signal: ctl.signal })
      const pid = await pidFrom(pidFile)
      ctl.abort()
      await new Promise((r) => setTimeout(r, 150))
      assert.equal(isAlive(pid), true) // SIGTERM came and was ignored; SIGKILL is not due yet
      const out = await call
      assert.equal(out.timedOut, true)
      assert.equal(out.code, null)
      assert.equal(await gone(pid), true)
    })
  })

  test('a process left holding the pipes after the child exits does not keep the call open', async () => {
    await withTmp(async (dir) => {
      const pidFile = join(dir, 'pid')
      const started = Date.now()
      const out = await nodeSshExec({ killGraceMs: 100 })('/bin/sh', ['-c', 'echo out; sleep 30 & echo $! > "$1"; exit 0', 'sh', pidFile],
        { input: '', timeoutMs: 20_000 })
      const pid = Number(readFileSync(pidFile, 'utf8'))
      try {
        assert.deepEqual(out, { code: 0, stdout: 'out\n', stderr: '', timedOut: false })
        assert.ok(Date.now() - started < 5_000, `${Date.now() - started}`)
      } finally {
        if (isAlive(pid)) process.kill(pid, 'SIGKILL')
      }
    })
  })

  test('a child that exits but never closes is settled after the release wait', async () => {
    const fake = fakeChild()
    const started = Date.now()
    const call = nodeSshExec({ killGraceMs: 20, spawn: fake.spawn })('/nonexistent/fake-child', [], { input: '', timeoutMs: 20_000 })
    fake.child.stdout.write('out\n')
    await new Promise((r) => setTimeout(r, 10))
    fake.exit(0)
    assert.deepEqual(await call, { code: 0, stdout: 'out\n', stderr: '', timedOut: false })
    assert.ok(Date.now() - started < 5_000, `${Date.now() - started}`)
    assert.equal(fake.child.stdout.destroyed, true)
    assert.deepEqual(fake.kills, [])
  })

  test('a child that never exits is settled after SIGKILL, the grace and the release wait', async () => {
    const fake = fakeChild()
    const started = Date.now()
    const call = nodeSshExec({ killGraceMs: 20, spawn: fake.spawn })('/nonexistent/fake-child', [], { input: '', timeoutMs: 30 })
    fake.child.stdout.write('partial\n')
    fake.child.stderr.write('err\n')
    assert.deepEqual(await call, { code: null, stdout: 'partial\n', stderr: 'err\n', timedOut: true })
    assert.deepEqual(fake.kills, ['SIGTERM', 'SIGKILL'])
    assert.ok(Date.now() - started >= 85, `${Date.now() - started}`)
  })

  test('stdout over the cap is overflow and kills the child', async () => {
    await withTmp(async (dir) => {
      const pidFile = join(dir, 'pid')
      const out = await nodeSshExec({ stdoutMax: 10 })('/bin/sh', ['-c', 'echo $$ > "$1"; head -c 100 /dev/zero; exec sleep 30', 'sh', pidFile],
        { input: '', timeoutMs: 5_000 })
      assert.equal(out.overflow, true)
      assert.equal(out.timedOut, false)
      assert.ok(out.stdout.length <= 10, `${out.stdout.length}`)
      assert.equal(await gone(Number(readFileSync(pidFile, 'utf8'))), true)
    })
  })

  test('stderr over its cap is cut, without killing the child', async () => {
    const out = await nodeSshExec({ stderrMax: 10 })('/bin/sh', ['-c', 'printf "%0100d" 0 >&2; echo done'], { input: '', timeoutMs: 5_000 })
    assert.deepEqual(out, { code: 0, stdout: 'done\n', stderr: '0000000000', timedOut: false })
  })

  test('a missing file is a spawn error', async () => {
    const out = await exec('/nonexistent/ssh-xyz', ['-T'], { input: 'echo hi\n', timeoutMs: 5_000 })
    assert.equal(out.code, null)
    assert.equal(out.timedOut, false)
    assert.ok(out.spawnError?.includes('ENOENT'), out.spawnError)
  })

  test('an abort kills the child', async () => {
    await withTmp(async (dir) => {
      const pidFile = join(dir, 'pid')
      const ctl = new AbortController()
      setTimeout(() => ctl.abort(), 200)
      const out = await exec('/bin/sh', ['-c', 'echo $$ > "$1"; exec sleep 30', 'sh', pidFile], { input: '', timeoutMs: 10_000, signal: ctl.signal })
      assert.equal(out.timedOut, true)
      assert.equal(await gone(Number(readFileSync(pidFile, 'utf8'))), true)
    })
  })

  test('an already aborted signal starts nothing', async () => {
    const ctl = new AbortController()
    ctl.abort()
    const out = await exec('/nonexistent/ssh-xyz', [], { input: '', timeoutMs: 5_000, signal: ctl.signal })
    assert.deepEqual(out, { code: null, stdout: '', stderr: '', timedOut: true })
  })
})
