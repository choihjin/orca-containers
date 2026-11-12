import assert from 'node:assert/strict'
import { test } from 'node:test'
import { BUNDLED_ORCA_CLI, DOCKER_CANDIDATES, isSupportedLocalPlatform, isSupportedRemoteKernel, localName, localNameInText, loginShellFor, resolveOrcaCliPath, shellCommand, shellQuote } from './platform.ts'

test('macOS and Linux are supported local platforms', () => {
  assert.equal(isSupportedLocalPlatform('darwin'), true)
  assert.equal(isSupportedLocalPlatform('linux'), true)
  assert.equal(isSupportedLocalPlatform('win32'), false)
  assert.equal(isSupportedLocalPlatform('freebsd'), false)
})
test('the local host is called This Mac on macOS and This computer elsewhere', () => {
  assert.equal(localName('darwin'), 'This Mac')
  assert.equal(localName('linux'), 'This computer')
  assert.equal(localNameInText('darwin'), 'this Mac')
  assert.equal(localNameInText('linux'), 'this computer')
})
// On Linux a bare `orca` is usually the GNOME screen reader (/usr/bin/orca): Orca's own CLI there is `orca-ide`.
test('on Linux the Orca CLI is ORCA_CLI_COMMAND, else orca-ide, never a bare orca', () => {
  const all = () => true, none = () => false
  assert.equal(resolveOrcaCliPath({ ORCA_CLI_COMMAND: '/x/orca' }, all, 'linux'), '/x/orca')
  assert.equal(resolveOrcaCliPath({}, all, 'linux'), '/usr/bin/orca-ide') // the deb/rpm link, when it is there
  assert.equal(resolveOrcaCliPath({}, (p) => p === '/usr/bin/orca', 'linux'), 'orca-ide') // never /usr/bin/orca
  assert.equal(resolveOrcaCliPath({ ORCA_CLI_COMMAND: '/x/orca' }, none, 'linux'), 'orca-ide')
})
test('the login shell used to find docker is $SHELL when it is a POSIX shell that exists, else zsh, else sh', () => {
  const has = (...paths: string[]) => (p: string) => paths.includes(p)
  assert.equal(loginShellFor({ SHELL: '/bin/bash' }, has('/bin/bash', '/bin/zsh')), '/bin/bash')
  assert.equal(loginShellFor({ SHELL: '/usr/bin/fish' }, has('/usr/bin/fish', '/bin/zsh')), '/bin/zsh')
  assert.equal(loginShellFor({ SHELL: '/bin/bash' }, has('/bin/zsh')), '/bin/zsh')
  assert.equal(loginShellFor({}, has()), '/bin/sh')
  assert.equal(loginShellFor({ SHELL: 'bash' }, has('bash', '/bin/zsh')), '/bin/zsh') // not an absolute path
  assert.equal(loginShellFor({ SHELL: '/usr/local/bin/bash' }, has('/usr/local/bin/bash')), '/usr/local/bin/bash')
  assert.equal(loginShellFor({ SHELL: '/bin/csh' }, has('/bin/csh')), '/bin/sh')
})
test('local docker candidates, in lookup order', () => {
  assert.deepEqual([...DOCKER_CANDIDATES], ['/usr/local/bin/docker', '/opt/homebrew/bin/docker', '/usr/bin/docker', '/snap/bin/docker'])
})
test('Linux and macOS are supported remote kernels', () => {
  assert.equal(isSupportedRemoteKernel('Linux'), true)
  assert.equal(isSupportedRemoteKernel('Darwin'), true)
  assert.equal(isSupportedRemoteKernel('FreeBSD'), false)
  assert.equal(isSupportedRemoteKernel('linux'), false)
  assert.equal(isSupportedRemoteKernel(''), false)
  assert.equal(isSupportedRemoteKernel(null), false)
})
test('prefers ORCA_CLI_COMMAND, then the bundled CLI, then orca on PATH', () => {
  const all = () => true, none = () => false
  assert.equal(resolveOrcaCliPath({ ORCA_CLI_COMMAND: '/x/orca' }, all, 'darwin'), '/x/orca')
  assert.equal(resolveOrcaCliPath({}, all, 'darwin'), BUNDLED_ORCA_CLI)
  assert.equal(resolveOrcaCliPath({ ORCA_CLI_COMMAND: '/x/orca' }, none, 'darwin'), 'orca')
})
test('quotes words for a POSIX shell', () => {
  assert.equal(shellQuote('abc'), 'abc')
  assert.equal(shellQuote("it's"), `'it'\\''s'`)
  assert.equal(shellQuote(''), "''")
  assert.equal(shellCommand(['docker', 'exec', '-it', 'ab12', 'sh', '-c', 'a && b']), "docker exec -it ab12 sh -c 'a && b'")
})
