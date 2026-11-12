import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assert, describe, test } from 'orca/testing'
import { actionCommand, logsCommand, SNAPSHOT_COMMANDS, type DockerCommand } from '../docker/commands'
import { shellCommand } from '../platform'
import { extractRun, readyInfo } from './markers'
import * as script from './script'
import { MARK, macTerminalArgv, REMOTE_DOCKER_CANDIDATES, sshScript } from './script'

const NONCE = 'n1n1n1n1'
const SHELLS = ['sh', 'dash'].filter((name) => name === 'sh' || existsSync('/bin/dash'))

test('the session start line, launcher and session run script are gone', () => {
  for (const name of ['readyScript', 'sessionStart', 'launcher', 'runScript']) assert.equal(name in script, false, name)
})

// A temp PATH with a fake `uname` (prints `kernel`) and, unless `docker` is false, a fake `docker` that reads all of
// its stdin, notes the call in `docker-calls`, and prints its args one per line.
function withFakeHost<T>(kernel: string, body: (tmp: string) => T, docker = true): T {
  const tmp = mkdtempSync(join(tmpdir(), 'ctr-ssh-script-'))
  try {
    writeFileSync(join(tmp, 'uname'), `#!/bin/sh\necho ${kernel}\n`)
    chmodSync(join(tmp, 'uname'), 0o755)
    if (docker) {
      writeFileSync(join(tmp, 'docker'), '#!/bin/sh\ncat >/dev/null\necho "$1" >> "${0%/*}/docker-calls"\nfor a in "$@"; do echo "$a"; done\n')
      chmodSync(join(tmp, 'docker'), 0o755)
    }
    return body(tmp)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

// The script on stdin of `<shell> -s`, as ssh hands it to the remote `sh -s`.
const runOnStdin = (shell: string, script: string, tmp: string): string[] =>
  execFileSync(`/bin/${shell}`, ['-s'], { input: script, env: { PATH: `${tmp}:/usr/bin:/bin` } }).toString().split('\n')

const ID = 'a'.repeat(12)
// Tests that run the script never let it reach this Mac's real docker.
const NO_CANDIDATES: readonly string[] = []

describe('ssh script', () => {
  test('starts with the nonce, the kernel line and the Linux/macOS gate, and has no IDLE line', () => {
    const lines = sshScript(NONCE, SNAPSHOT_COMMANDS).split('\n')
    assert.deepEqual(lines.slice(0, 5), [
      `M=${MARK}`,
      `N=${NONCE}`,
      'K=$(uname -s 2>/dev/null)',
      'echo "${M}READY_${N}__ $K"',
      'case "$K" in Linux|Darwin) ;; *) exit 0 ;; esac',
    ])
    assert.equal(lines.some((l) => l.includes('IDLE')), false)
    // The marker text itself is only built at run time.
    assert.equal(lines.slice(1).some((l) => l.includes(MARK)), false)
  })

  test('every docker call reads /dev/null', () => {
    const text = sshScript(NONCE, [...SNAPSHOT_COMMANDS, actionCommand('stop', ID), logsCommand(ID)])
    const lines = text.split('\n').filter((l) => l.includes('"$D"'))
    const fallback = lines.filter((l) => l.startsWith('if [ -z "$D" ]'))
    const calls = lines.filter((l) => !l.startsWith('if [ -z "$D" ]'))
    assert.equal(fallback.length, 1)
    assert.equal(calls.length, SNAPSHOT_COMMANDS.length + 2)
    for (const line of calls) assert.match(line, /\$T "\$D" [^;]* <\/dev\/null 2>&1;/)
  })

  for (const shell of SHELLS) {
    test(`docker reading stdin does not consume the script (${shell})`, () => {
      withFakeHost('Linux', (tmp) => {
        const commands: DockerCommand[] = [
          { name: 'version', argv: ['--version'] },
          { name: 'ps', argv: ['ps', 'a b'] },
          { name: 'images', argv: ['images'] },
        ]
        const out = runOnStdin(shell, sshScript(NONCE, commands, NO_CANDIDATES), tmp)
        assert.equal(readyInfo(out, NONCE)?.kernel, 'Linux', out.join('\n'))
        assert.ok(out.some((l) => l.startsWith(`${MARK}END_${NONCE}__ `)), out.join('\n'))
        const run = extractRun(out, NONCE)
        assert.equal(run.complete, true)
        assert.equal(run.truncated, false)
        assert.deepEqual(run.results, [
          { name: 'version', code: 0, lines: ['--version'] },
          { name: 'ps', code: 0, lines: ['ps', 'a b'] },
          { name: 'images', code: 0, lines: ['images'] },
        ])
      })
    })

    test(`a kernel other than Linux or macOS stops before any docker command (${shell})`, () => {
      withFakeHost('FreeBSD', (tmp) => {
        const out = runOnStdin(shell, sshScript(NONCE, SNAPSHOT_COMMANDS, NO_CANDIDATES), tmp)
        assert.equal(readyInfo(out, NONCE)?.kernel, 'FreeBSD')
        assert.equal(out.some((l) => l.includes(`${MARK}BEGIN_`)), false, out.join('\n'))
        assert.equal(existsSync(join(tmp, 'docker-calls')), false)
      })
    })
  }

  // A Mac reached over ssh gets sshd's short PATH (/usr/bin:/bin:/usr/sbin:/sbin), so Docker Desktop's docker in
  // /usr/local/bin is not found by `command -v`: the script tries the candidate paths in order.
  for (const shell of SHELLS) {
    test(`a macOS host finds docker at a candidate path outside PATH (${shell})`, () => {
      withFakeHost('Darwin', (tmp) => {
        mkdirSync(join(tmp, 'alt'))
        writeFileSync(join(tmp, 'alt', 'docker'), '#!/bin/sh\ncat >/dev/null\nfor a in "$@"; do echo "$a"; done\n')
        chmodSync(join(tmp, 'alt', 'docker'), 0o755)
        const script = sshScript(NONCE, [{ name: 'version', argv: ['--version'] }], [join(tmp, 'missing', 'docker'), join(tmp, 'alt', 'docker')])
        const out = runOnStdin(shell, script, tmp)
        assert.equal(readyInfo(out, NONCE)?.kernel, 'Darwin', out.join('\n'))
        assert.deepEqual(extractRun(out, NONCE).results, [{ name: 'version', code: 0, lines: ['--version'] }])
      }, false)
    })
  }

  for (const shell of SHELLS) test(`docker on PATH wins over a candidate path (${shell})`, () => {
    withFakeHost('Linux', (tmp) => {
      mkdirSync(join(tmp, 'alt'))
      writeFileSync(join(tmp, 'alt', 'docker'), '#!/bin/sh\necho candidate\n')
      chmodSync(join(tmp, 'alt', 'docker'), 0o755)
      const out = runOnStdin(shell, sshScript(NONCE, [{ name: 'version', argv: ['--version'] }], [join(tmp, 'alt', 'docker')]), tmp)
      assert.deepEqual(extractRun(out, NONCE).results, [{ name: 'version', code: 0, lines: ['--version'] }])
    })
  })

  for (const shell of SHELLS) test(`a directory named docker is not taken for docker (${shell})`, () => {
    withFakeHost('Darwin', (tmp) => {
      mkdirSync(join(tmp, 'dir', 'docker'), { recursive: true })
      mkdirSync(join(tmp, 'alt'))
      writeFileSync(join(tmp, 'alt', 'docker'), '#!/bin/sh\ncat >/dev/null\nfor a in "$@"; do echo "$a"; done\n')
      chmodSync(join(tmp, 'alt', 'docker'), 0o755)
      const script = sshScript(NONCE, [{ name: 'version', argv: ['--version'] }], [join(tmp, 'dir', 'docker'), join(tmp, 'alt', 'docker')])
      assert.deepEqual(extractRun(runOnStdin(shell, script, tmp), NONCE).results, [{ name: 'version', code: 0, lines: ['--version'] }])
    }, false)
  })

  // The command typed into a Mac host's terminal: the same lookup (PATH, then the candidates), then exec with the args.
  test('the macOS terminal command wraps docker in an sh lookup and keeps every argument', () => {
    const argv = macTerminalArgv(['docker', 'exec', '-it', ID, 'sh', '-c', 'a && b'], ['/x/docker'])
    assert.deepEqual(argv.slice(0, 2), ['sh', '-c'])
    assert.deepEqual(argv.slice(3), ['sh', 'exec', '-it', ID, 'sh', '-c', 'a && b'])
    assert.match(argv[2] ?? '', /command -v docker/)
    assert.match(argv[2] ?? '', /\/x\/docker/)
    assert.throws(() => macTerminalArgv(['ls', '-l'], []), /docker/)
  })

  // Docker Desktop's credential helper (docker-credential-desktop) sits beside docker: the found docker's directory goes
  // first in PATH, or a pull would fail to find the helper.
  for (const shell of SHELLS) test(`the macOS terminal command finds docker outside PATH, puts its directory first in PATH and passes the args (${shell})`, () => {
    withFakeHost('Darwin', (tmp) => {
      mkdirSync(join(tmp, 'alt'))
      writeFileSync(join(tmp, 'alt', 'docker'), '#!/bin/sh\necho "PATH1=${PATH%%:*}"\nfor a in "$@"; do echo "$a"; done\n')
      chmodSync(join(tmp, 'alt', 'docker'), 0o755)
      const [file, ...args] = macTerminalArgv(['docker', 'pull', 'a b'], [join(tmp, 'missing'), join(tmp, 'alt', 'docker')]).map((a, i) => (i === 0 ? `/bin/${shell}` : a))
      const out = execFileSync(file ?? '', args, { env: { PATH: `${tmp}:/usr/bin:/bin` } }).toString()
      assert.equal(out, `PATH1=${join(tmp, 'alt')}\npull\na b\n`)
    }, false)
  })

  // As typed into the user's shell: one quoted line, unquoted once by that shell, then run by sh -c.
  const typedShells = ['/bin/sh', '/bin/zsh'].filter((path) => existsSync(path))
  for (const outer of typedShells) test(`the quoted macOS terminal line keeps awkward arguments through ${outer}`, () => {
    withFakeHost('Darwin', (tmp) => {
      // The fake docker is first on PATH, so no shell startup file can put a real docker ahead of it.
      writeFileSync(join(tmp, 'docker'), '#!/bin/sh\nfor a in "$@"; do echo "[$a]"; done\n')
      chmodSync(join(tmp, 'docker'), 0o755)
      const line = shellCommand(macTerminalArgv(['docker', 'exec', 'a b', "it's", '$HOME', '*', ''], NO_CANDIDATES))
      const args = outer.endsWith('zsh') ? ['-f', '-c', line] : ['-c', line]
      const out = execFileSync(outer, args, { cwd: tmp, env: { PATH: `${tmp}:/usr/bin:/bin`, HOME: '/nonexistent-home' } }).toString()
      assert.equal(out, "[exec]\n[a b]\n[it's]\n[$HOME]\n[*]\n[]\n")
    }, false)
  })

  for (const shell of SHELLS) test(`the macOS terminal command says docker is missing and exits 127 when nothing is found (${shell})`, () => {
    withFakeHost('Darwin', (tmp) => {
      const [, ...args] = macTerminalArgv(['docker', 'version'], [join(tmp, 'missing')])
      let status = 0
      let stderr = ''
      try {
        execFileSync(`/bin/${shell}`, args, { env: { PATH: `${tmp}:/usr/bin:/bin` }, stdio: ['ignore', 'pipe', 'pipe'] })
      } catch (error) {
        const e = error as { status?: number; stderr?: Buffer }
        status = e.status ?? 0
        stderr = e.stderr?.toString() ?? ''
      }
      assert.equal(status, 127)
      assert.match(stderr, /docker: command not found/)
    }, false)
  })

  test('the default candidate paths cover Docker Desktop on macOS, Homebrew and snap', () => {
    assert.deepEqual([...REMOTE_DOCKER_CANDIDATES], [
      '/usr/local/bin/docker', '/opt/homebrew/bin/docker', '/Applications/Docker.app/Contents/Resources/bin/docker', '/snap/bin/docker',
    ])
    const text = sshScript(NONCE, [])
    for (const path of REMOTE_DOCKER_CANDIDATES) assert.ok(text.includes(path), path)
  })

  // The kernel check before an SSH terminal: READY, then BEGIN and END with nothing between, and no docker call.
  for (const shell of SHELLS) {
    test(`an empty command list runs no docker command and completes with no results (${shell})`, () => {
      withFakeHost('Linux', (tmp) => {
        const out = runOnStdin(shell, sshScript(NONCE, [], NO_CANDIDATES), tmp)
        assert.equal(readyInfo(out, NONCE)?.kernel, 'Linux', out.join('\n'))
        assert.deepEqual(extractRun(out, NONCE), { complete: true, truncated: false, results: [] })
        assert.equal(existsSync(join(tmp, 'docker-calls')), false)
      })
    })
  }

  test('reports a missing docker per command over ssh', () => {
    withFakeHost('Linux', (tmp) => {
      const out = runOnStdin('sh', sshScript(NONCE, [{ name: 'version', argv: ['--version'] }, { name: 'ps', argv: ['ps'] }], NO_CANDIDATES), tmp)
      assert.deepEqual(extractRun(out, NONCE).results, [
        { name: 'version', code: 127, lines: ['docker: command not found'] },
        { name: 'ps', code: 127, lines: ['docker: command not found'] },
      ])
    }, false)
  })
})
