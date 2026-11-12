import assert from 'node:assert/strict'
import { test } from 'node:test'
import { BUNDLED_ORCA_CLI, isSupportedLocalPlatform, isSupportedRemoteKernel, resolveOrcaCliPath, shellCommand, shellQuote } from './platform.ts'

test('only macOS is a supported local platform', () => {
  assert.equal(isSupportedLocalPlatform('darwin'), true)
  assert.equal(isSupportedLocalPlatform('linux'), false)
  assert.equal(isSupportedLocalPlatform('win32'), false)
})
test('only Linux is a supported remote kernel', () => {
  assert.equal(isSupportedRemoteKernel('Linux'), true)
  assert.equal(isSupportedRemoteKernel('Darwin'), false)
  assert.equal(isSupportedRemoteKernel(null), false)
})
test('prefers ORCA_CLI_COMMAND, then the bundled CLI, then orca on PATH', () => {
  const all = () => true, none = () => false
  assert.equal(resolveOrcaCliPath({ ORCA_CLI_COMMAND: '/x/orca' }, all), '/x/orca')
  assert.equal(resolveOrcaCliPath({}, all), BUNDLED_ORCA_CLI)
  assert.equal(resolveOrcaCliPath({ ORCA_CLI_COMMAND: '/x/orca' }, none), 'orca')
})
test('quotes words for a POSIX shell', () => {
  assert.equal(shellQuote('abc'), 'abc')
  assert.equal(shellQuote("it's"), `'it'\\''s'`)
  assert.equal(shellQuote(''), "''")
  assert.equal(shellCommand(['docker', 'exec', '-it', 'ab12', 'sh', '-c', 'a && b']), "docker exec -it ab12 sh -c 'a && b'")
})
