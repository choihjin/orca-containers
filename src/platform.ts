export const BUNDLED_ORCA_CLI = '/Applications/Orca.app/Contents/Resources/bin/orca'
export const DOCKER_CANDIDATES = ['/usr/local/bin/docker', '/opt/homebrew/bin/docker', '/usr/bin/docker', '/snap/bin/docker']

export function isSupportedLocalPlatform(platform: string): boolean {
  return platform === 'darwin' || platform === 'linux'
}

// What the panel and the messages call the computer Orca runs on.
// The worker's names for the local host; the panel's catalog translates exactly these.
export type LocalHostLabel = 'This Mac' | 'This computer'
export function localName(platform: string): LocalHostLabel {
  return platform === 'darwin' ? 'This Mac' : 'This computer'
}

// The same name inside a sentence: "this Mac" / "this computer".
export function localNameInText(platform: string): string {
  return platform === 'darwin' ? 'this Mac' : 'this computer'
}

// The shell whose login startup files can tell where docker is: $SHELL when it is an absolute path to a POSIX shell
// that exists, else zsh, else sh. (A fish or csh login shell would not understand `-lc 'command -v docker'` the same way.)
const POSIX_SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh'])
export function loginShellFor(env: Record<string, string | undefined>, exists: (path: string) => boolean): string {
  const shell = env.SHELL
  if (shell && shell.startsWith('/') && POSIX_SHELLS.has(shell.slice(shell.lastIndexOf('/') + 1)) && exists(shell)) return shell
  return exists('/bin/zsh') ? '/bin/zsh' : '/bin/sh'
}

// `uname -s` of an SSH host: Linux, or Darwin for a Mac.
export function isSupportedRemoteKernel(kernel: string | null): boolean {
  return kernel === 'Linux' || kernel === 'Darwin'
}

// On Linux a bare `orca` is usually the GNOME screen reader (/usr/bin/orca); Orca's own CLI there is `orca-ide`
// (the deb and rpm packages link it as /usr/bin/orca-ide). `platform` is required, so no caller can fall back to a
// bare `orca` on Linux by leaving it out.
export const LINUX_ORCA_CLI = '/usr/bin/orca-ide'
export function resolveOrcaCliPath(env: Record<string, string | undefined>, exists: (path: string) => boolean, platform: string): string {
  const fromEnv = env.ORCA_CLI_COMMAND
  if (fromEnv && exists(fromEnv)) return fromEnv
  if (platform === 'linux') return exists(LINUX_ORCA_CLI) ? LINUX_ORCA_CLI : 'orca-ide'
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
