import { assert, describe, test } from 'orca/testing'
import type { ContainerAction } from '../protocol'
import { InvalidInputError, SNAPSHOT_COMMANDS, actionCommand, isContainerId, logsCommand, terminalArgv } from './commands'

const isInvalid = (e: unknown): boolean => e instanceof InvalidInputError

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
})
