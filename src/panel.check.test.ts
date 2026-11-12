import { afterEach, assert, mockHost, mount, test, type TestPanel } from 'orca/testing'
// The `.ts` is needed: without it the loader reads `.check` as the file's extension.
import scenarios from './panel.check.ts'
import * as panel from './panel'

const REQUEST_NAMES = [
  'docker.action', 'docker.logs', 'docker.openTerminal', 'docker.pullTerminal', 'docker.removeResource', 'docker.snapshot', 'hosts.list',
  'hosts.matchFocus',
]

let view: TestPanel | undefined
afterEach(async () => {
  await view?.unmount()
  view = undefined
})

test('every check scenario stubs exactly the eight worker requests', () => {
  assert.deepEqual(Object.keys(scenarios).sort(), ['daemonDown', 'empty', 'local', 'resources', 'ssh', 'sshFailed'])
  for (const [name, scenario] of Object.entries(scenarios)) {
    const stubs = scenario.requests ?? {}
    assert.deepEqual(Object.keys(stubs).sort(), REQUEST_NAMES, name)
    for (const request of REQUEST_NAMES) assert.equal(typeof stubs[request], 'function', `${name} ${request}`)
  }
})

test('each check scenario draws the screen it is named for', async () => {
  // A summary line, or text the scenario must show.
  const expected: Record<keyof typeof scenarios, { line: string } | { text: string }> = {
    local: { line: 'Tree "Containers": 2 top-level item(s)' },
    ssh: { line: 'Tree "Containers": 2 top-level item(s)' },
    daemonDown: { line: 'EmptyState "Docker is not running"' },
    sshFailed: { line: 'EmptyState "SSH connection failed"' },
    empty: { text: 'No containers' },
    // This Mac with every section open, for the plugin page screenshots.
    resources: { line: 'Tree "Volumes": 1 top-level item(s)' },
  }
  for (const [name, want] of Object.entries(expected)) {
    const scenario = scenarios[name as keyof typeof scenarios]
    view = await mount(panel, { host: mockHost(scenario), persisted: scenario.persisted })
    const found = 'line' in want ? view.summary().includes(want.line) : view.find({ text: want.text }) !== null
    assert.ok(found, `${name}: ${view.summary().join(' | ')}`)
    if (name === 'ssh') {
      // One Compose project, drawn expanded, and one container of its own.
      const tree = { type: 'Tree', label: 'Containers' }
      assert.deepEqual(view.expandedOf(tree), ['project:ml'])
      const items = (view.find(tree)?.props.items ?? []) as readonly { key: string; children?: readonly unknown[] }[]
      assert.deepEqual(items.map((i) => [i.key, i.children?.length]), [['project:ml', 2], ['456789abcdef', undefined]])
    }
    if (name === 'sshFailed') {
      // GPU2 is ready and picked: the problem comes from ssh, not from the host list.
      const select = view.find({ label: 'Host' })
      assert.equal(select?.props.value, 'ssh:GPU2')
      assert.deepEqual(select?.props.options, [{ value: 'local', label: 'This Mac' }, { value: 'ssh:GPU2', label: 'GPU2 (SSH)' }])
    }
    assert.deepEqual(view.errors, [], name)
    assert.deepEqual(view.refusals, [], name)
    await view.unmount()
    view = undefined
  }
})

// `orca plugin check` and the plugin page shots paint with Orca's own UI language, so every scenario pins English.
test('every check scenario seeds the English language setting', () => {
  for (const [name, scenario] of Object.entries(scenarios)) assert.deepEqual(scenario.settings, { language: 'en' }, name)
})

test('every check scenario stays English under a Korean Orca', async () => {
  const hangul = /[가-힣]/
  for (const [name, scenario] of Object.entries(scenarios)) {
    view = await mount(panel, { host: mockHost(scenario), persisted: scenario.persisted, locale: 'ko-KR' })
    assert.equal(view.find({ type: 'Select' })?.label, 'Host', name)
    assert.equal(hangul.test(JSON.stringify(view.tree())), false, `${name}: ${view.summary().join(' | ')}`)
    assert.deepEqual(view.errors, [], name)
    await view.unmount()
    view = undefined
  }
})
