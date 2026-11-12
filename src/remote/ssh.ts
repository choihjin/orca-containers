import { spawn, type ChildProcess } from 'node:child_process'
import { InvalidInputError, type DockerCommand } from '../docker/commands'
import { cleanLabel, type CommandResult } from '../docker/parse'
import { isSupportedRemoteKernel } from '../platform'
import type { ProblemKind, Result, RunOptions } from '../protocol'
import { extractRun, readyInfo } from './markers'
import { sshScript, STARTUP_FILES, startupScript } from './script'

export type KeyValueStore = { get(key: string): Promise<unknown>; set(key: string, value: unknown): Promise<void>; delete(key: string): Promise<void> }
export const kernelKey = (env: string) => `kernel:${env}` // string: the kernel the host last reported

export const SSH_PATH = '/usr/bin/ssh', SSH_RUN_TIMEOUT_MS = 60_000, SSH_KILL_GRACE_MS = 2_000
export const SSH_STDOUT_MAX = 64 * 1024 * 1024, SSH_STDERR_MAX = 64 * 1024

// The Orca host name is the ssh destination. A leading letter or digit keeps it from being read as an ssh option
// (the `--` before it does too); the rest keeps out spaces, shell syntax and `user@`.
const HOST_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/
const NONCE_RE = /^[0-9a-f]{8}$/
const STDERR_LINE_MAX = 200
// Whole escape sequences first (CSI; OSC up to BEL, ESC \ or the text's end; the other ESC sequences; the one-byte
// C1 CSI), then any C0/C1 control character left: the same patterns as the panel's log view.
const ESCAPES = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b[ -/]*[0-~]|\x9b[0-?]*[ -/]*[@-~]/g
const CONTROLS = /[\x00-\x1f\x7f-\x9f]/g
// For text from the host name, ssh's stderr or the remote kernel that goes into a message.
const cleanText = (text: string, max: number): string => cleanLabel(text.replace(ESCAPES, '').replace(CONTROLS, ''), max)

// BatchMode refuses any prompt (and an unknown host key); StrictHostKeyChecking is left to the person's config.
const SSH_OPTIONS = [
  '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-o', 'ServerAliveInterval=10', '-o', 'ServerAliveCountMax=3',
  '-o', 'ClearAllForwardings=yes', '-o', 'ForwardAgent=no', '-o', 'ForwardX11=no', '-o', 'PermitLocalCommand=no',
  '-o', 'LogLevel=ERROR', '-T',
]

export function sshArgs(name: string): string[] {
  if (!HOST_NAME_RE.test(name)) throw new InvalidInputError(`"${cleanText(name, STDERR_LINE_MAX)}" cannot be used as an ssh host name.`)
  return [...SSH_OPTIONS, '--', name, 'sh -s']
}

export type SshExecResult = { code: number | null; stdout: string; stderr: string; timedOut: boolean; spawnError?: string; overflow?: boolean }
export type SshExec = (file: string, args: string[], o: { input: string; timeoutMs: number; signal?: AbortSignal }) => Promise<SshExecResult>
type Spawn = (file: string, args: string[], options: { stdio: ['pipe', 'pipe', 'pipe'] }) => ChildProcess
// Tests make the limits small and may hand in a fake child.
export type SshExecOptions = { stdoutMax?: number; stderrMax?: number; killGraceMs?: number; spawn?: Spawn }

// Keeps at most `max` bytes; add() is false when a chunk did not fit whole (the part that fit is kept).
function cappedBuffer(max: number): { add(chunk: Buffer): boolean; text(): string } {
  const chunks: Buffer[] = []
  let size = 0
  return {
    add(chunk) {
      const part = chunk.length <= max - size ? chunk : chunk.subarray(0, max - size)
      if (part.length > 0) {
        chunks.push(part)
        size += part.length
      }
      return part.length === chunk.length
    },
    text: () => Buffer.concat(chunks).toString('utf8'),
  }
}

// No shell on this Mac: the file is spawned with its argv, and the input goes to its stdin, which is then closed.
export function nodeSshExec(options: SshExecOptions = {}): SshExec {
  const { stdoutMax = SSH_STDOUT_MAX, stderrMax = SSH_STDERR_MAX, killGraceMs = SSH_KILL_GRACE_MS, spawn: start = spawn } = options
  return (file, args, { input, timeoutMs, signal }) => new Promise<SshExecResult>((resolve) => {
    if (signal?.aborted) {
      resolve({ code: null, stdout: '', stderr: '', timedOut: true })
      return
    }
    const stdout = cappedBuffer(stdoutMax)
    const stderr = cappedBuffer(stderrMax)
    let timedOut = false
    let overflow = false
    let settled = false
    let stopping = false
    let releasing = false
    const timers: ReturnType<typeof setTimeout>[] = []
    let child: ChildProcess
    const collected = (code: number | null): SshExecResult =>
      ({ code, stdout: stdout.text(), stderr: stderr.text(), timedOut, ...(overflow ? { overflow: true } : {}) })
    const finish = (result: SshExecResult) => {
      if (settled) return
      settled = true
      for (const timer of timers) clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      resolve(result)
    }
    // 'close' waits for every pipe, and a process ssh started (a ProxyCommand) may hold one after ssh is gone:
    // after `afterMs` the pipes are let go, and if 'close' still has not come one grace later, the call ends anyway.
    const release = (afterMs: number) => {
      if (releasing) return
      releasing = true
      timers.push(setTimeout(() => { child.stdout?.destroy(); child.stderr?.destroy() }, afterMs))
      timers.push(setTimeout(() => finish(collected(child.exitCode)), afterMs + killGraceMs))
    }
    // SIGTERM, then SIGKILL after the grace period, then the pipes one grace later.
    const stop = () => {
      if (stopping) return
      stopping = true
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM')
        timers.push(setTimeout(() => child.kill('SIGKILL'), killGraceMs))
      }
      release(2 * killGraceMs)
    }
    function onAbort() {
      if (!stopping) timedOut = true // not when an overflow already stopped it
      stop()
    }
    try {
      child = start(file, args, { stdio: ['pipe', 'pipe', 'pipe'] })
    } catch (error) {
      finish({ code: null, stdout: '', stderr: '', timedOut: false, spawnError: error instanceof Error ? error.message : String(error) })
      return
    }
    child.on('error', (error) => {
      // Only a failed start ends the call; a failed kill is followed by 'close' as usual.
      if (child.pid === undefined) finish({ code: null, stdout: '', stderr: '', timedOut: false, spawnError: error.message })
    })
    child.on('exit', () => release(killGraceMs))
    child.on('close', (code: number | null) => finish(collected(code)))
    child.stdout?.on('data', (chunk: Buffer) => {
      if (overflow || stdout.add(chunk)) return
      overflow = true
      stop()
    })
    child.stderr?.on('data', (chunk: Buffer) => { stderr.add(chunk) }) // past the cap is dropped; the run goes on
    child.stdin?.on('error', () => {}) // EPIPE when the child exits without reading all of it
    child.stdin?.end(input)
    timers.push(setTimeout(onAbort, timeoutMs))
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

// localName: how messages name the computer the ssh runs from (localNameInText: 'this Mac', or 'this computer' on Linux).
export type SshRunnerDeps = { exec: SshExec; storage: KeyValueStore; now: () => number; randomHex: () => string; sshPath?: string; localName: string }
export type SshRunner = {
  run(env: string, commands: readonly DockerCommand[], options: RunOptions): Promise<Result<CommandResult[]>>
  // Reads the host's login startup files (startupScript): the paths in $HOME of those that seem to start tmux, screen
  // or byobu, in STARTUP_FILES order, or null when the run finished without the scan's answer. It fails as a run with no
  // command does, so it also checks (and stores) the kernel.
  startupScan(env: string, options: RunOptions): Promise<Result<string[] | null>>
}

const fail = (kind: ProblemKind, message: string): Result<never> => ({ ok: false, problem: { kind, message } })
const unknownResult = () => fail('unknown-result', 'sent; result unknown')

// The scan's answer is its `startup` section of code 0. Only the scanned files' paths are kept, once each, in scan order.
function startupAnswer(results: readonly CommandResult[]): string[] | null {
  const section = results.find((r) => r.name === 'startup')
  if (section?.code !== 0) return null
  return STARTUP_FILES.filter((path) => section.lines.includes(path))
}

// ssh's own failure (exit 255 before the script said READY), told apart by its stderr.
function sshFailure(env: string, stderr: string, here: string): Result<never> {
  if (/Could not resolve hostname/.test(stderr)) {
    return fail('ssh-failed', `No ssh host named "${env}" on ${here}. Add a "Host ${env}" entry with key login to ~/.ssh/config.`)
  }
  if (/Permission denied|Host key verification failed|No more authentication methods|passphrase/i.test(stderr)) {
    return fail('ssh-failed', `ssh could not log in to "${env}" without a prompt. Run \`ssh ${env}\` once in a terminal on ${here} and use a key that needs no typing (ssh-agent).`)
  }
  const first = stderr.split('\n').map((line) => cleanText(line, Infinity).trim()).find((line) => line !== '')
  if (first === undefined) return fail('ssh-failed', `ssh to "${env}" failed with exit code 255.`)
  return fail('ssh-failed', `ssh to "${env}" failed: ${cleanText(first, STDERR_LINE_MAX - 1)}.`) // with the ellipsis, at most 200
}

export function createSshRunner(deps: SshRunnerDeps): SshRunner {
  const sshPath = deps.sshPath ?? SSH_PATH
  const here = deps.localName
  // Runs on one host may overlap: each run is its own ssh process with its own nonce. `script` builds the stdin from it;
  // `commands` are the docker commands in it.
  async function execute(
    env: string, commands: readonly DockerCommand[], script: (nonce: string) => string, options: RunOptions,
  ): Promise<Result<CommandResult[]>> {
    let args: string[]
    try {
      args = sshArgs(env)
    } catch (error) {
      if (error instanceof InvalidInputError) return fail('ssh-failed', error.message)
      throw error
    }
    const remaining = options.deadline - deps.now()
    if (options.signal?.aborted || remaining <= 0) return fail('timeout', 'The request ran out of time before ssh started')
    const nonce = deps.randomHex()
    if (!NONCE_RE.test(nonce)) throw new Error('randomHex must return 8 lowercase hex digits')

    const out = await deps.exec(sshPath, args, {
      input: script(nonce),
      timeoutMs: Math.min(SSH_RUN_TIMEOUT_MS, remaining),
      ...(options.signal ? { signal: options.signal } : {}),
    })
    if (out.spawnError !== undefined) return fail('ssh-failed', `The ssh command could not start on ${here}: ${out.spawnError}.`)

    const lines = out.stdout.split('\n')
    const ready = readyInfo(lines, nonce)
    const run = extractRun(lines, nonce)
    // We ended it (deadline or abort), not ssh; its stderr and exit code then say nothing about ssh.
    const stopped = out.timedOut || options.signal?.aborted === true
    // Once the script could have reached it, an unfinished action, remove or compose may have been carried out.
    const maybeSent = !run.complete && commands.some((c) => c.name === 'action' || c.name === 'remove' || c.name === 'compose')
      && (ready !== null || stopped || out.overflow === true)
    if (out.overflow) return maybeSent ? unknownResult() : fail('truncated', `The output from "${env}" passed ${SSH_STDOUT_MAX / 1024 / 1024} MiB`)
    if (ready) {
      try {
        await deps.storage.set(kernelKey(env), ready.kernel)
      } catch {
        // best effort: the host list only loses this hint, the answer below stands
      }
      if (!isSupportedRemoteKernel(ready.kernel)) return fail('unsupported', `Remote kernel ${cleanText(ready.kernel, 64)} is not supported`)
    }
    if (run.complete) return { ok: true, value: run.results }
    if (maybeSent) return unknownResult()
    if (stopped) return fail('timeout', `The ssh session to "${env}" did not finish in time`)
    if (!ready && out.code === 255) return sshFailure(env, out.stderr, here)
    return fail('failed', `The ssh session to "${env}" ended before docker finished.`)
  }

  return {
    run: (env, commands, options) => execute(env, commands, (nonce) => sshScript(nonce, commands), options),
    // No docker command: it changes nothing on the host, so a run cut off is never unknown-result.
    async startupScan(env, options) {
      const ran = await execute(env, [], startupScript, options)
      return ran.ok ? { ok: true, value: startupAnswer(ran.value) } : ran
    },
  }
}
