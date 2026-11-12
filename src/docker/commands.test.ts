import { assert, describe, test } from 'orca/testing'
import type { ContainerAction, ResourceKind } from '../protocol'
import {
  InvalidInputError, SNAPSHOT_COMMANDS, actionCommand, isContainerId, isImageRef, logsCommand, pullArgv, removeCommand, terminalArgv,
} from './commands'

const isInvalid = (e: unknown): boolean => e instanceof InvalidInputError
// Like assert.throws(fn, isInvalid), and says which value got through.
function refuses(fn: () => unknown, label: string): void {
  let error: unknown = null
  try {
    fn()
  } catch (e) {
    error = e
  }
  assert.equal(isInvalid(error), true, label)
}

const HEX64 = '0123456789abcdef'.repeat(4)
const DIGEST = `sha256:${HEX64}`
// Review Focus 1: nothing from the panel may reach docker as an option or as a second argument.
const HOSTILE = [
  '', '-f', '--force', '-', 'nginx -f', 'a b', ' nginx', 'nginx ', 'a;b', 'nginx;reboot', '$(id)', 'a$(id)', '`id`', 'a\nb', 'nginx\n',
  'a\tb', '..', '../x', 'a/../b', `a@b@${DIGEST}`, `nginx@${DIGEST}@${DIGEST}`, "a'b", 'a"b', 'a|b', 'a&b', 'a>b',
  'a\\b', 'a*b', 'a\u0000b',
]
const KINDS: readonly ResourceKind[] = ['image', 'volume', 'network']

describe('docker commands', () => {
  test('snapshot commands are fixed', () => {
    assert.deepEqual(SNAPSHOT_COMMANDS.map((c) => c.argv), [
      ['version', '--format', '{{json .}}'],
      ['ps', '-a', '--no-trunc', '--format', '{{json .}}'],
      ['images', '--no-trunc', '--format', '{{json .}}'],
      ['volume', 'ls', '--format', '{{json .}}'],
      ['network', 'ls', '--no-trunc', '--format', '{{json .}}'],
    ])
    assert.deepEqual(SNAPSHOT_COMMANDS.map((c) => c.name), ['version', 'ps', 'images', 'volumes', 'networks'])
  })

  test('container ids are 12 to 64 lowercase hex characters', () => {
    assert.equal(isContainerId('a'.repeat(12)), true)
    assert.equal(isContainerId('a'.repeat(64)), true)
    for (const bad of ['a'.repeat(11), 'a'.repeat(65), 'ABCDEF123456', "abc123abc123'; rm", 'web', 'abc123abc123\n']) {
      assert.equal(isContainerId(bad), false)
    }
  })

  test('actions map to fixed argv and refuse bad ids', () => {
    const id = 'f'.repeat(64)
    assert.deepEqual(actionCommand('start', id).argv, ['start', id])
    assert.deepEqual(actionCommand('stop', id).argv, ['stop', id])
    assert.deepEqual(actionCommand('restart', id).argv, ['restart', id])
    assert.deepEqual(actionCommand('remove', id).argv, ['rm', id])
    assert.equal(actionCommand('start', id).name, 'action')
    assert.throws(() => actionCommand('stop', 'x; reboot'), isInvalid)
    for (const bad of ['constructor', 'toString', '__proto__']) {
      assert.throws(() => actionCommand(bad as ContainerAction, id), isInvalid)
    }
  })

  test('logs command is fixed and refuses bad ids', () => {
    const id = 'f'.repeat(12)
    assert.deepEqual(logsCommand(id), { name: 'logs', argv: ['logs', '--tail', '200', id] })
    for (const bad of ['web', 'x; reboot', '', '-f', 'A'.repeat(12)]) assert.throws(() => logsCommand(bad), isInvalid)
  })

  test('terminal argv', () => {
    const id = 'f'.repeat(12)
    assert.deepEqual(terminalArgv('logs', id), ['docker', 'logs', '-f', '--tail', '200', id])
    assert.deepEqual(terminalArgv('shell', id), ['docker', 'exec', '-it', id, 'sh', '-c', 'command -v bash >/dev/null 2>&1 && exec bash || exec sh'])
    assert.throws(() => terminalArgv('logs', 'web'), isInvalid)
  })

  test('image references: 1 to 255 safe characters, no "..", at most one "@" and only for a sha256 digest at the end', () => {
    for (const good of [
      'nginx', 'repo:tag', 'nginx:1.27', 'ghcr.io/org/app:1.2', 'localhost:5000/x', `name@${DIGEST}`, `ghcr.io/org/app:1.2@${DIGEST}`,
      'a', 'A'.repeat(255), 'my_repo/app-name.v2:Tag_1', 'abcdef123456',
    ]) {
      assert.equal(isImageRef(good), true, good)
    }
    for (const bad of [
      ...HOSTILE, 'A'.repeat(256), 'nginx..latest', 'org/../app', '_nginx', '.nginx', '/nginx', ':tag', '@sha256', `@${DIGEST}`, 'nginx@latest', 'nginx@sha256:abc',
      `nginx@sha256:${HEX64.toUpperCase()}`, `nginx@sha256:${HEX64}0`, `nginx@sha512:${HEX64}`, `nginx@${DIGEST}:tag`, 'ngïnx', 'nginx:1.2 ',
    ]) {
      assert.equal(isImageRef(bad), false, JSON.stringify(bad))
    }
  })

  test('remove argv is fixed for each kind and never forces', () => {
    const id = 'f'.repeat(64)
    assert.deepEqual(removeCommand('image', DIGEST), { name: 'remove', argv: ['image', 'rm', DIGEST] })
    assert.deepEqual(removeCommand('image', 'abcdef123456'), { name: 'remove', argv: ['image', 'rm', 'abcdef123456'] })
    assert.deepEqual(removeCommand('image', 'nginx:1.27'), { name: 'remove', argv: ['image', 'rm', 'nginx:1.27'] })
    assert.deepEqual(removeCommand('volume', 'pgdata'), { name: 'remove', argv: ['volume', 'rm', 'pgdata'] })
    assert.deepEqual(removeCommand('network', id), { name: 'remove', argv: ['network', 'rm', id] })
    for (const command of [removeCommand('image', 'nginx'), removeCommand('volume', 'v'), removeCommand('network', 'a'.repeat(12))]) {
      assert.equal(command.argv.length, 3)
      assert.equal(command.argv.some((word) => word.startsWith('-')), false)
    }
  })

  test('image remove takes a sha256 id, a short id or a reference', () => {
    for (const good of [DIGEST, `sha256:${'a'.repeat(12)}`, HEX64, 'a'.repeat(12), 'repo:tag', 'ghcr.io/org/app:1.2', 'localhost:5000/x', `name@${DIGEST}`]) {
      assert.deepEqual(removeCommand('image', good).argv, ['image', 'rm', good])
    }
  })

  test('volume names follow Docker: a letter or digit, then up to 254 of letters, digits, "_", "." and "-"', () => {
    for (const good of ['pgdata', 'a', 'my_vol.1-x', '0'.repeat(255), HEX64]) assert.deepEqual(removeCommand('volume', good).argv, ['volume', 'rm', good])
    for (const bad of ['0'.repeat(256), '_v', '.v', 'a/b', 'a:b', `v@${DIGEST}`]) refuses(() => removeCommand('volume', bad), bad)
    for (const bad of ['nginx..latest', 'org/../app']) refuses(() => removeCommand('image', bad), bad)
  })

  test('network ids are 12 to 64 lowercase hex characters; names are not ids', () => {
    for (const good of ['a'.repeat(12), HEX64]) assert.deepEqual(removeCommand('network', good).argv, ['network', 'rm', good])
    for (const bad of ['a'.repeat(11), 'a'.repeat(65), 'A'.repeat(12), 'bridge', 'host', 'none', DIGEST]) {
      refuses(() => removeCommand('network', bad), bad)
    }
  })

  test('remove refuses every hostile value for every kind, and any other kind', () => {
    for (const kind of KINDS) {
      for (const bad of HOSTILE) refuses(() => removeCommand(kind, bad), `${kind} ${JSON.stringify(bad)}`)
    }
    for (const kind of ['container', 'images', 'constructor', 'toString', '__proto__', '']) {
      refuses(() => removeCommand(kind as ResourceKind, 'nginx'), kind)
    }
  })

  test('pull argv is fixed and takes only an image reference', () => {
    assert.deepEqual(pullArgv('nginx:latest'), ['docker', 'pull', 'nginx:latest'])
    assert.deepEqual(pullArgv(`name@${DIGEST}`), ['docker', 'pull', `name@${DIGEST}`])
    assert.deepEqual(pullArgv('localhost:5000/x'), ['docker', 'pull', 'localhost:5000/x'])
    for (const bad of [...HOSTILE, 'A'.repeat(256), 'nginx..latest', 'nginx@latest', DIGEST.replace(':', '@')]) refuses(() => pullArgv(bad), JSON.stringify(bad))
  })
})
