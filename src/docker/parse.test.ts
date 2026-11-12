import { assert, describe, test } from 'orca/testing'
import { buildSnapshot, classifyFailure, cleanLabel, parseComposeTarget, type CommandResult } from './parse'

const ID = 'a'.repeat(64)
const VERSION = '{"Client":{"Version":"28.3.3"},"Server":{"Version":"28.3.3"}}'
const ok = (name: string, lines: string[] = []): CommandResult => ({ name, code: 0, lines })
const PS = JSON.stringify({ ID, Names: 'web', Image: 'nginx', State: 'running', Status: 'Up 2 hours', Ports: '80/tcp' })

function all(overrides: Partial<Record<string, CommandResult>> = {}): CommandResult[] {
  const base: Record<string, CommandResult> = {
    version: ok('version', [VERSION]),
    ps: ok('ps', [PS]),
    images: ok('images', [JSON.stringify({ ID: 'sha256:abc', Repository: 'nginx', Tag: 'latest', Size: '10MB', CreatedSince: '2 days ago' })]),
    volumes: ok('volumes', [JSON.stringify({ Name: 'data', Driver: 'local' })]),
    networks: ok('networks', [JSON.stringify({ ID: 'n1', Name: 'bridge', Driver: 'bridge', Scope: 'local' })]),
  }
  return Object.values({ ...base, ...overrides }).filter((r): r is CommandResult => r !== undefined)
}

describe('docker parsing', () => {
  test('builds a snapshot from docker JSON lines', () => {
    const r = buildSnapshot('local', 123, all())
    assert.equal(r.ok, true)
    if (!r.ok) return
    assert.equal(r.value.hostId, 'local')
    assert.equal(r.value.takenAt, 123)
    assert.equal(r.value.serverVersion, '28.3.3')
    assert.deepEqual(r.value.containers[0], { id: ID, name: 'web', image: 'nginx', state: 'running', status: 'Up 2 hours', ports: '80/tcp', project: '', service: '' })
    assert.deepEqual(r.value.images, [{ id: 'sha256:abc', repository: 'nginx', tag: 'latest', size: '10MB', createdSince: '2 days ago' }])
    assert.deepEqual(r.value.volumes, [{ name: 'data', driver: 'local' }])
    assert.deepEqual(r.value.networks, [{ id: 'n1', name: 'bridge', driver: 'bridge', scope: 'local' }])
  })

  describe('compose labels', () => {
    const withLabels = (labels?: string) =>
      buildSnapshot('local', 1, all({ ps: ok('ps', [JSON.stringify({ ID, Names: 'web', Image: 'nginx', State: 'running', Status: 'Up', Ports: '', ...(labels === undefined ? {} : { Labels: labels }) })]) }))

    test('reads compose project and service from labels', () => {
      const r = withLabels('com.docker.compose.project=shop,com.docker.compose.service=web,com.docker.compose.version=2.29')
      assert.equal(r.ok, true)
      if (!r.ok) return
      assert.equal(r.value.containers[0]?.project, 'shop')
      assert.equal(r.value.containers[0]?.service, 'web')
    })

    test('keeps containers without compose labels', () => {
      for (const labels of ['', undefined, 'maintainer=a,b', 'x.com.docker.compose.project=nope']) {
        const r = withLabels(labels)
        assert.equal(r.ok, true)
        if (!r.ok) return
        assert.equal(r.value.containers.length, 1)
        assert.equal(r.value.containers[0]?.project, '')
        assert.equal(r.value.containers[0]?.service, '')
      }
    })

    test('label values are cleaned like other labels', () => {
      const r = withLabels('com.docker.compose.project=sh\u0007op,com.docker.compose.service=web')
      assert.equal(r.ok, true)
      if (r.ok) assert.equal(r.value.containers[0]?.project, 'shop')
    })

    test('finds compose labels after a long run of other labels', () => {
      const r = withLabels(`${'k=v,'.repeat(100)}com.docker.compose.project=late,com.docker.compose.service=db`)
      assert.equal(r.ok, true)
      if (r.ok) assert.equal(r.value.containers[0]?.project, 'late')
    })
  })

  test('keeps rows and ignores non-JSON warning lines when the command succeeded', () => {
    const r = buildSnapshot('local', 1, all({ ps: ok('ps', ['WARNING: x', PS]) }))
    assert.equal(r.ok, true)
    if (r.ok) assert.equal(r.value.containers.length, 1)
  })

  test('a version without Server is daemon-down even with code 0', () => {
    const r = buildSnapshot('local', 1, all({ version: ok('version', ['{"Client":{"Version":"28.3.3"}}']) }))
    assert.equal(r.ok, false)
    if (!r.ok) assert.equal(r.problem.kind, 'daemon-down')
  })

  test('daemon-down from the local stdout-then-stderr order', () => {
    const version: CommandResult = {
      name: 'version', code: 1,
      lines: ['{"Client":{"Version":"28.3.3"}}', 'Cannot connect to the Docker daemon at unix:///x. Is the docker daemon running?'],
    }
    const r = buildSnapshot('local', 1, all({ version }))
    assert.equal(r.ok, false)
    if (!r.ok) assert.equal(r.problem.kind, 'daemon-down')
  })

  test('a failing command or a missing result fails the snapshot', () => {
    const bad = buildSnapshot('local', 1, all({ images: { name: 'images', code: 1, lines: ['boom'] } }))
    assert.deepEqual(bad.ok ? null : bad.problem, { kind: 'failed', message: 'boom' })
    const missing = buildSnapshot('local', 1, all({ networks: undefined }))
    assert.equal(missing.ok, false)
    const none = buildSnapshot('local', 1, [])
    assert.equal(none.ok, false)
  })

  test('classifies failures', () => {
    assert.equal(classifyFailure({ name: 'ps', code: 1, lines: ['permission denied while trying to connect to the Docker daemon socket'] }).kind, 'permission-denied')
    assert.equal(classifyFailure({ name: 'version', code: 127, lines: ['docker: command not found'] }).kind, 'docker-missing')
    assert.equal(classifyFailure({ name: 'ps', code: 124, lines: [] }).kind, 'timeout')
    assert.deepEqual(classifyFailure({ name: 'ps', code: 1, lines: ['{"a":1}', '', 'boom', 'more'] }), { kind: 'failed', message: 'boom' })
  })

  test('a failed message drops the daemon prefix before the 200-character cut, so the useful part survives', () => {
    const prefix = 'Error response from daemon: '
    const inUse = 'conflict: unable to remove repository reference "registry.example.com/platform-team/inference-gateway-service:2026.11.12-b4821"'
      + ' (must force) - container 0123456789ab is using its referenced image 5f1e6a2b0c3d'
    // With the prefix kept, the cut would fall before the reason.
    assert.equal(cleanLabel(prefix + inUse, 200).includes('is using its referenced image'), false)
    const problem = classifyFailure({ name: 'remove', code: 1, lines: [`  ${prefix}${inUse}`] })
    assert.equal(problem.kind, 'failed')
    assert.ok(problem.message.includes('is using its referenced image'), problem.message)
    assert.equal(problem.message, `${inUse.slice(0, 200)}…`)
    assert.deepEqual(classifyFailure({ name: 'remove', code: 1, lines: [`${prefix}No such image: nginx:9`] }), { kind: 'failed', message: 'No such image: nginx:9' })
    // Only a leading prefix goes; the kinds are decided as before.
    assert.deepEqual(classifyFailure({ name: 'remove', code: 1, lines: [`remove failed: ${prefix}x`] }), { kind: 'failed', message: `remove failed: ${prefix}x` })
    assert.equal(classifyFailure({ name: 'remove', code: 1, lines: [`${prefix}permission denied`] }).kind, 'permission-denied')
  })

  test('unknown container states become unknown', () => {
    const odd = JSON.stringify({ ID, Names: 'web', Image: 'nginx', State: 'weird', Status: '', Ports: '' })
    const r = buildSnapshot('local', 1, all({ ps: ok('ps', [odd]) }))
    assert.equal(r.ok && r.value.containers[0]?.state, 'unknown')
  })

  test('non-string fields become empty strings and labels are cleaned', () => {
    const odd = JSON.stringify({ ID, Names: 'we\u001bb', Image: 5, State: 'running' })
    const r = buildSnapshot('local', 1, all({ ps: ok('ps', [odd]) }))
    assert.equal(r.ok && r.value.containers[0]?.name, 'web')
    assert.equal(r.ok && r.value.containers[0]?.image, '')
  })

  // Compose prints its progress first and its error last: a failed compose shows the last meaningful line.
  test('from the end: the last non-empty, non-JSON line is the message; the kinds are decided as before', () => {
    const progress = [' Container shop-db-1  Starting', ' Container shop-db-1  Started', ' Container shop-web-1  Starting']
    const error = 'Error response from daemon: driver failed programming external connectivity on endpoint shop-web-1: Bind for 0.0.0.0:8080 failed: port is already allocated'
    const result = { name: 'compose', code: 1, lines: [...progress, error, '', '{"a":1}', '  '] }
    assert.deepEqual(classifyFailure(result, 'last'), {
      kind: 'failed', message: cleanLabel(error.slice('Error response from daemon: '.length), 200),
    })
    // The default still reads from the start.
    assert.deepEqual(classifyFailure(result), { kind: 'failed', message: 'Container shop-db-1  Starting' })
    assert.deepEqual(classifyFailure({ name: 'compose', code: 1, lines: [...progress, 'service "web" has no container to start'] }, 'last'),
      { kind: 'failed', message: 'service "web" has no container to start' })
    assert.deepEqual(classifyFailure({ name: 'compose', code: 3, lines: ['{"a":1}', ''] }, 'last'), { kind: 'failed', message: 'compose failed with exit code 3' })
    const kinds: [string[], number, string][] = [
      [[...progress, 'permission denied while trying to connect to the Docker daemon socket', 'see the docs'], 1, 'permission-denied'],
      [['Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?', 'more'], 1, 'daemon-down'],
      [['docker: command not found', 'x'], 1, 'docker-missing'],
      [['anything'], 127, 'docker-missing'],
      [['anything'], 124, 'timeout'],
    ]
    for (const [lines, code, kind] of kinds) {
      assert.equal(classifyFailure({ name: 'compose', code, lines }, 'last').kind, kind, kind)
      assert.equal(classifyFailure({ name: 'compose', code, lines }).kind, kind, kind)
    }
  })

  test('cleans labels', () => {
    assert.equal(cleanLabel('web\u001b[31m', 200), 'web[31m')
    assert.equal(cleanLabel('x'.repeat(5), 3), 'xxx…')
    assert.equal(cleanLabel('a\u007fb\u0000c', 10), 'abc')
  })

  describe('compose target from a member container\'s labels', () => {
    const PROJECT = 'com.docker.compose.project'
    const DIR = 'com.docker.compose.project.working_dir'
    const FILES = 'com.docker.compose.project.config_files'
    const labels = (o: Record<string, unknown> = {}): string => JSON.stringify({
      [PROJECT]: 'shop', [DIR]: '/srv/shop', [FILES]: '/srv/shop/compose.yml', 'com.docker.compose.service': 'web',
      'com.docker.compose.version': '2.35.1', ...o,
    })
    const NOT_MEMBER = { kind: 'failed', message: 'This container is not part of Compose project shop' }
    const NO_FILES = { kind: 'failed', message: "Compose did not record where this project's files are" }

    test('one file', () => {
      assert.deepEqual(parseComposeTarget('shop', [labels()]), { project: 'shop', dir: '/srv/shop', files: ['/srv/shop/compose.yml'] })
    })

    test('several files, split on commas, in order', () => {
      const files = '/srv/shop/compose.yml,/srv/shop/compose.override.yml,/etc/shop/extra.yml'
      assert.deepEqual(parseComposeTarget('shop', [labels({ [FILES]: files })]),
        { project: 'shop', dir: '/srv/shop', files: ['/srv/shop/compose.yml', '/srv/shop/compose.override.yml', '/etc/shop/extra.yml'] })
      const sixteen = Array.from({ length: 16 }, (_, i) => `/srv/${i}.yml`)
      assert.deepEqual(parseComposeTarget('shop', [labels({ [FILES]: sixteen.join(',') })]), { project: 'shop', dir: '/srv/shop', files: sixteen })
    })

    test('warning lines around the JSON are ignored, and surrounding spaces too', () => {
      assert.deepEqual(parseComposeTarget('shop', ['WARNING: something', '', `  ${labels()}  `, 'more']),
        { project: 'shop', dir: '/srv/shop', files: ['/srv/shop/compose.yml'] })
    })

    // Review Focus 1: no label value can become an option or a second command; awkward absolute paths are kept whole.
    test('absolute paths with spaces, quotes and shell syntax are kept whole', () => {
      const dir = "/srv/my shop/it's \"here\" $(id) `id`;x"
      const r = parseComposeTarget('shop', [labels({ [DIR]: dir, [FILES]: `${dir}/compose.yml,/srv/a b/-v.yml` })])
      assert.deepEqual(r, { project: 'shop', dir, files: [`${dir}/compose.yml`, '/srv/a b/-v.yml'] })
    })

    test('refused: not one JSON object of a member of this project', () => {
      const cases: [string, string[]][] = [
        ['no output', []],
        ['empty line', ['']],
        ['null (no labels)', ['null']],
        ['an array', ['["shop"]']],
        ['a string', ['"shop"']],
        ['not JSON', ['{com.docker.compose.project: shop}']],
        ['an error line', ['Error: No such object: aaaaaaaaaaaa']],
        ['two objects', [labels(), labels()]],
        ['no project label', [labels({ [PROJECT]: undefined })]],
        ['another project', [labels({ [PROJECT]: 'other' })]],
        ['a project that only differs in case', [labels({ [PROJECT]: 'Shop' })]],
        ['a project with a suffix', [labels({ [PROJECT]: 'shop ' })]],
        ['a project prefix', [labels({ [PROJECT]: 'sho' })]],
        ['a project that is not a string', [labels({ [PROJECT]: ['shop'] })]],
      ]
      for (const [label, lines] of cases) assert.deepEqual(parseComposeTarget('shop', lines), NOT_MEMBER, label)
    })

    test('refused: no usable record of the project files', () => {
      const long = `/${'a'.repeat(1024)}`
      const cases: [string, Record<string, unknown>][] = [
        ['no working_dir', { [DIR]: undefined }],
        ['empty working_dir', { [DIR]: '' }],
        ['relative working_dir', { [DIR]: 'srv/shop' }],
        ['working_dir that looks like an option', { [DIR]: '--volumes' }],
        ['working_dir over 1024 characters', { [DIR]: long }],
        ['working_dir with a newline', { [DIR]: '/srv/shop\n/etc' }],
        ['working_dir with a NUL', { [DIR]: '/srv/sh\u0000op' }],
        ['working_dir with DEL', { [DIR]: '/srv/sh\u007fop' }],
        ['working_dir not a string', { [DIR]: 5 }],
        ['no config_files', { [FILES]: undefined }],
        ['empty config_files', { [FILES]: '' }],
        ['config_files not a string', { [FILES]: ['/srv/shop/compose.yml'] }],
        ['a relative file', { [FILES]: 'compose.yml' }],
        ['a relative second file', { [FILES]: '/srv/shop/compose.yml,override.yml' }],
        ['a file that looks like an option', { [FILES]: '/srv/shop/compose.yml,-v' }],
        ['an empty entry', { [FILES]: '/srv/shop/compose.yml,,/srv/shop/b.yml' }],
        ['a trailing comma', { [FILES]: '/srv/shop/compose.yml,' }],
        ['17 files', { [FILES]: Array.from({ length: 17 }, (_, i) => `/srv/${i}.yml`).join(',') }],
        ['a file over 1024 characters', { [FILES]: `/srv/a.yml,${long}` }],
        ['a file with a newline', { [FILES]: '/srv/a.yml\n/etc/passwd' }],
        ['a file with a tab', { [FILES]: '/srv/a\t.yml' }],
        ['a file with an escape', { [FILES]: '/srv/\u001b[31ma.yml' }],
        // A backslash could end the single quotes of the typed Up command in fish; C1 controls and the Unicode line
        // and paragraph separators could break a terminal line.
        ['working_dir with a backslash', { [DIR]: '/srv/sh\\op' }],
        ['a file with a backslash', { [FILES]: "/srv/a\\'.yml" }],
        ['working_dir with a C1 control', { [DIR]: '/srv/sh\u0085op' }],
        ['a file with a C1 CSI', { [FILES]: '/srv/\u009b31ma.yml' }],
        ['a file with U+0080', { [FILES]: '/srv/a\u0080.yml' }],
        ['a file with U+009F', { [FILES]: '/srv/a\u009f.yml' }],
        ['working_dir with U+2028', { [DIR]: '/srv/sh\u2028op' }],
        ['a file with U+2029', { [FILES]: '/srv/a.yml,/srv/b\u2029.yml' }],
      ]
      for (const [label, o] of cases) assert.deepEqual(parseComposeTarget('shop', [labels(o)]), NO_FILES, label)
    })

    test('a path of exactly 1024 characters is accepted', () => {
      const edge = `/${'a'.repeat(1023)}`
      assert.deepEqual(parseComposeTarget('shop', [labels({ [DIR]: edge, [FILES]: edge })]), { project: 'shop', dir: edge, files: [edge] })
    })
  })
})
