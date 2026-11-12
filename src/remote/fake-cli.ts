// Test-only stand-in for the Orca CLI: scripted host listings and a call log.
import type { CallOptions, OrcaCli } from './orca-cli'

export type FakeCall =
  | { method: 'createTerminal'; environment: string; worktreePath: string; title: string; command: string; focus?: boolean }
  | { method: 'switchTo'; environment?: string; handle: string }
  | { method: 'listSshEnvironments'; timeoutMs?: number }
  | { method: 'listLocalTerminals'; timeoutMs?: number }
  | { method: 'listWorktrees'; environment: string; timeoutMs?: number }

const tick = () => new Promise<void>((resolve) => setImmediate(resolve))
const timeoutOf = (options?: CallOptions) => (options?.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs })

export class FakeCli implements OrcaCli {
  environments: string[] = []
  worktrees: Record<string, { path: string; displayName: string; branch: string }[]> = {}
  localTerminals: { handle: string; worktreePath: string }[] = []
  readonly calls: FakeCall[] = []
  private serial = 0

  async listSshEnvironments(options?: CallOptions) {
    this.calls.push({ method: 'listSshEnvironments', ...timeoutOf(options) })
    await tick()
    return [...this.environments]
  }
  async listWorktrees(environment: string, options?: CallOptions) {
    this.calls.push({ method: 'listWorktrees', environment, ...timeoutOf(options) })
    await tick()
    return [...(this.worktrees[environment] ?? [])]
  }
  async listLocalTerminals(options?: CallOptions) {
    this.calls.push({ method: 'listLocalTerminals', ...timeoutOf(options) })
    await tick()
    return [...this.localTerminals]
  }
  async createTerminal(o: { environment: string; worktreePath: string; title: string; command: string; focus?: boolean }) {
    this.calls.push({ method: 'createTerminal', ...o })
    await tick()
    return `term_${++this.serial}`
  }
  async switchTo(o: { environment?: string; handle: string }) {
    this.calls.push({ method: 'switchTo', ...o })
    await tick()
  }
}
