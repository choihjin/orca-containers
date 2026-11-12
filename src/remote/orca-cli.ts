import { execFile } from 'node:child_process'

export type Exec = (file: string, args: string[], options: { timeoutMs: number }) => Promise<{ stdout: string }>

export class CliError extends Error {
  code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'CliError'
    this.code = code
  }
}

export type CallOptions = { timeoutMs?: number } // per call; the client's default otherwise
export type OrcaCli = {
  listSshEnvironments(options?: CallOptions): Promise<string[]>
  listWorktrees(environment: string, options?: CallOptions): Promise<{ path: string; displayName: string; branch: string }[]>
  listLocalTerminals(options?: CallOptions): Promise<{ handle: string; worktreePath: string }[]>
  createTerminal(o: { environment: string; worktreePath: string; title: string; command: string; focus?: boolean }): Promise<string>
  /** Brings a terminal to the front of the desktop app; without `environment` it is a terminal of this Mac. */
  switchTo(o: { environment?: string; handle: string }): Promise<void>
}

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null)
const bad = (what: string) => new CliError('cli_bad_reply', `Orca CLI reply is missing ${what}`)
const HANDLE_RE = /^term_[A-Za-z0-9-]{1,64}$/

export function createOrcaCli(cliPath: string, exec: Exec, timeoutMs = 30_000): OrcaCli {
  async function call(args: string[], options: CallOptions = {}): Promise<Obj> {
    let stdout: string
    try {
      ;({ stdout } = await exec(cliPath, [...args, '--json'], { timeoutMs: options.timeoutMs ?? timeoutMs }))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const code = isObj(error) && typeof error.code === 'string' ? error.code : 'cli_exec_failed'
      throw new CliError(code, message)
    }
    let reply: unknown
    try {
      reply = JSON.parse(stdout)
    } catch {
      throw new CliError('cli_not_json', 'Orca CLI output is not JSON')
    }
    if (!isObj(reply)) throw new CliError('cli_not_json', 'Orca CLI output is not a JSON object')
    if (reply.ok !== true) {
      const error = isObj(reply.error) ? reply.error : {}
      const code = str(error.code) ?? 'cli_error'
      throw new CliError(code, str(error.message) ?? code)
    }
    return isObj(reply.result) ? reply.result : {}
  }
  const rows = (result: Obj, key: string): Obj[] => {
    const value = result[key]
    if (!Array.isArray(value)) throw bad(key)
    return value.filter(isObj)
  }

  return {
    async listSshEnvironments(options) {
      const result = await call(['environment', 'list'], options)
      return rows(result, 'environments')
        .filter((row) => row.connectionDependency === 'ssh-tunnel')
        .flatMap((row) => (typeof row.name === 'string' ? [row.name] : []))
    },
    async listWorktrees(environment, options) {
      const result = await call(['worktree', 'list', '--environment', environment, '--limit', '500'], options)
      const scope = isObj(result.hostScope) ? result.hostScope : {}
      if (Array.isArray(scope.omittedHostIds) && scope.omittedHostIds.length > 0) {
        throw new CliError('host_not_covered', `Orca could not cover host ${environment}`)
      }
      return rows(result, 'worktrees').flatMap((row) =>
        typeof row.path === 'string'
          ? [{ path: row.path, displayName: str(row.displayName) ?? '', branch: str(row.branch) ?? '' }]
          : []
      )
    },
    async listLocalTerminals(options) {
      const result = await call(['terminal', 'list'], options)
      return rows(result, 'terminals').flatMap((row) =>
        typeof row.handle === 'string' ? [{ handle: row.handle, worktreePath: str(row.worktreePath) ?? '' }] : []
      )
    },
    async createTerminal(o) {
      const result = await call([
        'terminal', 'create', '--environment', o.environment, '--worktree', `path:${o.worktreePath}`,
        '--title', o.title, '--command', o.command, ...(o.focus ? ['--focus'] : [])
      ])
      const handle = isObj(result.terminal) ? str(result.terminal.handle) : null
      if (handle === null || !HANDLE_RE.test(handle)) throw bad('a valid terminal.handle')
      return handle
    },
    async switchTo(o) {
      await call(['terminal', 'switch', ...(o.environment ? ['--environment', o.environment] : []), '--terminal', o.handle], { timeoutMs: 5_000 })
    }
  }
}

export function nodeExec(): Exec {
  return (file, args, { timeoutMs }) =>
    new Promise((resolve, reject) => {
      execFile(file, args, { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 }, (error, stdout) => {
        const failure = error as (NodeJS.ErrnoException & { killed?: boolean; signal?: string | null }) | null
        const fail = (code: string, message: string) => reject(Object.assign(new Error(message), { code }))
        if (failure && (failure.killed === true || failure.signal)) fail('cli_timeout', `Orca CLI timed out after ${timeoutMs} ms`)
        else if (failure?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') fail('cli_output_too_large', 'Orca CLI output is too large')
        else if (stdout) resolve({ stdout })
        else reject(failure ?? new Error('Orca CLI produced no output'))
      })
    })
}
