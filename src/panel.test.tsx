import { mock } from 'node:test'
import { settings, type TreeItem } from 'orca'
import {
  afterEach, assert, hostError, mockHost, mount, test, type MockRequests, type MountOptions, type TestPanel, type TreeSnapshot,
} from 'orca/testing'
import type { ContainerRow, ContainerState, HostId, HostInfo, Result, Snapshot } from './protocol'
import * as panel from './panel'

const WEB = 'aaaaaaaaaaaa'
const DB = 'bbbbbbbbbbbb'
const TRAINER = 'cccccccccccc'
const STALE = 'dddddddddddd'
const SHOP_WEB = '111111111111'
const SHOP_DB = '222222222222'
const BLOG = '333333333333'

const container = (id: string, name: string, state: ContainerState, over: Partial<ContainerRow> = {}): ContainerRow => ({
  id, name, image: `${name}:latest`, state, status: state === 'running' ? 'Up 2 hours' : 'Exited (0) 1 hour ago', ports: '', project: '', service: '',
  ...over,
})
const snap = (hostId: HostId, containers: ContainerRow[]): Snapshot => ({
  hostId, takenAt: 1_000, serverVersion: '27.3.1', containers,
  images: [
    { id: 'sha256:1111', repository: 'nginx', tag: 'latest', size: '192MB', createdSince: '2 weeks ago' },
    { id: 'sha256:1111', repository: 'nginx', tag: 'stable', size: '192MB', createdSince: '2 weeks ago' },
  ],
  volumes: [{ name: 'pgdata', driver: 'local' }],
  networks: [{ id: 'eeeeeeeeeeee', name: 'bridge', driver: 'bridge', scope: 'local' }],
})
const ok = <T,>(value: T): { ok: true; value: T } => ({ ok: true, value })
const HOSTS: HostInfo[] = [
  { id: 'local', label: 'This Mac', kind: 'local', status: 'ready' },
  { id: 'ssh:GPU1', label: 'GPU1', kind: 'ssh', status: 'ready' },
]
const LOCAL = [container(WEB, 'web', 'running'), container(DB, 'db', 'exited')]
// A Compose project with two services, and one container of its own.
const COMPOSE = [
  container(SHOP_WEB, 'shop-web-1', 'running', { image: 'nginx:1.27', project: 'shop', service: 'web', ports: '0.0.0.0:8080->80/tcp' }),
  container(SHOP_DB, 'shop-db-1', 'exited', { image: 'postgres:16', project: 'shop', service: 'db' }),
  container(WEB, 'web', 'running'),
]

function requests(overrides: MockRequests = {}): MockRequests {
  return {
    'hosts.list': () => ok({ hosts: HOSTS }),
    'hosts.matchFocus': () => ok({ hostId: null }),
    'docker.snapshot': ({ hostId }) => ok(snap(hostId, hostId === 'local' ? LOCAL : [container(TRAINER, 'trainer', 'running')])),
    'docker.action': () => ok({ done: true as const }),
    'docker.openTerminal': () => ok({ opened: true as const, workspace: 'proj' }),
    'docker.logs': ({ containerId }) => ok({ lines: [`${containerId} started`, `${containerId} ready`], takenAt: 2_000 }),
    'docker.removeResource': () => ok({ done: true as const }),
    'docker.pullTerminal': () => ok({ opened: true as const, workspace: 'proj' }),
    ...overrides,
  }
}
const composeOnLocal: MockRequests = { 'docker.snapshot': ({ hostId }) => ok(snap(hostId, COMPOSE)) }
// What the daemon says when it refuses a restart (the worker drops docker's "Error response from daemon: ").
const RESTART_REFUSED = 'Cannot restart container aaaaaaaaaaaa: container is marked for removal and cannot be started'

type Sent = { name: string; input?: unknown; timeoutMs?: number }
let view: TestPanel | undefined
afterEach(async () => {
  await view?.unmount()
  view = undefined
  mock.timers.reset()
})

async function open(
  overrides: MockRequests = {},
  options: { settings?: Record<string, number>; persisted?: MountOptions['persisted'] } = {},
): Promise<TestPanel> {
  view = await mount(panel, { host: mockHost({ requests: requests(overrides), settings: options.settings }), persisted: options.persisted })
  return view
}
const sent = (v: TestPanel, name: string): Sent[] =>
  (v.host.callsOf('plugin.request') as Sent[]).filter((call) => call.name === name)
const CONTAINERS = { type: 'Tree', label: 'Containers' }
const HOST = { label: 'Host' }
const FILTER = { label: 'Filter' }
const section = (label: string) => ({ type: 'Collapsible', label })
const ACTIONS = ['start', 'stop', 'restart', 'logs', 'shell', 'delete']
const enabled = (v: TestPanel) => ACTIONS.filter((id) => v.find({ testId: id })?.disabled === false)
const itemsOf = (v: TestPanel, label: string): readonly TreeItem[] =>
  (v.find({ type: 'Tree', label })?.props.items ?? []) as readonly TreeItem[]
// Every key Orca draws in a Tree, in order: top-level items, each followed by its children.
const keysOf = (v: TestPanel, label = 'Containers'): string[] =>
  itemsOf(v, label).flatMap((item) => [item.key, ...(item.children ?? []).map((child) => child.key)])
// The labels of every Tree in the drawn tree, closed Collapsibles' content included.
function drawnTrees(v: TestPanel): string[] {
  const labels: string[] = []
  const walk = (node: TreeSnapshot | string | null | undefined): void => {
    if (node === null || node === undefined || typeof node === 'string') return
    if (node.type === 'Tree') labels.push(String(node.props?.label))
    for (const child of node.children ?? []) walk(child)
  }
  walk(v.tree())
  return labels
}
const card = (v: TestPanel) => v.find({ type: 'Card' })
const LOGS = { type: 'CodeView' }
const logCode = (v: TestPanel) => v.find(LOGS)?.props.code
const LOGS_TERMINAL = { testId: 'logs-terminal' }
// "Open in terminal" sits in the log view, which the Logs button opens.
async function openLogsTerminal(v: TestPanel): Promise<void> {
  if (v.find(LOGS_TERMINAL) === null) await v.press({ testId: 'logs' })
  await v.press(LOGS_TERMINAL)
}
type LogsAnswer = Result<{ lines: string[]; takenAt: number }>
const nextTurn = () => new Promise((resolve) => setImmediate(resolve))
const clean = (v: TestPanel) => {
  assert.deepEqual(v.errors, [])
  assert.deepEqual(v.refusals, [])
  assert.deepEqual(v.warnings, [])
}

test('shows local containers on first open', async () => {
  const v = await open({ 'docker.snapshot': ({ hostId }) => ok(snap(hostId, [container(WEB, 'web', 'running')])) })
  assert.ok(v.summary().includes('Tree "Containers": 1 top-level item(s)'), v.summary().join('\n'))
  assert.deepEqual(keysOf(v), [WEB])
  assert.equal(v.valueOf(HOST), 'local')
  assert.equal(v.valueOf({ label: 'Follow focused workspace' }), true)
  assert.deepEqual(sent(v, 'hosts.list').map((c) => c.input), [{ refresh: false }])
  assert.deepEqual(sent(v, 'docker.snapshot').map((c) => [c.input, c.timeoutMs]), [[{ hostId: 'local' }, 110_000]])
  assert.ok(v.find({ type: 'RelativeTime' }))
  clean(v)
})

test('shows the four sections with their counts, only Containers open', async () => {
  const v = await open()
  const shown = ['Containers', 'Images', 'Volumes', 'Networks'].map((label) => [
    label, v.find(section(label))?.props.description, v.valueOf(section(label)),
  ])
  assert.deepEqual(shown, [['Containers', '1 running / 2', true], ['Images', '2', false], ['Volumes', '1', false], ['Networks', '1', false]])
  const filter = v.find(FILTER)
  assert.deepEqual([filter?.type, filter?.props.labelHidden, filter?.props.type, filter?.props.placeholder], [
    'Input', true, 'search', 'Filter containers, images…',
  ])
  assert.deepEqual(v.summary(), ['Tree "Containers": 2 top-level item(s)'])
  clean(v)
})

test('shows images, volumes and networks as trees when their section opens', async () => {
  const v = await open()
  await v.toggle(section('Images'))
  assert.ok(v.summary().includes('Tree "Images": 1 top-level item(s)'), v.summary().join('\n'))
  assert.deepEqual(keysOf(v, 'Images'), ['repo:nginx', 'image:sha256:1111:latest', 'image:sha256:1111:stable'])
  await v.toggle(section('Volumes'))
  assert.deepEqual(keysOf(v, 'Volumes'), ['volume:pgdata'])
  await v.toggle(section('Networks'))
  assert.deepEqual(keysOf(v, 'Networks'), ['network:eeeeeeeeeeee'])
  for (const label of ['Containers', 'Images', 'Volumes', 'Networks']) assert.equal(v.find({ type: 'Tree', label })?.props.maxHeight, 'lg', label)
  clean(v)
})

test('collapsed sections render no tree', async () => {
  const v = await open()
  assert.deepEqual(drawnTrees(v), ['Containers'])
  await v.toggle(section('Images'))
  assert.deepEqual(drawnTrees(v), ['Containers', 'Images'])
  assert.deepEqual(v.persisted.plugin.sections, { containers: true, images: true, volumes: false, networks: false })
  await v.toggle(section('Images'))
  await v.toggle(section('Containers'))
  assert.deepEqual(drawnTrees(v), [])
  assert.deepEqual(v.persisted.plugin.sections, { containers: false, images: false, volumes: false, networks: false })
  clean(v)
})

test('opens the sections that were open last time', async () => {
  const v = await open({}, { persisted: { plugin: { sections: { containers: false, images: false, volumes: true, networks: false } } } })
  assert.deepEqual(drawnTrees(v), ['Volumes'])
  assert.equal(v.valueOf(section('Containers')), false)
  clean(v)
})

test('keeps a section closed when its stored value is not true', async () => {
  const v = await open({}, { persisted: { plugin: { sections: { containers: true, images: 'yes', volumes: 1 } } } })
  assert.deepEqual(drawnTrees(v), ['Containers'])
  assert.equal(v.valueOf(section('Images')), false)
  clean(v)
})

test('groups compose containers under an expanded project, then the other containers', async () => {
  const v = await open(composeOnLocal)
  assert.deepEqual(itemsOf(v, 'Containers').map((i) => [i.key, i.label, i.description, i.icon]), [
    ['project:shop', 'shop', 'compose · 1/2 running', 'layers'],
    [WEB, 'web', 'web:latest · Up 2 hours', 'play'],
  ])
  assert.deepEqual(keysOf(v), ['project:shop', SHOP_DB, SHOP_WEB, WEB])
  assert.deepEqual(v.expandedOf(CONTAINERS), ['project:shop'])
  assert.equal(v.find(section('Containers'))?.props.description, '2 running / 3')
  clean(v)
})

test('keeps a collapsed project collapsed and shows new projects expanded', async () => {
  let rows = COMPOSE
  const v = await open({ 'docker.snapshot': ({ hostId }) => ok(snap(hostId, rows)) })
  // The test kit seeds expandedOf from `expanded` once, then follows only its own toggles, so the
  // later checks read the `expanded` the panel hands Orca.
  const expandedProp = () => v.find(CONTAINERS)?.props.expanded
  await v.collapse(CONTAINERS, 'project:shop')
  assert.deepEqual(v.expandedOf(CONTAINERS), [])
  assert.deepEqual(expandedProp(), [])
  rows = [...COMPOSE, container(BLOG, 'blog-app-1', 'running', { project: 'blog', service: 'app' })]
  await v.press({ label: 'Refresh' })
  assert.deepEqual(keysOf(v), ['project:blog', BLOG, 'project:shop', SHOP_DB, SHOP_WEB, WEB])
  assert.deepEqual(expandedProp(), ['project:blog'])
  await v.expand(CONTAINERS, 'project:shop')
  assert.deepEqual([...(expandedProp() as string[])].sort(), ['project:blog', 'project:shop'])
  // Only projects the tree draws are handed over as expanded.
  await v.type(FILTER, 'blog')
  assert.deepEqual(keysOf(v), ['project:blog', BLOG])
  assert.deepEqual(expandedProp(), ['project:blog'])
  await v.type(FILTER, '', { replace: true })

  // Another host starts from every project expanded again.
  await v.collapse(CONTAINERS, 'project:shop')
  await v.select(HOST, 'ssh:GPU1')
  rows = COMPOSE
  await v.select(HOST, 'local')
  assert.deepEqual(expandedProp(), ['project:shop'])
  clean(v)
})

test('selecting a container shows its details card; a project row selects nothing', async () => {
  const v = await open(composeOnLocal)
  assert.equal(card(v), null)
  await v.selectItem(CONTAINERS, 'project:shop')
  assert.equal(card(v), null)
  assert.equal(v.valueOf(CONTAINERS), '')
  assert.deepEqual(enabled(v), [])

  await v.selectItem(CONTAINERS, SHOP_WEB)
  assert.equal(v.valueOf(CONTAINERS), SHOP_WEB)
  assert.equal(card(v)?.label, 'shop-web-1')
  assert.equal(card(v)?.props.description, 'running')
  assert.deepEqual(v.find({ type: 'KeyValue' })?.props.items, [
    { label: 'Image', value: 'nginx:1.27' },
    { label: 'Status', value: 'Up 2 hours', tone: 'success' },
    { label: 'Ports', value: '0.0.0.0:8080->80/tcp', code: true },
    { label: 'Compose', value: 'shop / web' },
    { label: 'ID', value: SHOP_WEB, code: true },
  ])

  // A project row keeps the container that was selected.
  await v.selectItem(CONTAINERS, 'project:shop')
  assert.equal(v.valueOf(CONTAINERS), SHOP_WEB)
  assert.equal(card(v)?.label, 'shop-web-1')
  assert.equal(v.findAll({ type: 'Card' }).length, 1)
  clean(v)
})

test('selecting a group row toggles it and keeps the selected container and its card', async () => {
  const v = await open(composeOnLocal)
  const expandedProp = () => v.find(CONTAINERS)?.props.expanded
  await v.selectItem(CONTAINERS, SHOP_WEB)
  assert.deepEqual(expandedProp(), ['project:shop'])
  const before = v.host.callsOf('plugin.request').length
  await v.selectItem(CONTAINERS, 'project:shop')
  assert.equal(v.host.callsOf('plugin.request').length, before) // the click sent no request
  assert.deepEqual(expandedProp(), [])
  assert.equal(v.valueOf(CONTAINERS), SHOP_WEB)
  assert.equal(card(v)?.label, 'shop-web-1')
  await v.selectItem(CONTAINERS, 'project:shop')
  assert.deepEqual(expandedProp(), ['project:shop'])
  assert.equal(v.valueOf(CONTAINERS), SHOP_WEB)
  assert.equal(card(v)?.label, 'shop-web-1')
  clean(v)
})

test('onAction on a group row sends nothing', async () => {
  const v = await open(composeOnLocal)
  await v.activateItem(CONTAINERS, 'project:shop')
  assert.equal(sent(v, 'docker.openTerminal').length, 0)
  assert.equal(sent(v, 'docker.action').length, 0)
  assert.equal(card(v), null)
  clean(v)
})

test('Enter or a double click on a container opens its logs in the panel', async () => {
  const v = await open(composeOnLocal)
  await v.activateItem(CONTAINERS, SHOP_WEB)
  assert.deepEqual(sent(v, 'docker.logs').map((c) => [c.input, c.timeoutMs]), [[{ hostId: 'local', containerId: SHOP_WEB }, 110_000]])
  assert.equal(sent(v, 'docker.openTerminal').length, 0)
  assert.equal(sent(v, 'docker.action').length, 0)
  // The container it opened is the one the card shows, with its logs under it.
  assert.equal(card(v)?.label, 'shop-web-1')
  assert.equal(logCode(v), `${SHOP_WEB} started\n${SHOP_WEB} ready`)
  clean(v)
})

test('the filter narrows every tree and ignores surrounding spaces', async () => {
  const v = await open(composeOnLocal)
  await v.type(FILTER, '  web ')
  assert.deepEqual(keysOf(v), ['project:shop', SHOP_WEB, WEB])
  // The section still counts the whole host.
  assert.equal(v.find(section('Containers'))?.props.description, '2 running / 3')
  await v.type(FILTER, 'SHOP', { replace: true })
  assert.deepEqual(keysOf(v), ['project:shop', SHOP_DB, SHOP_WEB])
  await v.toggle(section('Images'))
  await v.type(FILTER, 'stable', { replace: true })
  assert.deepEqual(keysOf(v, 'Images'), ['repo:nginx', 'image:sha256:1111:stable'])
  assert.equal(v.find({ type: 'Tree', label: 'Containers' }), null)
  assert.ok(v.find({ text: 'No containers match the filter' }))
  await v.type(FILTER, '', { replace: true })
  assert.deepEqual(keysOf(v), ['project:shop', SHOP_DB, SHOP_WEB, WEB])
  assert.equal(v.persisted.plugin.filter, undefined)
  clean(v)
})

test('filtering out the selected container clears selection and pending delete', async () => {
  const v = await open()
  await v.selectItem(CONTAINERS, DB)
  await v.press({ testId: 'delete' })
  assert.ok(v.find({ label: 'Delete db?' }))

  await v.type(FILTER, 'we')
  assert.deepEqual(keysOf(v), [WEB])
  assert.equal(card(v), null)
  assert.equal(v.valueOf(CONTAINERS), '')
  assert.equal(v.find({ label: 'Delete db?' }), null)

  // Showing it again does not bring back the selection or the question.
  await v.type(FILTER, '', { replace: true })
  assert.deepEqual(keysOf(v), [DB, WEB])
  assert.equal(card(v), null)
  assert.equal(v.find({ label: 'Delete db?' }), null)
  assert.equal(v.find({ testId: 'confirm-delete' }), null)

  // A filter that still shows the selected container keeps it.
  await v.selectItem(CONTAINERS, DB)
  await v.press({ testId: 'delete' })
  await v.type(FILTER, 'd')
  assert.equal(card(v)?.label, 'db')
  assert.ok(v.find({ label: 'Delete db?' }))
  assert.equal(sent(v, 'docker.action').length, 0)
  clean(v)
})

test('a refresh that leaves the selected container outside the filter clears the selection', async () => {
  let rows = LOCAL
  const v = await open({ 'docker.snapshot': ({ hostId }) => ok(snap(hostId, rows)) })
  await v.type(FILTER, 'db')
  await v.selectItem(CONTAINERS, DB)
  await v.press({ testId: 'delete' })
  rows = [container(WEB, 'web', 'running'), container(DB, 'renamed', 'exited', { image: 'pg:16' })]
  await v.press({ label: 'Refresh' })
  assert.deepEqual(keysOf(v), [])
  assert.equal(card(v), null)
  await v.type(FILTER, '', { replace: true })
  assert.equal(card(v), null)
  assert.equal(v.find({ testId: 'confirm-delete' }), null)
  assert.equal(sent(v, 'docker.action').length, 0)
  clean(v)
})

test('closing the Containers section cancels a pending delete', async () => {
  const v = await open()
  await v.selectItem(CONTAINERS, DB)
  await v.press({ testId: 'delete' })
  await v.toggle(section('Containers'))
  await v.toggle(section('Containers'))
  assert.equal(card(v)?.label, 'db')
  assert.equal(v.find({ label: 'Delete db?' }), null)
  assert.equal(sent(v, 'docker.action').length, 0)
  clean(v)
})

test('switches host from the select and loads its snapshot', async () => {
  const v = await open()
  await v.select(HOST, 'ssh:GPU1')
  assert.equal(v.valueOf(HOST), 'ssh:GPU1')
  assert.deepEqual(keysOf(v), [TRAINER])
  assert.deepEqual(sent(v, 'docker.snapshot').map((c) => [c.input, c.timeoutMs]), [
    [{ hostId: 'local' }, 110_000], [{ hostId: 'ssh:GPU1' }, 110_000],
  ])
  assert.equal(v.persisted.plugin.selectedHost, 'ssh:GPU1')
  clean(v)
})

test('applies only the latest snapshot request', async () => {
  let remoteCalls = 0
  let releaseFirst: ((answer: Result<Snapshot>) => void) | undefined
  let staleDelivered = false
  const v = await open({
    'docker.snapshot': ({ hostId }) => {
      if (hostId === 'local') return ok(snap('local', LOCAL))
      remoteCalls += 1
      if (remoteCalls === 1) return new Promise<Result<Snapshot>>((resolve) => { releaseFirst = resolve })
      // The first A answer arrives only after this one has been answered.
      setImmediate(() => {
        staleDelivered = true
        releaseFirst?.(ok(snap('ssh:GPU1', [container(STALE, 'stale', 'exited')])))
      })
      return ok(snap('ssh:GPU1', [container(TRAINER, 'trainer', 'running')]))
    },
  })
  // A → B → A before any answer comes back.
  await Promise.all([v.select(HOST, 'ssh:GPU1'), v.select(HOST, 'local'), v.select(HOST, 'ssh:GPU1')])
  await v.settled()
  assert.equal(remoteCalls, 2)
  assert.equal(staleDelivered, true)
  assert.equal(v.valueOf(HOST), 'ssh:GPU1')
  assert.deepEqual(keysOf(v), [TRAINER])
  clean(v)
})

test('enables only the actions the selected container allows', async () => {
  const v = await open()
  assert.deepEqual(enabled(v), [])
  await v.selectItem(CONTAINERS, WEB)
  assert.deepEqual(enabled(v), ['stop', 'restart', 'logs', 'shell'])
  await v.selectItem(CONTAINERS, DB)
  assert.deepEqual(enabled(v), ['start', 'restart', 'logs', 'delete'])
  clean(v)
})

test('asks before deleting and only then sends docker.action remove', async () => {
  const v = await open()
  await v.selectItem(CONTAINERS, DB)
  await v.press({ testId: 'delete' })
  assert.ok(v.summary().includes('Callout danger "Delete db?"'), v.summary().join('\n'))
  assert.equal(sent(v, 'docker.action').length, 0)

  await v.press({ testId: 'cancel-delete' })
  assert.equal(v.find({ label: 'Delete db?' }), null)
  assert.equal(sent(v, 'docker.action').length, 0)

  await v.press({ testId: 'delete' })
  await v.press({ testId: 'confirm-delete' })
  assert.deepEqual(sent(v, 'docker.action').map((c) => [c.input, c.timeoutMs]), [
    [{ hostId: 'local', action: 'remove', containerId: DB }, 110_000],
  ])
  assert.equal(v.find({ label: 'Delete db?' }), null)
  clean(v)
})

test('cancels the delete confirmation when the selection changes', async () => {
  const v = await open()
  await v.selectItem(CONTAINERS, DB)
  await v.press({ testId: 'delete' })
  assert.ok(v.find({ label: 'Delete db?' }))
  await v.selectItem(CONTAINERS, WEB)
  assert.equal(v.find({ label: 'Delete db?' }), null)
  assert.equal(v.find({ testId: 'confirm-delete' }), null)
  assert.equal(sent(v, 'docker.action').length, 0)
  clean(v)
})

test('cancels the delete confirmation when the host changes or the container is gone', async () => {
  let local = LOCAL
  const v = await open({ 'docker.snapshot': ({ hostId }) => ok(snap(hostId, hostId === 'local' ? local : [])) })
  await v.selectItem(CONTAINERS, DB)
  await v.press({ testId: 'delete' })
  await v.select(HOST, 'ssh:GPU1')
  await v.select(HOST, 'local')
  assert.equal(card(v), null)
  await v.selectItem(CONTAINERS, DB)
  assert.equal(card(v)?.label, 'db')
  assert.equal(v.find({ label: 'Delete db?' }), null)

  await v.press({ testId: 'delete' })
  local = [container(WEB, 'web', 'running')]
  await v.press({ label: 'Refresh' })
  assert.deepEqual(keysOf(v), [WEB])
  assert.equal(v.find({ label: 'Delete db?' }), null)
  assert.equal(card(v), null)
  assert.equal(sent(v, 'docker.action').length, 0)
  clean(v)
})

test('disables actions while one runs', async () => {
  let during: { enabled: string[]; spinner: boolean } | undefined
  let activating: Promise<void> | undefined
  const v = await open({
    'docker.action': async () => {
      // Enter on a container while the action still runs: the in-flight guard drops it.
      activating = view!.activateItem(CONTAINERS, WEB)
      // Let the panel draw while the action is still running.
      await new Promise((resolve) => setImmediate(resolve))
      during = { enabled: enabled(view!), spinner: view!.find({ type: 'Spinner', label: 'Working' }) !== null }
      return ok({ done: true as const })
    },
  })
  await v.selectItem(CONTAINERS, WEB)
  await v.press({ testId: 'stop' })
  await activating
  assert.deepEqual(during, { enabled: [], spinner: true })
  assert.equal(sent(v, 'docker.openTerminal').length, 0)
  assert.equal(sent(v, 'docker.logs').length, 0)
  assert.deepEqual(enabled(v), ['stop', 'restart', 'logs', 'shell'])
  assert.equal(v.find({ type: 'Spinner' }), null)
  clean(v)
})

test("shows an action's problem and note only in the card of the container it was for", async () => {
  let selecting: Promise<void> | undefined
  let cardDuring: string | undefined
  const v = await open({
    'docker.action': async () => {
      // The person picks another container while the action on web still runs.
      selecting = view!.selectItem(CONTAINERS, DB)
      await new Promise((resolve) => setImmediate(resolve))
      cardDuring = card(view!)?.label
      return { ok: false, problem: { kind: 'failed', message: RESTART_REFUSED } }
    },
  })
  const failed = () => v.find({ label: 'Command failed' })
  const note = () => v.find({ text: 'Opened logs in proj.' })
  await v.selectItem(CONTAINERS, WEB)
  await v.press({ testId: 'restart' })
  await selecting
  assert.equal(cardDuring, 'db')
  assert.equal(card(v)?.label, 'db')
  assert.equal(failed(), null)
  await v.selectItem(CONTAINERS, WEB)
  assert.ok(failed(), v.summary().join('\n'))
  await v.selectItem(CONTAINERS, DB)
  assert.equal(failed(), null)

  // The note naming where a Logs tab opened stays with its container too.
  await v.selectItem(CONTAINERS, WEB)
  await openLogsTerminal(v)
  assert.ok(note())
  assert.equal(failed(), null) // the next action cleared it
  await v.selectItem(CONTAINERS, DB)
  assert.equal(card(v)?.label, 'db')
  assert.equal(note(), null)
  await v.selectItem(CONTAINERS, WEB)
  assert.ok(note())
  clean(v)
})

test('refreshes the host after an action', async () => {
  let state: ContainerState = 'exited'
  const v = await open({
    'docker.snapshot': ({ hostId }) => ok(snap(hostId, [container(DB, 'db', state)])),
    'docker.action': ({ action }) => {
      if (action === 'start') state = 'running'
      return ok({ done: true as const })
    },
  })
  await v.selectItem(CONTAINERS, DB)
  const before = sent(v, 'docker.snapshot').length
  await v.press({ testId: 'start' })
  assert.deepEqual(sent(v, 'docker.action').map((c) => [c.input, c.timeoutMs]), [
    [{ hostId: 'local', action: 'start', containerId: DB }, 110_000],
  ])
  assert.equal(sent(v, 'docker.snapshot').length, before + 1)
  assert.deepEqual(enabled(v), ['stop', 'restart', 'logs', 'shell'])
  clean(v)
})

test('shows why an action failed and still refreshes the host', async () => {
  let answer: () => Result<{ done: true }> = () => ({ ok: false, problem: { kind: 'failed', message: RESTART_REFUSED } })
  const v = await open({ 'docker.action': () => answer() })
  await v.selectItem(CONTAINERS, WEB)
  const before = sent(v, 'docker.snapshot').length
  await v.press({ testId: 'restart' })
  assert.ok(v.summary().includes('Callout danger "Command failed"'), v.summary().join('\n'))
  assert.ok(v.find({ text: RESTART_REFUSED }))
  assert.equal(sent(v, 'docker.snapshot').length, before + 1)

  answer = () => { throw hostError('timeout', 'docker.action took longer than 110000 ms') }
  await v.press({ testId: 'restart' })
  assert.ok(v.find({ text: 'timeout: docker.action took longer than 110000 ms' }))
  assert.equal(sent(v, 'docker.snapshot').length, before + 2)
  assert.deepEqual(v.errors, [])
})

test('opens a logs terminal and a shell for the selected container', async () => {
  const v = await open()
  await v.selectItem(CONTAINERS, WEB)
  await openLogsTerminal(v)
  await v.press({ testId: 'shell' })
  assert.deepEqual(sent(v, 'docker.openTerminal').map((c) => [c.input, c.timeoutMs]), [
    [{ hostId: 'local', kind: 'logs', containerId: WEB, containerName: 'web' }, 110_000],
    [{ hostId: 'local', kind: 'shell', containerId: WEB, containerName: 'web' }, 110_000],
  ])
  clean(v)
})

// Ruling I2: a background tab gets a short note naming where it opened.
test('says where a Logs or Shell tab opened, until the next action or host change', async () => {
  const v = await open({
    'docker.openTerminal': ({ kind }) => ok({ opened: true as const, workspace: kind === 'logs' ? 'orca-docker' : 'other' }),
  })
  const note = (text: string) => v.find({ text })
  await v.selectItem(CONTAINERS, WEB)
  assert.equal(note('Opened logs in orca-docker.'), null)
  await openLogsTerminal(v)
  assert.ok(note('Opened logs in orca-docker.'), v.summary().join('\n'))
  await v.press({ testId: 'shell' })
  assert.equal(note('Opened logs in orca-docker.'), null)
  assert.ok(note('Opened shell in other.'))
  await v.press({ testId: 'stop' })
  assert.equal(note('Opened shell in other.'), null)

  await openLogsTerminal(v)
  assert.ok(note('Opened logs in orca-docker.'))
  await v.select(HOST, 'ssh:GPU1')
  await v.select(HOST, 'local')
  await v.selectItem(CONTAINERS, WEB)
  assert.equal(note('Opened logs in orca-docker.'), null)
  clean(v)
})

test('says nothing about a tab that did not open', async () => {
  const v = await open({ 'docker.openTerminal': () => ({ ok: false, problem: { kind: 'no-workspace', message: 'none' } }) })
  await v.selectItem(CONTAINERS, WEB)
  await openLogsTerminal(v)
  assert.equal(v.find({ text: 'Opened logs in proj.' }), null)
  assert.ok(v.summary().includes('Callout danger "No workspace on this host"'), v.summary().join('\n'))
  clean(v)
})

// Ruling I3: host listings may take the Orca CLI's 10 s per call, plus a local terminal lookup.
test('gives the host list and focus matching 60 s', async () => {
  const v = await open()
  await v.emit('workspace.changed', { context: { branch: 'main', displayName: 'gpu-repo', terminals: [] } })
  await v.press({ label: 'Refresh' })
  assert.deepEqual(sent(v, 'hosts.list').map((c) => [c.input, c.timeoutMs]), [[{ refresh: false }, 60_000], [{ refresh: true }, 60_000]])
  assert.deepEqual(sent(v, 'hosts.matchFocus').map((c) => c.timeoutMs), [60_000])
  clean(v)
})

test('shows the problem copy when the host fails', async () => {
  const v = await open({ 'docker.snapshot': () => ({ ok: false, problem: { kind: 'daemon-down', message: 'Cannot connect' } }) })
  assert.ok(v.summary().includes('EmptyState "Docker is not running"'), v.summary().join('\n'))
  assert.ok(v.find({ text: 'Start the Docker daemon on this host.' }))
  assert.deepEqual(drawnTrees(v), [])
  assert.equal(v.find({ type: 'Collapsible' }), null)
  clean(v)
})

test('says when a host has no containers', async () => {
  const v = await open({ 'docker.snapshot': ({ hostId }) => ok(snap(hostId, [])) })
  assert.ok(v.find({ text: 'No containers' }), v.summary().join('\n'))
  assert.equal(v.find({ type: 'Tree', label: 'Containers' }), null)
  assert.equal(v.find(section('Containers'))?.props.description, '0 running / 0')
  clean(v)
})

test('keeps the last snapshot and shows the problem when a later refresh fails', async () => {
  let fail = false
  const v = await open({
    'docker.snapshot': ({ hostId }) => fail ? { ok: false, problem: { kind: 'timeout', message: 'slow' } } : ok(snap(hostId, LOCAL)),
  })
  fail = true
  await v.press({ label: 'Refresh' })
  assert.ok(v.summary().includes('Callout warning "Timed out"'), v.summary().join('\n'))
  assert.deepEqual(keysOf(v), [DB, WEB])
  clean(v)
})

test('shows a problem when the request rejects', async () => {
  const v = await open({ 'docker.snapshot': () => { throw hostError('unavailable', 'the worker stopped') } })
  assert.ok(v.summary().includes('EmptyState "Command failed"'), v.summary().join('\n'))
  assert.ok(v.find({ text: 'unavailable: the worker stopped' }))
  assert.deepEqual(v.errors, [])
})

test('keeps the last good host list when listing hosts fails', async () => {
  let fail = false
  const v = await open({
    'hosts.list': () => fail ? { ok: false, problem: { kind: 'failed', message: 'orca cli exited 1' } } : ok({ hosts: HOSTS }),
  })
  fail = true
  await v.press({ label: 'Refresh' })
  assert.ok(v.summary().includes('Callout warning "Command failed"'), v.summary().join('\n'))
  // Ruling M8: the Refresh button re-reads the hosts (was: refresh false).
  assert.deepEqual(sent(v, 'hosts.list').map((c) => c.input), [{ refresh: false }, { refresh: true }])
  await v.select(HOST, 'ssh:GPU1')
  assert.deepEqual(keysOf(v), [TRAINER])
  clean(v)
})

test('follows the focused workspace when the switch is on', async () => {
  const v = await open({
    'hosts.matchFocus': ({ displayName }) => ok({ hostId: displayName === 'gpu-repo' ? 'ssh:GPU1' : 'local' }),
  })
  await v.emit('workspace.changed', { context: { branch: 'main', displayName: 'gpu-repo', terminals: [{ id: 'term-1', title: 'zsh' }] } })
  assert.deepEqual(sent(v, 'hosts.matchFocus').map((c) => c.input), [{ displayName: 'gpu-repo', branch: 'main', terminalIds: ['term-1'] }])
  assert.equal(v.valueOf(HOST), 'ssh:GPU1')
  assert.deepEqual(keysOf(v), [TRAINER])

  await v.emit('workspace.changed', { context: null })
  assert.equal(sent(v, 'hosts.matchFocus').length, 1)

  await v.toggle({ label: 'Follow focused workspace' })
  assert.equal(v.persisted.plugin.followFocus, false)
  await v.emit('workspace.changed', { context: { branch: 'main', displayName: 'laptop-repo', terminals: [] } })
  assert.equal(v.valueOf(HOST), 'ssh:GPU1')

  // Turning it back on follows the workspace that has focus now.
  await v.toggle({ label: 'Follow focused workspace' })
  assert.equal(v.valueOf(HOST), 'local')
  assert.deepEqual(sent(v, 'hosts.matchFocus').at(-1)?.input, { displayName: 'laptop-repo', branch: 'main', terminalIds: [] })
  clean(v)
})

const matchByName: MockRequests = {
  'hosts.matchFocus': ({ displayName }) => ok({ hostId: displayName === 'gpu-repo' ? 'ssh:GPU1' : 'local' }),
}
const LAPTOP = { branch: 'main', displayName: 'laptop-repo', terminals: [{ id: 'term-1', title: 'zsh' }] }
const GPU = { branch: 'main', displayName: 'gpu-repo', terminals: [{ id: 'term-9' }] }

test('keeps a manual host pick while only the terminals of the focused workspace change', async () => {
  const v = await open(matchByName)
  await v.emit('workspace.changed', { context: LAPTOP })
  assert.equal(v.valueOf(HOST), 'local')
  assert.equal(sent(v, 'hosts.matchFocus').length, 1)
  await v.select(HOST, 'ssh:GPU1')
  await v.selectItem(CONTAINERS, TRAINER)

  // Only a terminal title changed: the focus is the same, so nothing is asked.
  await v.emit('workspace.changed', { context: { ...LAPTOP, terminals: [{ id: 'term-1', title: 'vim' }] } })
  assert.equal(sent(v, 'hosts.matchFocus').length, 1)
  assert.equal(v.valueOf(HOST), 'ssh:GPU1')

  // A terminal opened: asked again, but the match is still 'local', so the pick stays.
  await v.emit('workspace.changed', { context: { ...LAPTOP, terminals: [{ id: 'term-1', title: 'vim' }, { id: 'term-2' }] } })
  assert.deepEqual(sent(v, 'hosts.matchFocus').at(-1)?.input, { displayName: 'laptop-repo', branch: 'main', terminalIds: ['term-1', 'term-2'] })
  assert.equal(v.valueOf(HOST), 'ssh:GPU1')
  assert.equal(v.valueOf(CONTAINERS), TRAINER)

  // Turning follow off and on again follows the focused workspace, even with the same match.
  await v.toggle({ label: 'Follow focused workspace' })
  await v.toggle({ label: 'Follow focused workspace' })
  assert.equal(sent(v, 'hosts.matchFocus').length, 3)
  assert.equal(v.valueOf(HOST), 'local')
  clean(v)
})

test('follows each change of the focused host', async () => {
  const v = await open(matchByName)
  await v.emit('workspace.changed', { context: GPU })
  assert.equal(v.valueOf(HOST), 'ssh:GPU1')
  await v.emit('workspace.changed', { context: LAPTOP })
  assert.equal(v.valueOf(HOST), 'local')
  assert.equal(sent(v, 'hosts.matchFocus').length, 2)
  clean(v)
})

test('forgets a closed focus, so turning follow off and on does not jump', async () => {
  const v = await open(matchByName)
  await v.emit('workspace.changed', { context: GPU })
  assert.equal(v.valueOf(HOST), 'ssh:GPU1')
  await v.select(HOST, 'local')
  await v.emit('workspace.changed', { context: null })
  await v.toggle({ label: 'Follow focused workspace' })
  await v.toggle({ label: 'Follow focused workspace' })
  assert.equal(v.valueOf({ label: 'Follow focused workspace' }), true)
  assert.equal(sent(v, 'hosts.matchFocus').length, 1)
  assert.equal(v.valueOf(HOST), 'local')
  clean(v)
})

test('cancels the delete confirmation when the container is no longer removable', async () => {
  let state: ContainerState = 'exited'
  const v = await open({ 'docker.snapshot': ({ hostId }) => ok(snap(hostId, [container(DB, 'db', state)])) })
  await v.selectItem(CONTAINERS, DB)
  await v.press({ testId: 'delete' })
  assert.ok(v.find({ label: 'Delete db?' }))

  state = 'running'
  await v.press({ label: 'Refresh' })
  assert.equal(v.find({ label: 'Delete db?' }), null)
  assert.equal(v.find({ testId: 'confirm-delete' }), null)
  assert.deepEqual(enabled(v), ['stop', 'restart', 'logs', 'shell'])
  assert.equal(sent(v, 'docker.action').length, 0)
  clean(v)
})

test('auto-refreshes only while visible', async () => {
  mock.timers.enable({ apis: ['setInterval', 'Date'] })
  const v = await open()
  const count = () => sent(v, 'docker.snapshot').length
  assert.equal(count(), 1)
  mock.timers.tick(9_000)
  await v.settled()
  assert.equal(count(), 1)
  mock.timers.tick(1_000)
  await v.settled()
  assert.equal(count(), 2)

  await v.setVisible(false)
  mock.timers.tick(30_000)
  await v.settled()
  assert.equal(count(), 2)

  await v.setVisible(true)
  mock.timers.tick(1_000)
  await v.settled()
  assert.equal(count(), 3)
  clean(v)
})

test('skips auto-refresh while a snapshot request is still out', async () => {
  mock.timers.enable({ apis: ['setInterval', 'Date'] })
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  let calls = 0
  const v = await open({
    'docker.snapshot': async ({ hostId }) => {
      if (calls++ > 0) await gate
      return ok(snap(hostId, LOCAL))
    },
  })
  mock.timers.tick(10_000)
  assert.equal(sent(v, 'docker.snapshot').length, 2)
  mock.timers.tick(30_000) // the second request is still out: no third one
  release()
  await v.settled()
  assert.equal(sent(v, 'docker.snapshot').length, 2)
  clean(v)
})

test('auto-refresh follows the interval setting', async () => {
  mock.timers.enable({ apis: ['setInterval', 'Date'] })
  const v = await open({}, { settings: { refreshLocalSeconds: 3 } })
  const count = () => sent(v, 'docker.snapshot').length
  mock.timers.tick(3_000)
  await v.settled()
  assert.equal(count(), 2)

  await settings.set('refreshLocalSeconds', 20)
  await v.settled()
  mock.timers.tick(10_000)
  await v.settled()
  assert.equal(count(), 2)
  mock.timers.tick(10_000)
  await v.settled()
  assert.equal(count(), 3)
  clean(v)
})

// The types of every node in the drawn tree, in drawing order.
function drawnTypes(v: TestPanel): string[] {
  const types: string[] = []
  const walk = (node: TreeSnapshot | string | null | undefined): void => {
    if (node === null || node === undefined || typeof node === 'string') return
    types.push(node.type)
    for (const child of node.children ?? []) walk(child)
  }
  walk(v.tree())
  return types
}

test('the Logs button shows the last log lines under the card, without a terminal', async () => {
  const v = await open()
  await v.selectItem(CONTAINERS, WEB)
  assert.equal(v.find(LOGS), null)
  await v.press({ testId: 'logs' })
  assert.deepEqual(sent(v, 'docker.logs').map((c) => [c.input, c.timeoutMs]), [[{ hostId: 'local', containerId: WEB }, 110_000]])
  assert.equal(sent(v, 'docker.openTerminal').length, 0)
  const code = v.find(LOGS)
  assert.deepEqual([code?.props.code, code?.props.label, code?.props.wrap, code?.props.maxHeight], [
    `${WEB} started\n${WEB} ready`, 'Logs', true, 'md',
  ])
  // The host's "Updated" time, then the logs' own.
  assert.deepEqual(v.findAll({ type: 'RelativeTime' }).map((t) => t.props.at), [1_000, 2_000])
  assert.deepEqual(['Refresh logs', 'Close logs'].map((label) => v.find({ label })?.type), ['IconButton', 'IconButton'])
  assert.equal(v.find(LOGS_TERMINAL)?.text, 'Open in terminal')
  // The header row wraps on a narrow sidebar, like the card's toolbar row.
  assert.equal(v.find({ testId: 'logs-header' })?.props.wrap, true)
  const types = drawnTypes(v)
  assert.ok(types.indexOf('Card') < types.indexOf('CodeView'), types.join(' '))
  assert.equal(card(v)?.label, 'web')

  await v.press({ label: 'Refresh logs' })
  assert.equal(sent(v, 'docker.logs').length, 2)
  clean(v)
})

test('draws the cleaned log text, or says there is none', async () => {
  let lines = ['\x1b[32mlistening\x1b[0m on :80\r', 'tab\there']
  const v = await open({ 'docker.logs': () => ok({ lines, takenAt: 2_000 }) })
  await v.selectItem(CONTAINERS, DB)
  await v.press({ testId: 'logs' })
  assert.equal(logCode(v), 'listening on :80\ntab\there')
  lines = []
  await v.press({ label: 'Refresh logs' })
  assert.ok(v.find({ text: 'No log output' }), v.summary().join('\n'))
  assert.equal(v.find(LOGS), null)
  clean(v)
})

test('logs belong to the container they were fetched for', async () => {
  // The next logs request runs `late` instead of the plain answer.
  let late: (() => Promise<LogsAnswer>) | null = null
  const v = await open({
    'docker.logs': ({ hostId, containerId }) => {
      const hook = late
      late = null
      return hook !== null ? hook() : ok({ lines: [`${containerId} on ${hostId}`], takenAt: 3_000 })
    },
  })
  let acting: Promise<void> | undefined
  let sentWhileOut = 0

  // web's answer comes back only after db was picked; db is asked for once web's request is back.
  await v.selectItem(CONTAINERS, WEB)
  late = async () => {
    acting = view!.selectItem(CONTAINERS, DB)
    await nextTurn()
    sentWhileOut = sent(view!, 'docker.logs').length
    return ok({ lines: ['stale web line'], takenAt: 2_000 })
  }
  await v.press({ testId: 'logs' })
  await acting
  await v.settled()
  assert.equal(sentWhileOut, 1) // one logs request at a time
  assert.deepEqual(sent(v, 'docker.logs').map((c) => c.input), [{ hostId: 'local', containerId: WEB }, { hostId: 'local', containerId: DB }])
  assert.equal(card(v)?.label, 'db')
  assert.equal(logCode(v), `${DB} on local`)

  // db's answer comes back only after the host changed: no log view at all.
  late = async () => {
    acting = view!.select(HOST, 'ssh:GPU1')
    await nextTurn()
    return ok({ lines: ['stale db line'], takenAt: 2_000 })
  }
  await v.press({ label: 'Refresh logs' })
  await acting
  await v.settled()
  assert.equal(v.valueOf(HOST), 'ssh:GPU1')
  assert.equal(v.find(LOGS), null)
  await v.selectItem(CONTAINERS, TRAINER)
  assert.equal(v.find(LOGS), null)
  assert.equal(sent(v, 'docker.logs').length, 3)
  clean(v)
})

// The next logs request runs `late` (once) instead of answering `${containerId} lines`.
function lateLogs(): { requests: MockRequests; hold: (hook: () => Promise<LogsAnswer>) => void } {
  let late: (() => Promise<LogsAnswer>) | null = null
  return {
    requests: {
      'docker.logs': ({ containerId }) => {
        const hook = late
        late = null
        return hook !== null ? hook() : ok({ lines: [`${containerId} lines`], takenAt: 3_000 })
      },
    },
    hold: (hook) => { late = hook },
  }
}
// What the log box shows now, drawn.
const logBox = (v: TestPanel) => ({
  code: logCode(v) ?? null, loading: v.find({ type: 'Skeleton' }) !== null, refreshDisabled: v.find({ label: 'Refresh logs' })?.disabled,
})

test('one logs request at a time: picks made while one is out send only the newest', async () => {
  const four = [container(WEB, 'web', 'running'), container(DB, 'db', 'exited'), container(BLOG, 'blog', 'running'), container(STALE, 'stale', 'exited')]
  const late = lateLogs()
  const v = await open({ ...late.requests, 'docker.snapshot': ({ hostId }) => ok(snap(hostId, four)) })
  let picking: Promise<unknown> | undefined
  let during: unknown
  await v.selectItem(CONTAINERS, WEB)
  late.hold(async () => {
    // db, blog, then stale are picked while web's request is still out.
    const picks: Promise<void>[] = []
    for (const id of [DB, BLOG, STALE]) {
      picks.push(view!.selectItem(CONTAINERS, id))
      await nextTurn()
    }
    picking = Promise.all(picks)
    during = { sent: sent(view!, 'docker.logs').length, card: card(view!)?.label, ...logBox(view!) }
    return ok({ lines: ['web lines'], takenAt: 2_000 })
  })
  await v.press({ testId: 'logs' })
  await picking
  await v.settled()
  assert.deepEqual(during, { sent: 1, card: 'stale', code: null, loading: true, refreshDisabled: true })
  assert.deepEqual(sent(v, 'docker.logs').map((c) => c.input), [{ hostId: 'local', containerId: WEB }, { hostId: 'local', containerId: STALE }])
  assert.deepEqual(logBox(v), { code: `${STALE} lines`, loading: false, refreshDisabled: false })
  clean(v)
})

test("an earlier answer for the same container neither shows nor ends the newer request's loading", async () => {
  const late = lateLogs()
  const v = await open(late.requests)
  let picking: Promise<unknown> | undefined
  let between: unknown
  await v.selectItem(CONTAINERS, WEB)
  // web is slow; the person picks db and then web again before it answers.
  late.hold(async () => {
    const picks = [view!.selectItem(CONTAINERS, DB)]
    await nextTurn()
    picks.push(view!.selectItem(CONTAINERS, WEB))
    await nextTurn()
    picking = Promise.all(picks)
    // The next request is web's again; it answers only after the box was looked at.
    late.hold(async () => {
      await nextTurn()
      between = logBox(view!)
      return ok({ lines: ['web new'], takenAt: 4_000 })
    })
    return ok({ lines: ['web old'], takenAt: 2_000 })
  })
  await v.press({ testId: 'logs' })
  await picking
  await v.settled()
  assert.deepEqual(between, { code: null, loading: true, refreshDisabled: true })
  assert.deepEqual(sent(v, 'docker.logs').map((c) => c.input), [{ hostId: 'local', containerId: WEB }, { hostId: 'local', containerId: WEB }])
  assert.deepEqual(logBox(v), { code: 'web new', loading: false, refreshDisabled: false })
  clean(v)
})

test('pressing Logs again on the open view sends one request, and none while one is out', async () => {
  const late = lateLogs()
  const v = await open(late.requests)
  await v.selectItem(CONTAINERS, WEB)
  await v.press({ testId: 'logs' })
  assert.equal(sent(v, 'docker.logs').length, 1)
  await v.press({ testId: 'logs' })
  assert.equal(sent(v, 'docker.logs').length, 2)

  let again: Promise<unknown> | undefined
  let during = -1
  late.hold(async () => {
    // Logs and Enter on the same container while its request is out.
    again = Promise.all([view!.press({ testId: 'logs' }), view!.activateItem(CONTAINERS, WEB)])
    await nextTurn()
    during = sent(view!, 'docker.logs').length
    return ok({ lines: ['third'], takenAt: 4_000 })
  })
  await v.press({ testId: 'logs' })
  await again
  await v.settled()
  assert.equal(during, 3)
  assert.equal(sent(v, 'docker.logs').length, 3) // and none after it came back
  assert.equal(logCode(v), 'third')
  clean(v)
})

// A held request keeps the panel from settling, so these acts start without waiting; each next turn lets it draw.
async function begin(acts: Promise<unknown>[], act: Promise<unknown>): Promise<void> {
  acts.push(act)
  await nextTurn()
}
const logsSent = (v: TestPanel) => sent(v, 'docker.logs').map((c) => (c.input as { containerId: string }).containerId)

test("a host change does not leave the new host's logs waiting for the old host's answer", async () => {
  let releaseSsh: ((answer: LogsAnswer) => void) | undefined
  const remote = [container(TRAINER, 'trainer', 'running'), container(BLOG, 'notebook', 'running')]
  const v = await open({
    'docker.snapshot': ({ hostId }) => ok(snap(hostId, hostId === 'local' ? LOCAL : remote)),
    'docker.logs': ({ hostId, containerId }) => hostId === 'local'
      ? ok({ lines: [`${containerId} here`], takenAt: 3_000 })
      : new Promise<LogsAnswer>((resolve) => { releaseSsh = resolve }),
  })
  const acts: Promise<unknown>[] = []
  await v.select(HOST, 'ssh:GPU1')
  await v.selectItem(CONTAINERS, TRAINER)
  await begin(acts, v.press({ testId: 'logs' }))
  // notebook is picked while trainer's request is out, so it waits; the host change ends that wait.
  await begin(acts, v.selectItem(CONTAINERS, BLOG))
  await begin(acts, v.select(HOST, 'local'))
  await begin(acts, v.selectItem(CONTAINERS, WEB))
  await begin(acts, v.press({ testId: 'logs' }))
  // This Mac's request went out and answered while the SSH one is still held.
  assert.deepEqual(logsSent(v), [TRAINER, WEB])
  assert.deepEqual(logBox(v), { code: `${WEB} here`, loading: false, refreshDisabled: false })

  releaseSsh?.(ok({ lines: ['trainer line'], takenAt: 2_000 }))
  await Promise.all(acts)
  await v.settled()
  assert.deepEqual(logBox(v), { code: `${WEB} here`, loading: false, refreshDisabled: false })
  assert.equal(v.find({ text: 'trainer line' }), null)
  assert.deepEqual(logsSent(v), [TRAINER, WEB])
  clean(v)
})

test("an old host's late logs answer leaves the new host's request alone", async () => {
  // trainer (SSH) and web (here) are held; db answers at once.
  const held = new Map<string, (answer: LogsAnswer) => void>()
  const v = await open({
    'docker.logs': ({ containerId }) => containerId === DB
      ? ok({ lines: [`${containerId} here`], takenAt: 3_000 })
      : new Promise<LogsAnswer>((resolve) => { held.set(containerId, resolve) }),
  })
  const acts: Promise<unknown>[] = []
  await v.select(HOST, 'ssh:GPU1')
  await v.selectItem(CONTAINERS, TRAINER)
  await begin(acts, v.press({ testId: 'logs' }))
  await begin(acts, v.select(HOST, 'local'))
  await begin(acts, v.selectItem(CONTAINERS, WEB))
  await begin(acts, v.press({ testId: 'logs' }))
  // db is picked while web's request is out: it waits for web's answer.
  await begin(acts, v.selectItem(CONTAINERS, DB))
  assert.deepEqual(logsSent(v), [TRAINER, WEB])

  // trainer's late answer neither ends web's request nor asks for db.
  held.get(TRAINER)?.(ok({ lines: ['trainer line'], takenAt: 2_000 }))
  await nextTurn()
  await begin(acts, v.settled())
  assert.deepEqual(logsSent(v), [TRAINER, WEB])
  assert.deepEqual(logBox(v), { code: null, loading: true, refreshDisabled: true })

  held.get(WEB)?.(ok({ lines: ['web line'], takenAt: 2_500 }))
  await Promise.all(acts)
  await v.settled()
  assert.deepEqual(logsSent(v), [TRAINER, WEB, DB])
  assert.deepEqual(logBox(v), { code: `${DB} here`, loading: false, refreshDisabled: false })
  clean(v)
})

test('a logs failure shows the problem copy in the log box', async () => {
  let answer: () => LogsAnswer = () => ({ ok: false, problem: { kind: 'failed', message: 'No such container: aaaaaaaaaaaa' } })
  const v = await open({ 'docker.logs': () => answer() })
  await v.selectItem(CONTAINERS, WEB)
  await v.press({ testId: 'logs' })
  assert.ok(v.summary().includes('EmptyState "Command failed"'), v.summary().join('\n'))
  assert.ok(v.find({ text: 'No such container: aaaaaaaaaaaa' }))
  assert.equal(v.find(LOGS), null)
  assert.ok(v.find({ label: 'Refresh logs' }))

  answer = () => { throw hostError('timeout', 'docker.logs took longer than 110000 ms') }
  await v.press({ label: 'Refresh logs' })
  assert.ok(v.find({ text: 'timeout: docker.logs took longer than 110000 ms' }), v.summary().join('\n'))

  // Once lines came, a failed refresh keeps them under a warning.
  answer = () => ok({ lines: ['hello'], takenAt: 2_000 })
  await v.press({ label: 'Refresh logs' })
  assert.equal(logCode(v), 'hello')
  assert.equal(v.find({ text: 'timeout: docker.logs took longer than 110000 ms' }), null)
  answer = () => ({ ok: false, problem: { kind: 'ssh-failed', message: 'ssh to "GPU1" failed: Connection closed.' } })
  await v.press({ label: 'Refresh logs' })
  assert.ok(v.summary().includes('Callout warning "SSH connection failed"'), v.summary().join('\n'))
  assert.equal(logCode(v), 'hello')
  // Only the log box shows it: the card has no action problem.
  assert.equal(v.find({ label: 'Command failed' }), null)
  assert.deepEqual(v.errors, [])
})

test('auto-refreshes the logs only while visible and open: every 3 s here, every 10 s over SSH', async () => {
  mock.timers.enable({ apis: ['setInterval', 'Date'] })
  const v = await open()
  const count = () => sent(v, 'docker.logs').length
  await v.selectItem(CONTAINERS, WEB)
  mock.timers.tick(5_000)
  await v.settled()
  assert.equal(count(), 0) // not open: nothing
  await v.press({ testId: 'logs' })
  assert.equal(count(), 1)
  mock.timers.tick(2_000)
  await v.settled()
  assert.equal(count(), 1)
  mock.timers.tick(1_000)
  await v.settled()
  assert.equal(count(), 2)

  await v.setVisible(false)
  mock.timers.tick(30_000)
  await v.settled()
  assert.equal(count(), 2)
  await v.setVisible(true)
  mock.timers.tick(1_000)
  await v.settled()
  assert.equal(count(), 3)

  await v.press({ label: 'Close logs' })
  assert.equal(v.find(LOGS), null)
  mock.timers.tick(30_000)
  await v.settled()
  assert.equal(count(), 3)

  await v.select(HOST, 'ssh:GPU1')
  await v.selectItem(CONTAINERS, TRAINER)
  await v.press({ testId: 'logs' })
  assert.equal(count(), 4)
  mock.timers.tick(9_000)
  await v.settled()
  assert.equal(count(), 4)
  mock.timers.tick(1_000)
  await v.settled()
  assert.equal(count(), 5)
  assert.deepEqual(sent(v, 'docker.logs').at(-1)?.input, { hostId: 'ssh:GPU1', containerId: TRAINER })
  clean(v)
})

test('skips the log auto-refresh while a logs request is still out', async () => {
  mock.timers.enable({ apis: ['setInterval', 'Date'] })
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  let calls = 0
  const v = await open({
    'docker.logs': async ({ containerId }) => {
      if (calls++ > 0) await gate
      return ok({ lines: [containerId], takenAt: 2_000 })
    },
  })
  await v.selectItem(CONTAINERS, WEB)
  await v.press({ testId: 'logs' })
  mock.timers.tick(3_000)
  assert.equal(sent(v, 'docker.logs').length, 2)
  mock.timers.tick(30_000) // the second request is still out: no third one
  release()
  await v.settled()
  assert.equal(sent(v, 'docker.logs').length, 2)
  clean(v)
})

test('Open in terminal follows the logs in a terminal tab and says where it opened', async () => {
  const v = await open()
  await v.selectItem(CONTAINERS, WEB)
  await v.press({ testId: 'logs' })
  await v.press(LOGS_TERMINAL)
  assert.deepEqual(sent(v, 'docker.openTerminal').map((c) => [c.input, c.timeoutMs]), [
    [{ hostId: 'local', kind: 'logs', containerId: WEB, containerName: 'web' }, 110_000],
  ])
  assert.ok(v.find({ text: 'Opened logs in proj.' }), v.summary().join('\n'))
  // The log view stays open.
  assert.equal(logCode(v), `${WEB} started\n${WEB} ready`)
  assert.equal(sent(v, 'docker.logs').length, 1)
  clean(v)
})

test('the log view follows the selected container and closes with the selection, the host, the section or its button', async () => {
  const v = await open()
  await v.selectItem(CONTAINERS, WEB)
  await v.press({ testId: 'logs' })
  await v.selectItem(CONTAINERS, DB)
  assert.deepEqual(sent(v, 'docker.logs').map((c) => c.input), [{ hostId: 'local', containerId: WEB }, { hostId: 'local', containerId: DB }])
  assert.equal(logCode(v), `${DB} started\n${DB} ready`)

  await v.press({ label: 'Close logs' })
  assert.equal(v.find(LOGS), null)
  assert.equal(card(v)?.label, 'db') // the card stays
  await v.selectItem(CONTAINERS, WEB)
  assert.equal(v.find(LOGS), null) // closed stays closed
  assert.equal(sent(v, 'docker.logs').length, 2)

  // A filter that hides the container clears the selection and closes the logs.
  await v.press({ testId: 'logs' })
  await v.type(FILTER, 'db')
  assert.equal(v.find(LOGS), null)
  await v.type(FILTER, '', { replace: true })
  await v.selectItem(CONTAINERS, WEB)
  assert.equal(v.find(LOGS), null)

  // So does another host.
  await v.press({ testId: 'logs' })
  await v.select(HOST, 'ssh:GPU1')
  await v.select(HOST, 'local')
  await v.selectItem(CONTAINERS, WEB)
  assert.equal(v.find(LOGS), null)

  // And closing the Containers section.
  await v.press({ testId: 'logs' })
  await v.toggle(section('Containers'))
  await v.toggle(section('Containers'))
  assert.equal(card(v)?.label, 'web')
  assert.equal(v.find(LOGS), null)
  clean(v)
})

// Images, volumes and networks as a host lists them: two tags of one image, an untagged image, a volume,
// a built-in network and one of a Compose project.
const NGINX_ID = `sha256:5f1e6a2b0c3d${'0'.repeat(52)}`
const UNTAGGED_ID = `sha256:${'9'.repeat(64)}`
const BRIDGE_ID = 'e'.repeat(64)
const ML_NET_ID = '7'.repeat(64)
const NGINX_LATEST = `image:${NGINX_ID}:latest`
const NGINX_STABLE = `image:${NGINX_ID}:stable`
const UNTAGGED = `image:${UNTAGGED_ID}:<none>`
const PGDATA = 'volume:pgdata'
const BRIDGE = `network:${BRIDGE_ID}`
const ML_NET = `network:${ML_NET_ID}`
const resourceSnap = (hostId: HostId, containers: ContainerRow[] = LOCAL): Snapshot => ({
  ...snap(hostId, containers),
  images: [
    { id: NGINX_ID, repository: 'nginx', tag: 'latest', size: '192MB', createdSince: '2 weeks ago' },
    { id: NGINX_ID, repository: 'nginx', tag: 'stable', size: '192MB', createdSince: '2 weeks ago' },
    { id: UNTAGGED_ID, repository: '<none>', tag: '<none>', size: '1.2GB', createdSince: '3 months ago' },
  ],
  volumes: [{ name: 'pgdata', driver: 'local' }],
  networks: [
    { id: BRIDGE_ID, name: 'bridge', driver: 'bridge', scope: 'local' },
    { id: ML_NET_ID, name: 'ml_default', driver: 'bridge', scope: 'local' },
  ],
})
const withResources: MockRequests = { 'docker.snapshot': ({ hostId }) => ok(resourceSnap(hostId)) }
const IMAGES = { type: 'Tree', label: 'Images' }
const VOLUMES = { type: 'Tree', label: 'Volumes' }
const NETWORKS = { type: 'Tree', label: 'Networks' }
const PULL_INPUT = { label: 'Image to pull' }
const PULL_BY_NAME = { testId: 'pull-by-name' }
async function openResources(overrides: MockRequests = {}): Promise<TestPanel> {
  const v = await open({ ...withResources, ...overrides })
  for (const label of ['Images', 'Volumes', 'Networks']) await v.toggle(section(label))
  return v
}

test('selecting an image tag, a volume or a network shows its card, one card at a time', async () => {
  const v = await openResources()
  await v.selectItem(IMAGES, NGINX_LATEST)
  assert.equal(v.valueOf(IMAGES), NGINX_LATEST)
  assert.equal(card(v)?.label, 'nginx:latest')
  assert.deepEqual(v.find({ type: 'KeyValue' })?.props.items, [
    { label: 'ID', value: '5f1e6a2b0c3d', code: true }, { label: 'Size', value: '192MB' }, { label: 'Created', value: '2 weeks ago' },
  ])
  assert.deepEqual(v.find({ type: 'Toolbar' })?.label, 'Image actions')
  assert.deepEqual([v.find({ testId: 'pull' })?.disabled, v.find({ testId: 'delete' })?.disabled], [false, false])
  // The other trees hold no selection.
  assert.deepEqual([v.valueOf(CONTAINERS), v.valueOf(VOLUMES), v.valueOf(NETWORKS)], ['', '', ''])

  await v.selectItem(VOLUMES, PGDATA)
  assert.deepEqual([v.valueOf(IMAGES), v.valueOf(VOLUMES)], ['', PGDATA])
  assert.equal(card(v)?.label, 'pgdata')
  assert.deepEqual(v.find({ type: 'KeyValue' })?.props.items, [{ label: 'Driver', value: 'local' }])
  assert.deepEqual([v.find({ testId: 'pull' }), v.find({ testId: 'delete' })?.disabled], [null, false])

  await v.selectItem(NETWORKS, ML_NET)
  assert.equal(card(v)?.label, 'ml_default')
  assert.deepEqual(v.find({ type: 'KeyValue' })?.props.items, [
    { label: 'Driver', value: 'bridge' }, { label: 'Scope', value: 'local' }, { label: 'ID', value: '777777777777', code: true },
  ])
  assert.deepEqual([v.find({ testId: 'pull' }), v.find({ testId: 'delete' })?.disabled], [null, false])
  assert.equal(v.findAll({ type: 'Card' }).length, 1)

  // A container takes the selection back.
  await v.selectItem(CONTAINERS, DB)
  assert.deepEqual([card(v)?.label, v.valueOf(NETWORKS)], ['db', ''])
  assert.equal(v.findAll({ type: 'Card' }).length, 1)
  // Picking sends nothing.
  for (const name of ['docker.removeResource', 'docker.pullTerminal', 'docker.action']) assert.equal(sent(v, name).length, 0, name)
  clean(v)
})

test('a repository row toggles like a Compose project and selects nothing', async () => {
  const v = await openResources()
  const expandedProp = () => v.find(IMAGES)?.props.expanded
  assert.deepEqual(expandedProp(), [])
  const before = v.host.callsOf('plugin.request').length
  await v.selectItem(IMAGES, 'repo:nginx')
  assert.deepEqual(expandedProp(), ['repo:nginx'])
  assert.equal(card(v), null)
  assert.equal(v.valueOf(IMAGES), '')
  await v.selectItem(IMAGES, NGINX_STABLE)
  await v.selectItem(IMAGES, 'repo:nginx')
  assert.deepEqual(expandedProp(), [])
  assert.equal(v.valueOf(IMAGES), NGINX_STABLE)
  assert.equal(card(v)?.label, 'nginx:stable')
  // The arrow works the same way.
  await v.expand(IMAGES, 'repo:<none>')
  assert.deepEqual(expandedProp(), ['repo:<none>'])
  await v.collapse(IMAGES, 'repo:<none>')
  assert.deepEqual(expandedProp(), [])
  assert.equal(v.host.callsOf('plugin.request').length, before)

  // Another host starts with every repository collapsed again.
  await v.selectItem(IMAGES, 'repo:nginx')
  await v.select(HOST, 'ssh:GPU1')
  await v.select(HOST, 'local')
  assert.deepEqual(expandedProp(), [])
  clean(v)
})

test('deleting an image tag, a volume or a network takes two presses and sends its kind and reference', async () => {
  const v = await openResources()
  const cases = [
    { tree: IMAGES, key: NGINX_LATEST, question: 'Delete nginx:latest?', kind: 'image', ref: 'nginx:latest' },
    { tree: VOLUMES, key: PGDATA, question: 'Delete pgdata?', kind: 'volume', ref: 'pgdata' },
    { tree: NETWORKS, key: ML_NET, question: 'Delete ml_default?', kind: 'network', ref: ML_NET_ID },
  ]
  const removed: unknown[] = []
  for (const { tree, key, question, kind, ref } of cases) {
    await v.selectItem(tree, key)
    await v.press({ testId: 'delete' })
    assert.ok(v.summary().includes(`Callout danger "${question}"`), v.summary().join('\n'))
    assert.equal(sent(v, 'docker.removeResource').length, removed.length, question)
    await v.press({ testId: 'cancel-delete' })
    assert.equal(v.find({ label: question }), null)
    assert.equal(sent(v, 'docker.removeResource').length, removed.length, question)

    await v.press({ testId: 'delete' })
    const snapshots = sent(v, 'docker.snapshot').length
    await v.press({ testId: 'confirm-delete' })
    removed.push([{ hostId: 'local', kind, ref }, 110_000])
    assert.deepEqual(sent(v, 'docker.removeResource').map((c) => [c.input, c.timeoutMs]), removed)
    // Done: the selection clears and the host is read again.
    assert.equal(card(v), null, question)
    assert.equal(v.valueOf(tree), '', question)
    assert.equal(v.find({ label: question }), null)
    assert.equal(sent(v, 'docker.snapshot').length, snapshots + 1, question)
  }
  assert.equal(sent(v, 'docker.action').length, 0)
  clean(v)
})

test('the delete question names what it removes', async () => {
  const v = await openResources()
  const question = async (tree: typeof IMAGES, key: string) => {
    await v.selectItem(tree, key)
    await v.press({ testId: 'delete' })
    return v.find({ type: 'Callout' })?.text
  }
  assert.match(await question(IMAGES, NGINX_LATEST) ?? '', /The tag is removed, and the image too when no other tag uses it\./)
  assert.match(await question(IMAGES, UNTAGGED) ?? '', /The image is removed from the host\./)
  assert.match(await question(VOLUMES, PGDATA) ?? '', /The volume and its data are removed from the host\./)
  assert.match(await question(NETWORKS, ML_NET) ?? '', /The network is removed from the host\./)
  assert.equal(sent(v, 'docker.removeResource').length, 0)
  clean(v)
})

test('the pending resource delete clears when the selection, the host, the filter or its section changes, and survives a refresh', async () => {
  let rows = resourceSnap('local')
  const v = await openResources({ 'docker.snapshot': ({ hostId }) => ok(hostId === 'local' ? rows : resourceSnap(hostId)) })
  const question = () => v.find({ label: 'Delete nginx:latest?' })
  await v.selectItem(IMAGES, NGINX_LATEST)
  await v.press({ testId: 'delete' })
  // A refresh that still lists it keeps the question.
  await v.press({ label: 'Refresh' })
  assert.ok(question(), v.summary().join('\n'))

  await v.selectItem(VOLUMES, PGDATA)
  await v.selectItem(IMAGES, NGINX_LATEST)
  assert.equal(question(), null)

  await v.press({ testId: 'delete' })
  await v.select(HOST, 'ssh:GPU1')
  await v.select(HOST, 'local')
  assert.equal(card(v), null)
  await v.selectItem(IMAGES, NGINX_LATEST)
  assert.equal(question(), null)

  // A filter that hides it clears the selection with the question.
  await v.press({ testId: 'delete' })
  await v.type(FILTER, 'stable')
  assert.equal(card(v), null)
  await v.type(FILTER, '', { replace: true })
  assert.equal(card(v), null)
  assert.equal(question(), null)

  // Closing its section drops the question; closing another section does not.
  await v.selectItem(IMAGES, NGINX_LATEST)
  await v.press({ testId: 'delete' })
  await v.toggle(section('Containers'))
  assert.ok(question())
  await v.toggle(section('Images'))
  await v.toggle(section('Images'))
  assert.equal(card(v)?.label, 'nginx:latest')
  assert.equal(question(), null)

  // Gone from the host: the card and the question go.
  await v.press({ testId: 'delete' })
  rows = { ...rows, images: rows.images.filter((i) => i.tag !== 'latest') }
  await v.press({ label: 'Refresh' })
  assert.equal(card(v), null)
  assert.equal(question(), null)
  assert.equal(sent(v, 'docker.removeResource').length, 0)
  clean(v)
})

test("Docker's built-in networks cannot be deleted from their card", async () => {
  const v = await openResources()
  const hint = () => v.find({ text: "Docker's built-in networks cannot be deleted." })
  await v.selectItem(NETWORKS, BRIDGE)
  assert.equal(card(v)?.label, 'bridge')
  assert.equal(v.find({ testId: 'delete' })?.disabled, true)
  assert.ok(hint(), v.summary().join('\n'))
  await v.selectItem(NETWORKS, ML_NET)
  assert.equal(v.find({ testId: 'delete' })?.disabled, false)
  assert.equal(hint(), null)
  assert.equal(sent(v, 'docker.removeResource').length, 0)
  clean(v)
})

test("a refused delete shows the daemon's message on the card, which stays selected", async () => {
  const inUse = 'remove pgdata: volume is in use - [0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef]'
  let answer: () => Result<{ done: true }> = () => ({ ok: false, problem: { kind: 'failed', message: inUse } })
  const v = await openResources({ 'docker.removeResource': () => answer() })
  await v.selectItem(VOLUMES, PGDATA)
  await v.press({ testId: 'delete' })
  await v.press({ testId: 'confirm-delete' })
  assert.ok(v.summary().includes('Callout danger "Command failed"'), v.summary().join('\n'))
  assert.ok(v.find({ text: inUse }))
  assert.equal(card(v)?.label, 'pgdata')
  assert.equal(v.valueOf(VOLUMES), PGDATA)
  // The problem belongs to its card.
  await v.selectItem(IMAGES, NGINX_LATEST)
  assert.equal(v.find({ text: inUse }), null)
  await v.selectItem(VOLUMES, PGDATA)
  assert.ok(v.find({ text: inUse }))

  answer = () => { throw hostError('timeout', 'docker.removeResource took longer than 110000 ms') }
  await v.press({ testId: 'delete' })
  await v.press({ testId: 'confirm-delete' })
  assert.ok(v.find({ text: 'timeout: docker.removeResource took longer than 110000 ms' }), v.summary().join('\n'))
  assert.equal(v.find({ text: inUse }), null)
  assert.equal(card(v)?.label, 'pgdata')
  assert.deepEqual(v.errors, [])
})

test('selecting an image, a volume or a network closes the container log view and card', async () => {
  const v = await openResources()
  for (const [tree, key] of [[IMAGES, NGINX_LATEST], [VOLUMES, PGDATA], [NETWORKS, ML_NET]] as const) {
    await v.selectItem(CONTAINERS, WEB)
    await v.press({ testId: 'logs' })
    assert.ok(v.find(LOGS))
    await v.selectItem(tree, key)
    assert.equal(v.find(LOGS), null, key)
    assert.equal(v.find({ label: 'Close logs' }), null, key)
    assert.equal(v.valueOf(CONTAINERS), '', key)
    assert.equal(v.find({ type: 'Card', label: 'web' }), null, key)
    assert.equal(v.findAll({ type: 'Card' }).length, 1, key)
    // Back on the container, the log view stays closed.
    await v.selectItem(CONTAINERS, WEB)
    assert.equal(v.find(LOGS), null, key)
  }
  assert.equal(sent(v, 'docker.logs').length, 3)
  clean(v)
})

test('Pull on an image tag opens docker pull for repository:tag and says where', async () => {
  const v = await openResources()
  await v.selectItem(IMAGES, NGINX_STABLE)
  const snapshots = sent(v, 'docker.snapshot').length
  await v.press({ testId: 'pull' })
  assert.deepEqual(sent(v, 'docker.pullTerminal').map((c) => [c.input, c.timeoutMs]), [[{ hostId: 'local', ref: 'nginx:stable' }, 110_000]])
  assert.ok(v.find({ text: 'Opened pull: nginx:stable in proj.' }), v.summary().join('\n'))
  assert.equal(sent(v, 'docker.snapshot').length, snapshots)
  assert.equal(sent(v, 'docker.removeResource').length, 0)
  // The note stays with its card.
  await v.selectItem(IMAGES, NGINX_LATEST)
  assert.equal(v.find({ text: 'Opened pull: nginx:stable in proj.' }), null)
  clean(v)
})

test('an untagged image has no Pull and is deleted by its id', async () => {
  const v = await openResources()
  await v.selectItem(IMAGES, UNTAGGED)
  assert.equal(card(v)?.label, '999999999999')
  assert.equal(v.find({ testId: 'pull' }), null)
  await v.press({ testId: 'delete' })
  assert.ok(v.find({ label: 'Delete 999999999999?' }), v.summary().join('\n'))
  await v.press({ testId: 'confirm-delete' })
  assert.deepEqual(sent(v, 'docker.removeResource').map((c) => c.input), [{ hostId: 'local', kind: 'image', ref: UNTAGGED_ID }])
  assert.equal(sent(v, 'docker.pullTerminal').length, 0)
  clean(v)
})

test('Pull by name: a valid name opens a terminal on the selected host; any other shows an error and sends nothing', async () => {
  const v = await openResources()
  const input = v.find(PULL_INPUT)
  assert.deepEqual([input?.type, input?.props.placeholder, v.valueOf(PULL_INPUT)], ['Input', 'nginx:latest', ''])
  assert.equal(v.find(PULL_BY_NAME)?.text, 'Pull')
  assert.equal(v.find(PULL_BY_NAME)?.disabled, true) // nothing typed yet
  const error = () => v.find({ text: 'Not an image name. Use one like nginx:latest or ghcr.io/org/app:1.2.' })

  for (const bad of ['nginx latest', '-f', '--force', 'a..b', 'x;id', 'nginx@latest', '$(id)']) {
    await v.type(PULL_INPUT, bad, { replace: true })
    assert.equal(error(), null, bad)
    await v.press(PULL_BY_NAME)
    assert.ok(error(), `${bad}: ${v.summary().join('\n')}`)
    assert.equal(v.find(PULL_INPUT)?.props.invalid, true, bad)
  }
  assert.equal(sent(v, 'docker.pullTerminal').length, 0)

  // Typing clears the error; spaces around the name do not count.
  await v.type(PULL_INPUT, '  ghcr.io/org/app:1.2 ', { replace: true })
  assert.equal(error(), null)
  assert.equal(v.find(PULL_INPUT)?.props.invalid, false)
  await v.press(PULL_BY_NAME)
  assert.deepEqual(sent(v, 'docker.pullTerminal').map((c) => [c.input, c.timeoutMs]), [[{ hostId: 'local', ref: 'ghcr.io/org/app:1.2' }, 110_000]])
  assert.ok(v.find({ text: 'Opened pull: ghcr.io/org/app:1.2 in proj.' }), v.summary().join('\n'))
  assert.equal(card(v), null)

  await v.select(HOST, 'ssh:GPU1')
  assert.equal(v.find({ text: 'Opened pull: ghcr.io/org/app:1.2 in proj.' }), null)
  await v.type(PULL_INPUT, `redis@sha256:${'a'.repeat(64)}`, { replace: true })
  await v.press(PULL_BY_NAME)
  assert.deepEqual(sent(v, 'docker.pullTerminal').at(-1)?.input, { hostId: 'ssh:GPU1', ref: `redis@sha256:${'a'.repeat(64)}` })
  clean(v)
})

test('a pull that cannot open its terminal says why under the pull row', async () => {
  const v = await openResources({ 'docker.pullTerminal': () => ({ ok: false, problem: { kind: 'no-workspace', message: 'none' } }) })
  await v.type(PULL_INPUT, 'nginx:latest')
  await v.press(PULL_BY_NAME)
  assert.ok(v.summary().includes('Callout danger "No workspace on this host"'), v.summary().join('\n'))
  assert.equal(v.find({ text: /^Opened pull/ }), null)
  // It is the row's problem, not a card's.
  await v.selectItem(IMAGES, NGINX_LATEST)
  assert.equal(v.findAll({ type: 'Callout' }).length, 1)
  clean(v)
})

test('while a delete runs, every Pull and Delete is disabled', async () => {
  const disabled = (v: TestPanel) => ({
    pullByName: v.find(PULL_BY_NAME)?.disabled, pull: v.find({ testId: 'pull' })?.disabled, delete: v.find({ testId: 'delete' })?.disabled,
  })
  let during: unknown
  const v = await openResources({
    'docker.removeResource': async () => {
      await nextTurn()
      const spinner = view!.find({ type: 'Spinner', label: 'Working' }) !== null
      during = { ...disabled(view!), confirm: view!.find({ testId: 'confirm-delete' }), spinner }
      return { ok: false, problem: { kind: 'failed', message: 'conflict: unable to remove repository reference "nginx:latest" (must force)' } }
    },
  })
  await v.type(PULL_INPUT, 'redis:7')
  await v.selectItem(IMAGES, NGINX_LATEST)
  await v.press({ testId: 'delete' })
  await v.press({ testId: 'confirm-delete' })
  assert.deepEqual(during, { pullByName: true, pull: true, delete: true, confirm: null, spinner: true })
  assert.deepEqual(disabled(v), { pullByName: false, pull: false, delete: false })
  clean(v)
})


// Each case deletes the first item; the person picks the second while the delete is still out.
const LATE_PICKS = [
  { tree: IMAGES, key: NGINX_LATEST, nextTree: VOLUMES, next: PGDATA, nextCard: 'pgdata' },
  { tree: VOLUMES, key: PGDATA, nextTree: NETWORKS, next: ML_NET, nextCard: 'ml_default' },
  { tree: NETWORKS, key: ML_NET, nextTree: IMAGES, next: NGINX_STABLE, nextCard: 'nginx:stable' },
] as const

test('a delete that answers ok after another item was picked leaves that item selected', async () => {
  let pick: (() => Promise<void>) | null = null
  let selecting: Promise<void> | undefined
  const v = await openResources({
    'docker.removeResource': async () => {
      selecting = pick?.()
      await nextTurn()
      return ok({ done: true as const })
    },
  })
  for (const { tree, key, nextTree, next, nextCard } of LATE_PICKS) {
    pick = () => view!.selectItem(nextTree, next)
    await v.selectItem(tree, key)
    await v.press({ testId: 'delete' })
    await v.press({ testId: 'confirm-delete' })
    await selecting
    await v.settled()
    assert.equal(card(v)?.label, nextCard, key)
    assert.equal(v.valueOf(nextTree), next, key)
  }
  assert.equal(sent(v, 'docker.removeResource').length, 3)
  clean(v)
})

test("a delete's late failure shows only on the card it was for", async () => {
  const refused = 'remove pgdata: volume is in use - [0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef]'
  let pick: (() => Promise<void>) | null = null
  let selecting: Promise<void> | undefined
  let cardDuring: string | undefined
  const v = await openResources({
    'docker.removeResource': async () => {
      selecting = pick?.()
      await nextTurn()
      cardDuring = card(view!)?.label
      return { ok: false, problem: { kind: 'failed', message: refused } }
    },
  })
  const failed = () => v.find({ label: 'Command failed' })
  for (const { tree, key, nextTree, next, nextCard } of LATE_PICKS) {
    pick = () => view!.selectItem(nextTree, next)
    await v.selectItem(tree, key)
    await v.press({ testId: 'delete' })
    await v.press({ testId: 'confirm-delete' })
    await selecting
    await v.settled()
    assert.equal(cardDuring, nextCard, key)
    assert.equal(card(v)?.label, nextCard, key)
    assert.equal(failed(), null, key)
    assert.equal(v.find({ text: refused }), null, key)
    // Back on the item it was for, the problem shows.
    await v.selectItem(tree, key)
    assert.ok(failed(), `${key}: ${v.summary().join('\n')}`)
  }
  clean(v)
})

test("a pull's late note shows only on the card it was for", async () => {
  let selecting: Promise<void> | undefined
  const v = await openResources({
    'docker.pullTerminal': async () => {
      selecting = view!.selectItem(VOLUMES, PGDATA)
      await nextTurn()
      return ok({ opened: true as const, workspace: 'proj' })
    },
  })
  const note = () => v.find({ text: 'Opened pull: nginx:stable in proj.' })
  await v.selectItem(IMAGES, NGINX_STABLE)
  await v.press({ testId: 'pull' })
  await selecting
  await v.settled()
  assert.equal(card(v)?.label, 'pgdata')
  assert.equal(note(), null)
  assert.equal(v.find({ text: /^Opened pull/ }), null)
  await v.selectItem(IMAGES, NGINX_STABLE)
  assert.ok(note(), v.summary().join('\n'))
  clean(v)
})

test('the same image tagged in two repositories is deleted by the reference of the row picked', async () => {
  const twoRepos = (hostId: HostId): Snapshot => {
    const base = resourceSnap(hostId)
    return { ...base, images: [...base.images, { id: NGINX_ID, repository: 'myreg/nginx', tag: 'latest', size: '192MB', createdSince: '2 weeks ago' }] }
  }
  const v = await openResources({ 'docker.snapshot': ({ hostId }) => ok(twoRepos(hostId)) })
  assert.deepEqual(keysOf(v, 'Images'), ['repo:myreg/nginx', `${NGINX_LATEST}~2`, 'repo:nginx', NGINX_LATEST, NGINX_STABLE, 'repo:<none>', UNTAGGED])
  await v.selectItem(IMAGES, `${NGINX_LATEST}~2`)
  assert.equal(card(v)?.label, 'myreg/nginx:latest')
  await v.press({ testId: 'delete' })
  assert.ok(v.find({ label: 'Delete myreg/nginx:latest?' }), v.summary().join('\n'))
  await v.press({ testId: 'confirm-delete' })
  assert.deepEqual(sent(v, 'docker.removeResource').map((c) => c.input), [{ hostId: 'local', kind: 'image', ref: 'myreg/nginx:latest' }])
  clean(v)
})
