import { ownTimeoutSeconds, type DockerCommand } from '../docker/commands'
import { shellCommand } from '../platform'

export const MARK = '__CTR_'

// `$T` is `timeout 20` when the host has `timeout`, else empty. A command with its own limit (compose: 55 s) gets
// `${T:+timeout <n>}`: `timeout <n>` when `timeout` exists, nothing otherwise.
function limitWord(command: DockerCommand): string {
  const seconds = ownTimeoutSeconds(command)
  return seconds === undefined ? '$T' : `\${T:+timeout ${seconds}}`
}

// BEGIN, one SEC ... RC section per command, END; `$M` and `$N` are set before. Each docker call reads /dev/null.
function runBody(commands: readonly DockerCommand[], candidates: readonly string[]): string[] {
  const lines = [
    'ts() { d=$(date +%s%N 2>/dev/null); case "$d" in *N|"") d=$(( $(date +%s) * 1000000000 ));; esac; echo "$d"; }',
    'rc() { echo "${M}RC_${N}__ $1 $2"; }',
    'T=; if command -v timeout >/dev/null 2>&1; then T="timeout 20"; fi',
    'D=$(command -v docker 2>/dev/null)',
    ...dockerFallback(candidates),
    'echo "${M}BEGIN_${N}__ $(ts)"',
  ]
  for (const command of commands) {
    const { name, argv } = command
    lines.push(
      `echo "\${M}SEC_\${N}__ ${name}"`,
      `if [ -n "$D" ]; then ${limitWord(command)} "$D" ${shellCommand(argv)} </dev/null 2>&1; rc ${name} $?; else echo "docker: command not found"; rc ${name} 127; fi`,
    )
  }
  lines.push('echo "${M}END_${N}__ $(ts)"')
  return lines
}

// Where docker lives when `command -v` cannot see it: a Mac reached over ssh gets sshd's short PATH
// (/usr/bin:/bin:/usr/sbin:/sbin), which misses Docker Desktop and Homebrew; snap installs on Linux too.
export const REMOTE_DOCKER_CANDIDATES: readonly string[] = [
  '/usr/local/bin/docker', '/opt/homebrew/bin/docker', '/Applications/Docker.app/Contents/Resources/bin/docker', '/snap/bin/docker',
]

function dockerFallback(candidates: readonly string[]): string[] {
  if (candidates.length === 0) return []
  return [`if [ -z "$D" ]; then for p in ${shellCommand(candidates)}; do if [ -f "$p" ] && [ -x "$p" ]; then D=$p; break; fi; done; fi`]
}

// The command typed into a Mac host's terminal. Its shell may not be a login shell, so /usr/local/bin (Docker Desktop)
// or /opt/homebrew/bin may be missing from PATH: look docker up as the ssh script does (PATH first, then the candidates)
// inside `sh -c`, then exec it with the original arguments. Its directory goes first in PATH, since Docker Desktop's
// credential helper sits beside it. `sh -c` keeps this one external command in any login shell.
export function macTerminalArgv(argv: readonly string[], candidates: readonly string[] = REMOTE_DOCKER_CANDIDATES): string[] {
  if (argv[0] !== 'docker') throw new Error('macTerminalArgv expects a docker command')
  const lookup = [
    `for p in "$(command -v docker 2>/dev/null)"${candidates.length > 0 ? ` ${shellCommand(candidates)}` : ''}; do`,
    'if [ -f "$p" ] && [ -x "$p" ]; then export PATH="${p%/*}:$PATH"; exec "$p" "$@"; fi; done;',
    'echo "docker: command not found" >&2; exit 127',
  ].join(' ')
  return ['sh', '-c', lookup, 'sh', ...argv.slice(1)]
}

// For `ssh <host> sh -s`: the script is the remote shell's stdin, so every docker call reads /dev/null and can never
// consume the rest of the script. The kernel comes first; off Linux and macOS the script stops before any docker command.
export function sshScript(nonce: string, commands: readonly DockerCommand[], candidates: readonly string[] = REMOTE_DOCKER_CANDIDATES): string {
  return [
    `M=${MARK}`,
    `N=${nonce}`,
    'K=$(uname -s 2>/dev/null)',
    'echo "${M}READY_${N}__ $K"',
    'case "$K" in Linux|Darwin) ;; *) exit 0 ;; esac',
    ...runBody(commands, candidates),
    '',
  ].join('\n')
}
