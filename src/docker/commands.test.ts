import { assert, describe, test } from 'orca/testing'
import type { ComposeAction, ContainerAction, ResourceKind } from '../protocol'
import {
  InvalidInputError, SNAPSHOT_COMMANDS, actionCommand, composeCommand, composeLabelsCommand, composeUpArgv, isComposeAction, isComposePath,
  isComposeProject, isContainerId, isImageRef, logsCommand, pullArgv, removeCommand, terminalArgv, type ComposeTarget,
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

  describe('compose', () => {
    const ONE: ComposeTarget = { project: 'shop', dir: '/srv/shop', files: ['/srv/shop/compose.yml'] }
    const TWO: ComposeTarget = { project: 'ml_2-x', dir: '/home/me/ml', files: ['/home/me/ml/compose.yml', '/home/me/ml/compose.gpu.yml'] }
    const ACTIONS: readonly ComposeAction[] = ['start', 'stop', 'restart', 'down']

    test('project names follow Compose\'s normalized form: a lowercase letter or digit, then up to 62 of [a-z0-9_-]', () => {
      for (const good of ['shop', 'a', '0', 'ml_2-x', 'a'.repeat(63), 'orca-containers-test']) assert.equal(isComposeProject(good), true, good)
      for (const bad of [...HOSTILE, 'a'.repeat(64), 'Shop', '_shop', '-shop', 'sh.op', 'sh/op', 'sh:op', 'shöp', 'shop\n']) {
        assert.equal(isComposeProject(bad), false, JSON.stringify(bad))
      }
    })

    test('compose actions are start, stop, restart and down only', () => {
      for (const good of ACTIONS) assert.equal(isComposeAction(good), true, good)
      for (const bad of ['remove', 'rm', 'up', 'kill', 'pause', 'down -v', '', 'constructor', 'toString', '__proto__']) {
        assert.equal(isComposeAction(bad), false, bad)
      }
      // The worker checks raw request values with it.
      for (const bad of [5, null, undefined, {}, ['stop'], true]) assert.equal(isComposeAction(bad), false, JSON.stringify(bad))
    })

    test('compose paths: absolute, at most 1024 characters, no control character, backslash or line separator', () => {
      for (const good of ['/', '/srv/shop', `/${'a'.repeat(1023)}`, '/a b/c', "/it's", '/$(id)', '/a;b', '/-v', '/x/../y', '/ünï', '/a\u00a0b', '/a\u2027b', '/한글']) {
        assert.equal(isComposePath(good), true, JSON.stringify(good))
      }
      for (const bad of [
        '', 'srv/shop', './x', '-v', '--volumes', '~/x', `/${'a'.repeat(1024)}`, '/a\nb', '/a\u0000b', '/a\u001fb', '/a\u007fb', '/a\tb', ' /x',
        '/a\\b', "/a\\'b", '/a\\', '/a\u0080b', '/a\u0085b', '/a\u009bb', '/a\u009fb', '/a\u2028b', '/a\u2029b',
      ]) {
        assert.equal(isComposePath(bad), false, JSON.stringify(bad))
      }
    })

    test('the labels lookup is a fixed inspect of one member container', () => {
      const id = 'f'.repeat(64)
      assert.deepEqual(composeLabelsCommand(id), { name: 'labels', argv: ['inspect', '--format', '{{json .Config.Labels}}', id] })
      for (const bad of ['web', 'x; reboot', '', '-f', 'A'.repeat(12), 'a'.repeat(11), 'a'.repeat(65)]) refuses(() => composeLabelsCommand(bad), bad)
    })

    test('compose argv is exact for every action, with one file and with several', () => {
      for (const action of ACTIONS) {
        assert.deepEqual(composeCommand(ONE, action), {
          name: 'compose', timeoutSeconds: 55,
          argv: ['compose', '--project-directory', '/srv/shop', '-p', 'shop', '-f', '/srv/shop/compose.yml', action],
        }, action)
        assert.deepEqual(composeCommand(TWO, action).argv, [
          'compose', '--project-directory', '/home/me/ml', '-p', 'ml_2-x', '-f', '/home/me/ml/compose.yml', '-f', '/home/me/ml/compose.gpu.yml', action,
        ], action)
      }
    })

    test('down never removes volumes or images', () => {
      const argv = composeCommand(TWO, 'down').argv
      assert.equal(argv[argv.length - 1], 'down')
      for (const word of ['-v', '--volumes', '--rmi', '--remove-orphans']) assert.equal(argv.includes(word), false, word)
    })

    test('up argv is docker compose ... up -d', () => {
      assert.deepEqual(composeUpArgv(ONE), ['docker', 'compose', '--project-directory', '/srv/shop', '-p', 'shop', '-f', '/srv/shop/compose.yml', 'up', '-d'])
      assert.deepEqual(composeUpArgv(TWO), [
        'docker', 'compose', '--project-directory', '/home/me/ml', '-p', 'ml_2-x', '-f', '/home/me/ml/compose.yml', '-f', '/home/me/ml/compose.gpu.yml', 'up', '-d',
      ])
    })

    // Review Focus 1: a path with spaces, quotes or shell syntax stays one argument after its flag.
    test('awkward but absolute paths stay single arguments after their flags', () => {
      const target: ComposeTarget = { project: 'shop', dir: "/srv/my shop/it's", files: ['/srv/$(id)/a;b.yml', '/srv/-v/c.yml'] }
      assert.deepEqual(composeCommand(target, 'stop').argv, [
        'compose', '--project-directory', "/srv/my shop/it's", '-p', 'shop', '-f', '/srv/$(id)/a;b.yml', '-f', '/srv/-v/c.yml', 'stop',
      ])
    })

    test('compose refuses a bad action, project, directory or file list', () => {
      for (const bad of ['remove', 'up', 'down -v', 'constructor', '__proto__', '']) refuses(() => composeCommand(ONE, bad as ComposeAction), bad)
      const bads: [string, ComposeTarget][] = [
        ['project', { ...ONE, project: 'Shop' }],
        ['project option', { ...ONE, project: '-v' }],
        ['relative dir', { ...ONE, dir: 'srv/shop' }],
        ['option dir', { ...ONE, dir: '--volumes' }],
        ['dir with a newline', { ...ONE, dir: '/srv\n/shop' }],
        ['no files', { ...ONE, files: [] }],
        ['17 files', { ...ONE, files: Array.from({ length: 17 }, (_, i) => `/srv/${i}.yml`) }],
        ['relative file', { ...ONE, files: ['/srv/a.yml', 'b.yml'] }],
        ['long file', { ...ONE, files: [`/${'a'.repeat(1024)}`] }],
        ['file with a control character', { ...ONE, files: ['/srv/a\u0007.yml'] }],
        ['dir with a backslash', { ...ONE, dir: '/srv/sh\\op' }],
        ['file with a backslash and a quote', { ...ONE, files: ["/srv/a\\'b.yml"] }],
        ['file with a C1 control', { ...ONE, files: ['/srv/a\u009b.yml'] }],
        ['dir with U+2028', { ...ONE, dir: '/srv/\u2028x' }],
        ['file with U+2029', { ...ONE, files: ['/srv/a.yml', '/srv/\u2029b.yml'] }],
      ]
      for (const [label, target] of bads) {
        refuses(() => composeCommand(target, 'stop'), label)
        refuses(() => composeUpArgv(target), `up ${label}`)
      }
      assert.equal(composeCommand({ ...ONE, files: Array.from({ length: 16 }, (_, i) => `/srv/${i}.yml`) }, 'stop').argv.length, 5 + 32 + 1)
    })
  })
})
