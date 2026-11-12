import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assert, describe, test } from 'orca/testing'
import { actionCommand, logsCommand, SNAPSHOT_COMMANDS, type DockerCommand } from '../docker/commands'
import { extractRun, readyInfo } from './markers'
import * as script from './script'
import { MARK, sshScript } from './script'

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

describe('ssh script', () => {
  test('starts with the nonce, the kernel line and the Linux gate, and has no IDLE line', () => {
    const lines = sshScript(NONCE, SNAPSHOT_COMMANDS).split('\n')
    assert.deepEqual(lines.slice(0, 5), [
      `M=${MARK}`,
      `N=${NONCE}`,
      'K=$(uname -s 2>/dev/null)',
      'echo "${M}READY_${N}__ $K"',
      '[ "$K" = Linux ] || exit 0',
    ])
    assert.equal(lines.some((l) => l.includes('IDLE')), false)
    // The marker text itself is only built at run time.
    assert.equal(lines.slice(1).some((l) => l.includes(MARK)), false)
  })

  test('every docker call reads /dev/null', () => {
    const text = sshScript(NONCE, [...SNAPSHOT_COMMANDS, actionCommand('stop', ID), logsCommand(ID)])
    const calls = text.split('\n').filter((l) => l.includes('"$D"'))
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
        const out = runOnStdin(shell, sshScript(NONCE, commands), tmp)
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

    test(`a kernel other than Linux stops before any docker command (${shell})`, () => {
      withFakeHost('Darwin', (tmp) => {
        const out = runOnStdin(shell, sshScript(NONCE, SNAPSHOT_COMMANDS), tmp)
        assert.equal(readyInfo(out, NONCE)?.kernel, 'Darwin')
        assert.equal(out.some((l) => l.includes(`${MARK}BEGIN_`)), false, out.join('\n'))
        assert.equal(existsSync(join(tmp, 'docker-calls')), false)
      })
    })
  }

  // The kernel check before an SSH terminal: READY, then BEGIN and END with nothing between, and no docker call.
  for (const shell of SHELLS) {
    test(`an empty command list runs no docker command and completes with no results (${shell})`, () => {
      withFakeHost('Linux', (tmp) => {
        const out = runOnStdin(shell, sshScript(NONCE, []), tmp)
        assert.equal(readyInfo(out, NONCE)?.kernel, 'Linux', out.join('\n'))
        assert.deepEqual(extractRun(out, NONCE), { complete: true, truncated: false, results: [] })
        assert.equal(existsSync(join(tmp, 'docker-calls')), false)
      })
    })
  }

  test('reports a missing docker per command over ssh', () => {
    withFakeHost('Linux', (tmp) => {
      const out = runOnStdin('sh', sshScript(NONCE, [{ name: 'version', argv: ['--version'] }, { name: 'ps', argv: ['ps'] }]), tmp)
      assert.deepEqual(extractRun(out, NONCE).results, [
        { name: 'version', code: 127, lines: ['docker: command not found'] },
        { name: 'ps', code: 127, lines: ['docker: command not found'] },
      ])
    }, false)
  })
})
