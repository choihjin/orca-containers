import { execFile, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import type { DockerCommand } from '../docker/commands'
import type { CommandResult } from '../docker/parse'
import { DOCKER_CANDIDATES, loginShellFor } from '../platform'
import type { RunOptions } from '../protocol'

export type LocalExec = (file: string, args: string[], options: { timeoutMs: number; merge?: boolean }) =>
  Promise<{ code: number; stdout: string; stderr: string; timedOut: boolean }>
export type LocalDeps = {
  exec: LocalExec
  exists: (path: string) => boolean
  loginShellWhich: () => Promise<string | null>
  now: () => number
}
export const LOCAL_TIMEOUT_MS = 20_000
export type LocalRunner = { run(commands: readonly DockerCommand[], options: RunOptions): Promise<CommandResult[]> }

const MAX_BUFFER = 64 * 1024 * 1024
const WHICH_TIMEOUT_MS = 5_000

function toLines(text: string): string[] {
  if (text === '') return []
  const lines = text.split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  return lines
}

export function createLocalRunner(deps: LocalDeps): LocalRunner {
  let docker: string | null | undefined

  // Candidates are free; the login shell is only tried when its own timeout fits in the remaining budget.
  // skipped: presence is unknown because there was no time to look (not cached, reported as a timeout).
  async function resolveDocker(remaining: number): Promise<{ path: string | null; skipped: boolean }> {
    if (docker !== undefined) return { path: docker, skipped: false }
    const candidate = DOCKER_CANDIDATES.find((path) => deps.exists(path))
    if (candidate) return { path: (docker = candidate), skipped: false }
    if (remaining < WHICH_TIMEOUT_MS) return { path: null, skipped: true }
    const found = await deps.loginShellWhich()
    if (found) docker = found
    return { path: found, skipped: false }
  }

  return {
    async run(commands, options) {
      const results: CommandResult[] = []
      let resolved: { path: string | null; skipped: boolean } | undefined // once per run
      const timedOut = (name: string) => results.push({ name, code: 124, lines: [] })
      for (const command of commands) {
        if (options.signal?.aborted || options.deadline - deps.now() <= 0) {
          timedOut(command.name)
          continue
        }
        resolved ??= await resolveDocker(options.deadline - deps.now())
        // the lookup may have used up the budget, so look again before exec
        const remaining = options.deadline - deps.now()
        if (options.signal?.aborted || remaining <= 0 || resolved.skipped) {
          timedOut(command.name)
          continue
        }
        if (resolved.path === null) {
          results.push({ name: command.name, code: 127, lines: ['docker: command not found'] })
          continue
        }
        const out = await deps.exec(resolved.path, command.argv, {
          timeoutMs: Math.min(LOCAL_TIMEOUT_MS, remaining),
          ...(command.name === 'logs' ? { merge: true } : {}),
        })
        results.push({
          name: command.name,
          code: out.timedOut ? 124 : out.code,
          lines: [...toLines(out.stdout), ...toLines(out.stderr)],
        })
      }
      return results
    },
  }
}

type ExecResult = { code: number; stdout: string; stderr: string; timedOut: boolean }

export function execResultFromError(error: unknown, stdout: string, stderr: string): ExecResult {
  const e = error as { code?: unknown; killed?: boolean; signal?: string | null; message?: string }
  if (e.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
    return { code: 1, stdout: '', stderr: 'docker output exceeded 64 MiB', timedOut: false }
  }
  const timedOut = e.killed === true && e.signal === 'SIGTERM'
  const code = typeof e.code === 'number' ? e.code : 1
  return { code, stdout, stderr: stderr || (typeof e.code === 'string' ? (e.message ?? '') : ''), timedOut }
}

// One buffer for both pipes: chunks are kept in the order they arrive, so stdout and stderr lines stay interleaved.
export function createMergedOutput(maxBuffer: number): { add(chunk: Buffer | string): boolean; text(): string } {
  const chunks: Buffer[] = []
  let size = 0
  return {
    // false once the total would pass maxBuffer (the chunk is not kept)
    add(chunk) {
      const buffer = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk
      if (size + buffer.length > maxBuffer) return false
      chunks.push(buffer)
      size += buffer.length
      return true
    },
    text: () => Buffer.concat(chunks).toString('utf8'),
  }
}

export function runMerged(file: string, args: string[], timeoutMs: number, maxBuffer: number): Promise<ExecResult> {
  return new Promise<ExecResult>((resolve) => {
    const output = createMergedOutput(maxBuffer)
    let settled = false
    let timedOut = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const finish = (result: ExecResult) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(file, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) {
      finish(execResultFromError(error, '', ''))
      return
    }
    timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM') }, timeoutMs)
    const onData = (chunk: Buffer) => {
      if (settled || output.add(chunk)) return
      child.kill('SIGTERM')
      finish(execResultFromError({ code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' }, '', ''))
    }
    child.stdout?.on('data', onData)
    child.stderr?.on('data', onData)
    child.on('error', (error) => finish(execResultFromError(error, output.text(), '')))
    child.on('close', (code) => finish({ code: code ?? 1, stdout: output.text(), stderr: '', timedOut }))
  })
}

export function nodeLocalDeps(): LocalDeps {
  const run = (file: string, args: string[], timeoutMs: number, maxBuffer: number) =>
    new Promise<ExecResult>((resolve) => {
      execFile(file, args, { timeout: timeoutMs, maxBuffer, encoding: 'utf8' }, (error, stdout, stderr) => {
        resolve(error ? execResultFromError(error, stdout ?? '', stderr ?? '') : { code: 0, stdout, stderr, timedOut: false })
      })
    })
  return {
    exec: (file, args, { timeoutMs, merge }) =>
      merge ? runMerged(file, args, timeoutMs, MAX_BUFFER) : run(file, args, timeoutMs, MAX_BUFFER),
    exists: (path) => existsSync(path),
    async loginShellWhich() {
      const out = await run(loginShellFor(process.env, existsSync), ['-lc', 'command -v docker'], WHICH_TIMEOUT_MS, 1024 * 1024)
      const path = out.stdout.trim()
      return out.code === 0 && path !== '' ? path : null
    },
    now: Date.now,
  }
}
