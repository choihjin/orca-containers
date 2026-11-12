import type { DockerCommand } from '../docker/commands'
import { shellCommand } from '../platform'

export const MARK = '__CTR_'

// BEGIN, one SEC ... RC section per command, END; `$M` and `$N` are set before. Each docker call reads /dev/null.
function runBody(commands: readonly DockerCommand[]): string[] {
  const lines = [
    'ts() { d=$(date +%s%N 2>/dev/null); case "$d" in *N|"") d=$(( $(date +%s) * 1000000000 ));; esac; echo "$d"; }',
    'rc() { echo "${M}RC_${N}__ $1 $2"; }',
    'T=; if command -v timeout >/dev/null 2>&1; then T="timeout 20"; fi',
    'D=$(command -v docker 2>/dev/null)',
    'echo "${M}BEGIN_${N}__ $(ts)"',
  ]
  for (const { name, argv } of commands) {
    lines.push(
      `echo "\${M}SEC_\${N}__ ${name}"`,
      `if [ -n "$D" ]; then $T "$D" ${shellCommand(argv)} </dev/null 2>&1; rc ${name} $?; else echo "docker: command not found"; rc ${name} 127; fi`,
    )
  }
  lines.push('echo "${M}END_${N}__ $(ts)"')
  return lines
}

// For `ssh <host> sh -s`: the script is the remote shell's stdin, so every docker call reads /dev/null and can never
// consume the rest of the script. The kernel comes first; off Linux the script stops before any docker command.
export function sshScript(nonce: string, commands: readonly DockerCommand[]): string {
  return [
    `M=${MARK}`,
    `N=${nonce}`,
    'K=$(uname -s 2>/dev/null)',
    'echo "${M}READY_${N}__ $K"',
    '[ "$K" = Linux ] || exit 0',
    ...runBody(commands),
    '',
  ].join('\n')
}
