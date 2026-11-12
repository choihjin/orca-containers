export const BUNDLED_ORCA_CLI = '/Applications/Orca.app/Contents/Resources/bin/orca'
export const DOCKER_CANDIDATES = ['/usr/local/bin/docker', '/opt/homebrew/bin/docker', '/usr/bin/docker']

export function isSupportedLocalPlatform(platform: string): boolean {
  return platform === 'darwin'
}

export function isSupportedRemoteKernel(kernel: string | null): boolean {
  return kernel === 'Linux'
}

export function resolveOrcaCliPath(env: Record<string, string | undefined>, exists: (path: string) => boolean): string {
  const fromEnv = env.ORCA_CLI_COMMAND
  if (fromEnv && exists(fromEnv)) return fromEnv
  if (exists(BUNDLED_ORCA_CLI)) return BUNDLED_ORCA_CLI
  return 'orca'
}

export function shellQuote(word: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(word)) return word
  return `'${word.replaceAll("'", `'\\''`)}'`
}

export function shellCommand(argv: readonly string[]): string {
  return argv.map(shellQuote).join(' ')
}
