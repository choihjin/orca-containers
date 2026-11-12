import { afterEach, assert, mockHost, mount, test, type TestPanel } from 'orca/testing'
// The `.ts` is needed: without it the loader reads `.check` as the file's extension.
import scenarios from './panel.check.ts'
import * as panel from './panel'

const REQUEST_NAMES = ['docker.action', 'docker.logs', 'docker.openTerminal', 'docker.snapshot', 'hosts.list', 'hosts.matchFocus']

let view: TestPanel | undefined
afterEach(async () => {
  await view?.unmount()
  view = undefined
})

test('every check scenario stubs exactly the six worker requests', () => {
  assert.deepEqual(Object.keys(scenarios).sort(), ['daemonDown', 'empty', 'local', 'ssh', 'unreachable'])
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
    unreachable: { line: 'EmptyState "Host unreachable"' },
    empty: { text: 'No containers' },
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
    assert.deepEqual(view.errors, [], name)
    assert.deepEqual(view.refusals, [], name)
    await view.unmount()
    view = undefined
  }
})
