import { assert, describe, test } from 'orca/testing'
import { buildSnapshot, classifyFailure, cleanLabel, type CommandResult } from './parse'

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

  test('cleans labels', () => {
    assert.equal(cleanLabel('web\u001b[31m', 200), 'web[31m')
    assert.equal(cleanLabel('x'.repeat(5), 3), 'xxx…')
    assert.equal(cleanLabel('a\u007fb\u0000c', 10), 'abc')
  })
})
