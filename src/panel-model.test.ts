import { test, assert } from 'orca/testing'
import type { ContainerRow, ContainerState, HostInfo, ImageRow, NetworkRow, Problem, ProblemKind, VolumeRow } from './protocol'
import type { TreeItem } from 'orca'
import {
  allowedActions, containerDetails, containerTree, defaultExpanded, dueForRefresh, hostOptions, imageTree, LOG_LINE_MAX, LOG_REFRESH_LOCAL_MS,
  LOG_REFRESH_REMOTE_MS, LOG_TEXT_MAX, logRefreshMs, logText, matchesFilter, networkTree, nextHost, problemCopy, refreshMs, rejectionProblem,
  runningCount, stateIcon, volumeTree,
} from './panel-model'

const host = (id: HostInfo['id'], label: string, status: HostInfo['status']): HostInfo => ({ id, label, kind: id === 'local' ? 'local' : 'ssh', status })

test('allowed actions follow the container state', () => {
  assert.deepEqual(allowedActions('running'), { start: false, stop: true, restart: true, logs: true, shell: true, remove: false })
  assert.deepEqual(allowedActions('exited'), { start: true, stop: false, restart: true, logs: true, shell: false, remove: true })
  assert.deepEqual(allowedActions('created'), { start: true, stop: false, restart: false, logs: true, shell: false, remove: true })
  assert.deepEqual(allowedActions('paused'), { start: false, stop: true, restart: false, logs: true, shell: false, remove: false })
  assert.deepEqual(allowedActions('restarting'), { start: false, stop: true, restart: false, logs: true, shell: false, remove: false })
  assert.deepEqual(allowedActions('dead'), { start: false, stop: false, restart: false, logs: true, shell: false, remove: true })
  for (const s of ['removing', 'unknown'] as const) assert.deepEqual(allowedActions(s), { start: false, stop: false, restart: false, logs: true, shell: false, remove: false })
})

test('host options label status and disable unusable hosts', () => {
  const options = hostOptions([
    host('local', 'Mac', 'ready'), host('ssh:GPU1', 'GPU1', 'ready'), host('ssh:cloud-gpu', 'cloud-gpu', 'no-workspace'),
    host('ssh:GPU2', 'GPU2', 'unreachable'), host('ssh:old', 'old', 'unsupported'),
  ])
  assert.deepEqual(options, [
    { value: 'local', label: 'This Mac' },
    { value: 'ssh:GPU1', label: 'GPU1 (SSH)' },
    { value: 'ssh:cloud-gpu', label: 'cloud-gpu (SSH, no workspace)', disabled: true },
    { value: 'ssh:GPU2', label: 'GPU2 (SSH, unreachable)', disabled: true },
    { value: 'ssh:old', label: 'old (SSH, unsupported)', disabled: true },
  ])
  assert.deepEqual(hostOptions([host('local', 'Mac', 'unsupported')]), [{ value: 'local', label: 'This Mac (unsupported)', disabled: true }])
  assert.equal('disabled' in options[0]!, false)
})

test('follows focus only when enabled and the match is usable', () => {
  const hosts = [host('local', 'Mac', 'ready'), host('ssh:A', 'A', 'ready'), host('ssh:B', 'B', 'unreachable')]
  assert.equal(nextHost('local', 'ssh:A', true, hosts), 'ssh:A')
  assert.equal(nextHost('local', 'ssh:A', false, hosts), 'local')
  assert.equal(nextHost('local', 'ssh:B', true, hosts), 'local')
  assert.equal(nextHost('local', 'ssh:gone', true, hosts), 'local')
  assert.equal(nextHost(null, null, true, hosts), 'local')
  assert.equal(nextHost('ssh:gone', null, true, [host('local', 'Mac', 'unsupported'), host('ssh:A', 'A', 'ready')]), 'ssh:A')
  assert.equal(nextHost('ssh:B', null, true, [host('ssh:B', 'B', 'unreachable')]), 'ssh:B')
  assert.equal(nextHost(null, null, true, [host('ssh:B', 'B', 'unreachable')]), null)
  assert.equal(nextHost(null, null, true, []), null)
})

test('refresh intervals come from settings with defaults', () => {
  assert.equal(refreshMs('local', {}), 10_000)
  assert.equal(refreshMs('ssh:GPU1', {}), 60_000)
  assert.equal(refreshMs('ssh:GPU1', { refreshRemoteSeconds: 120 }), 120_000)
  assert.equal(refreshMs('local', { refreshLocalSeconds: 3 }), 3_000)
  assert.equal(refreshMs('local', { refreshLocalSeconds: 2 }), 10_000)
  assert.equal(refreshMs('local', { refreshLocalSeconds: 601 }), 10_000)
  assert.equal(refreshMs('local', { refreshLocalSeconds: 5.5 }), 10_000)
  assert.equal(refreshMs('local', { refreshLocalSeconds: '5' }), 10_000)
  assert.equal(refreshMs('ssh:A', { refreshRemoteSeconds: 14 }), 60_000)
  assert.equal(refreshMs('ssh:A', { refreshRemoteSeconds: 3600 }), 3_600_000)
  assert.equal(refreshMs('ssh:A', { refreshLocalSeconds: 5 }), 60_000)
})

test('refresh is due only when visible, idle and the interval passed', () => {
  assert.equal(dueForRefresh(20_000, 10_000, true, 10_000, false), true)
  assert.equal(dueForRefresh(19_999, 10_000, true, 10_000, false), false)
  assert.equal(dueForRefresh(20_000, 10_000, false, 10_000, false), false)
  assert.equal(dueForRefresh(20_000, 10_000, true, 10_000, true), false)
  assert.equal(dueForRefresh(0, null, true, 10_000, false), true)
})

test('log refresh intervals: 3 s here, 10 s over SSH', () => {
  assert.deepEqual([LOG_REFRESH_LOCAL_MS, LOG_REFRESH_REMOTE_MS, LOG_TEXT_MAX, LOG_LINE_MAX], [3_000, 10_000, 15_000, 500])
  assert.equal(logRefreshMs('local'), 3_000)
  assert.equal(logRefreshMs('ssh:GPU1'), 10_000)
})

test('log text stays within 15 000 characters and keeps the newest lines', () => {
  // 1000 lines of 100 characters: 148 of them (and 147 newlines) fit.
  const lines = Array.from({ length: 1000 }, (_, i) => `line ${String(i).padStart(4, '0')} `.padEnd(100, 'x'))
  const text = logText(lines)
  assert.ok(text.length <= 15_000, `${text.length}`)
  assert.deepEqual(text.split('\n'), lines.slice(-148))
  assert.equal(text.length, 148 * 101 - 1)

  // A container that prints megabytes on very long lines: each is cut to 500 characters and '…'.
  const huge = Array.from({ length: 200 }, (_, i) => String(i % 10).repeat(100_000))
  const cut = logText(huge)
  assert.ok(cut.length <= 15_000, `${cut.length}`)
  const kept = cut.split('\n')
  assert.equal(kept.length, 29) // 29 × 501 + 28 newlines = 14 557; one more would pass 15 000
  assert.equal(kept.at(-1), '9'.repeat(500) + '…')
  for (const line of kept) assert.equal(line.length, 501)

  // A line just at the limit stays whole; a cut never splits an emoji in half.
  assert.equal(logText(['a'.repeat(500)]), 'a'.repeat(500))
  assert.equal(logText(['a'.repeat(499) + '😀' + 'b']), 'a'.repeat(499) + '…')
  assert.equal(logText([]), '')
  assert.equal(logText(['']), '')
})

test('log text strips ANSI escapes', () => {
  assert.equal(logText(['\x1b[31mred\x1b[0m and \x1b[1;38;5;208mbold\x1b[m']), 'red and bold')
  assert.equal(logText(['\x1b[?25l\x1b[2K\x1b[1Gprogress']), 'progress')
  // OSC 8 hyperlinks and window titles, ended by BEL or by ESC \.
  assert.equal(logText(['\x1b]8;;https://example.com\x07link\x1b]8;;\x07']), 'link')
  assert.equal(logText(['\x1b]0;title\x1b\\after']), 'after')
  assert.equal(logText(['\x1b(Bplain\x1b=']), 'plain')
  assert.equal(logText(['\x9b1mC1\x9b0m']), 'C1')
  // Other control characters go too; a tab stays.
  assert.equal(logText(['a\tb\r', '\x00\x07c\x08\x7f\x85d\x1b', 'e\nf']), 'a\tb\ncd\nef')
  // The limits count what is left after stripping.
  assert.equal(logText([`\x1b[32m${'g'.repeat(500)}\x1b[0m`]), 'g'.repeat(500))
})

test('problem copy', () => {
  const expected: Record<Exclude<ProblemKind, 'invalid' | 'failed' | 'ssh-failed'>, [string, string]> = {
    unsupported: ['Not supported here', 'This version supports Orca on macOS with Linux SSH hosts.'],
    unreachable: ['Host unreachable', 'Orca could not reach this host. Check its SSH connection in Orca.'],
    'no-workspace': ['No workspace on this host', 'Open a workspace on this host in Orca first.'],
    'docker-missing': ['Docker CLI not found', 'Install the docker command on this host.'],
    'daemon-down': ['Docker is not running', 'Start the Docker daemon on this host.'],
    'permission-denied': ['Permission denied', 'Your account cannot use the Docker socket on this host.'],
    truncated: ['List too long', 'The output was too large to show.'],
    timeout: ['Timed out', 'Docker did not answer in time.'],
    'unknown-result': ['Result unknown', 'The command was sent, but its result did not come back. Refresh to check.'],
  }
  for (const [kind, [title, description]] of Object.entries(expected)) {
    assert.deepEqual(problemCopy({ kind: kind as ProblemKind, message: 'ignored' }), { title, description })
  }
  assert.deepEqual(problemCopy({ kind: 'invalid', message: 'bad id' }), { title: 'Invalid request', description: 'bad id' })
  assert.deepEqual(problemCopy({ kind: 'failed', message: 'boom' }), { title: 'Command failed', description: 'boom' })
  const sshMessage = 'No ssh host named "GPU1" on this Mac. Add a "Host GPU1" entry with key login to ~/.ssh/config.'
  assert.deepEqual(problemCopy({ kind: 'ssh-failed', message: sshMessage }), { title: 'SSH connection failed', description: sshMessage })
})

test('rejections become failed problems', () => {
  const coded = Object.assign(new Error('no handler'), { code: 'ERR_X' })
  assert.deepEqual(rejectionProblem(coded), { kind: 'failed', message: 'ERR_X: no handler' } satisfies Problem)
  assert.deepEqual(rejectionProblem(new Error('plain')), { kind: 'failed', message: 'error: plain' })
  assert.deepEqual(rejectionProblem({ code: '', message: 'm' }), { kind: 'failed', message: 'error: m' })
  assert.deepEqual(rejectionProblem('oops'), { kind: 'failed', message: 'error: oops' })
})

const c = (id: string, name: string, state: ContainerState, over: Partial<ContainerRow> = {}): ContainerRow =>
  ({ id, name, image: 'img', state, status: state === 'running' ? 'Up 2 hours' : 'Exited (0) 1 hour ago', ports: '', project: '', service: '', ...over })
const img = (id: string, repository: string, tag: string): ImageRow => ({ id, repository, tag, size: '10MB', createdSince: '2 days ago' })

const FIXTURE_CONTAINERS = [
  c('a'.repeat(64), 'web', 'running', { project: 'shop', service: 'web', ports: '0.0.0.0:80->80/tcp' }),
  c('b'.repeat(64), 'db', 'exited', { project: 'shop', service: 'db' }),
  c('c'.repeat(64), 'zeta', 'running'),
  c('d'.repeat(64), 'alpha', 'paused', { project: 'blog', service: 'app' }),
  c('e'.repeat(64), 'beta', 'created'),
]
const FIXTURE_IMAGES = [img('i1', 'nginx', 'latest'), img('i1', 'nginx', 'stable'), img('i2', '<none>', '<none>'), img('i3', 'app', '1.0'), img('i3', 'app', '1.0')]

test('stateIcon covers all eight states', () => {
  const expected: Record<ContainerState, string> = { running: 'play', paused: 'pause', restarting: 'refresh', exited: 'stop', created: 'add', dead: 'error', removing: 'delete', unknown: 'info' }
  for (const [state, icon] of Object.entries(expected)) assert.equal(stateIcon(state as ContainerState), icon)
})

test('matchesFilter is a case-insensitive substring match', () => {
  assert.equal(matchesFilter('', 'x'), true)
  assert.equal(matchesFilter(''), true)
  assert.equal(matchesFilter('WEB', 'my-web-1'), true)
  assert.equal(matchesFilter('db', 'web', 'postgres-DB'), true)
  assert.equal(matchesFilter('zzz', 'web', 'db'), false)
})

test('matchesFilter ignores spaces around the filter', () => {
  assert.equal(matchesFilter('  web ', 'my-web-1'), true)
  assert.equal(matchesFilter('   ', 'x'), true)
  assert.equal(matchesFilter(' web', 'web'), true)
  assert.equal(matchesFilter('we b', 'web'), false)
  assert.deepEqual(containerTree(FIXTURE_CONTAINERS, ' shop ').map((t) => t.key), ['project:shop'])
})

test('names sort without regard to case', () => {
  const tree = containerTree([
    c('1'.repeat(12), 'Zeta', 'running'), c('2'.repeat(12), 'alpha', 'running'), c('3'.repeat(12), 'Beta', 'running'),
    c('4'.repeat(12), 'web', 'running', { project: 'Shop' }), c('5'.repeat(12), 'Api', 'running', { project: 'Shop' }),
    c('6'.repeat(12), 'x', 'running', { project: 'blog' }),
  ], '')
  assert.deepEqual(tree.map((t) => t.label), ['blog', 'Shop', 'alpha', 'Beta', 'Zeta'])
  assert.deepEqual(tree[1]!.children?.map((t) => t.label), ['Api', 'web'])
  const images = imageTree([img('i1', 'nginx', 'a'), img('i2', '<none>', '<none>'), img('i3', 'Redis', 'b'), img('i4', 'app', 'c')], '')
  assert.deepEqual(images.map((t) => t.label), ['app', 'nginx', 'Redis', '<none>'])
})

test('volume and network keys stay unique when a row repeats', () => {
  const volumes = volumeTree([{ name: 'data', driver: 'local' }, { name: 'data', driver: 'nfs' }], '')
  assert.deepEqual(volumes.map((t) => t.key), ['volume:data', 'volume:data~2'])
  // Keys are given before filtering, so a key does not change with the filter.
  assert.deepEqual(volumeTree([{ name: 'data', driver: 'local' }, { name: 'data', driver: 'nfs' }], 'nfs').map((t) => t.key), ['volume:data~2'])
  const networks = networkTree([
    { id: 'n1', name: 'bridge', driver: 'bridge', scope: 'local' }, { id: 'n1', name: 'bridge', driver: 'bridge', scope: 'local' },
  ], '')
  assert.deepEqual(networks.map((t) => t.key), ['network:n1', 'network:n1~2'])
})

test('containerTree puts compose groups first, sorted, then loose containers sorted', () => {
  const tree = containerTree(FIXTURE_CONTAINERS, '')
  assert.deepEqual(tree.map((t) => t.key), ['project:blog', 'project:shop', 'e'.repeat(64), 'c'.repeat(64)])
  assert.deepEqual(tree[1], {
    key: 'project:shop', label: 'shop', description: 'compose · 1/2 running', icon: 'layers',
    children: [
      { key: 'b'.repeat(64), label: 'db', description: 'Exited (0) 1 hour ago', icon: 'stop' },
      { key: 'a'.repeat(64), label: 'web', description: 'Up 2 hours', icon: 'play' },
    ],
  })
  assert.deepEqual(tree[3], { key: 'c'.repeat(64), label: 'zeta', description: 'img · Up 2 hours', icon: 'play' })
})

test('containerTree labels a grouped container by its service, falling back to the name', () => {
  const rows = [
    c('1'.repeat(12), 'app-aiworker-1', 'running', { project: 'labo', service: 'aiworker', image: 'big/image:1' }),
    c('2'.repeat(12), 'app-old-1', 'running', { project: 'labo', service: '' }),
    c('3'.repeat(12), 'loose', 'running', { image: 'nginx' }),
  ]
  const tree = containerTree(rows, '')
  assert.deepEqual(tree[0]!.children?.map((t) => [t.label, t.description]), [['aiworker', 'Up 2 hours'], ['app-old-1', 'Up 2 hours']])
  assert.deepEqual([tree[1]!.label, tree[1]!.description], ['loose', 'nginx · Up 2 hours'])
  // The filter still finds a grouped container by full name, image or service.
  for (const f of ['app-aiworker-1', 'big/image', 'aiworker']) assert.deepEqual(containerTree(rows, f)[0]!.children?.map((t) => t.key), ['1'.repeat(12)])
})

test('containerTree tells same-service replicas apart by their numeric suffix, else by full name', () => {
  const rows = [
    c('1'.repeat(12), 'shop-web-1', 'running', { project: 'shop', service: 'web' }),
    c('2'.repeat(12), 'shop-web-2', 'running', { project: 'shop', service: 'web' }),
    c('3'.repeat(12), 'shop_db_1', 'running', { project: 'shop', service: 'db' }),
    c('4'.repeat(12), 'odd', 'running', { project: 'shop', service: 'cache' }),
    c('5'.repeat(12), 'shop-cache-x', 'running', { project: 'shop', service: 'cache' }),
  ]
  const kids = containerTree(rows, '')[0]!.children!
  assert.deepEqual(kids.map((t) => [t.key, t.label]), [
    ['4'.repeat(12), 'odd'], ['3'.repeat(12), 'db'], ['5'.repeat(12), 'shop-cache-x'], ['1'.repeat(12), 'web 1'], ['2'.repeat(12), 'web 2'],
  ])
})

test('containerTree filter: group name keeps all children, child match keeps matching children, no match drops the group', () => {
  const byGroup = containerTree(FIXTURE_CONTAINERS, 'SHOP')
  assert.deepEqual(byGroup.map((t) => t.key), ['project:shop'])
  assert.equal(byGroup[0]!.children?.length, 2)
  const byChild = containerTree(FIXTURE_CONTAINERS, 'web')
  assert.deepEqual(byChild.map((t) => t.key), ['project:shop'])
  assert.deepEqual(byChild[0]!.children?.map((t) => t.label), ['web'])
  assert.equal(byChild[0]!.description, 'compose · 1/2 running') // counts stay whole-group
  assert.deepEqual(containerTree(FIXTURE_CONTAINERS, 'nomatch'), [])
  assert.deepEqual(containerTree(FIXTURE_CONTAINERS, 'beta').map((t) => t.label), ['beta'])
})

test('imageTree groups by repository with <none> last and de-duplicates keys', () => {
  const tree = imageTree(FIXTURE_IMAGES, '')
  assert.deepEqual(tree.map((t) => t.key), ['repo:app', 'repo:nginx', 'repo:<none>'])
  assert.equal(tree[1]!.description, '2 tags')
  assert.equal(tree[2]!.description, '1 tag')
  assert.deepEqual(tree[1]!.children, [
    { key: 'image:i1:latest', label: 'latest', description: '10MB · 2 days ago', icon: 'package' },
    { key: 'image:i1:stable', label: 'stable', description: '10MB · 2 days ago', icon: 'package' },
  ])
  assert.deepEqual(tree[0]!.children?.map((t) => t.key), ['image:i3:1.0', 'image:i3:1.0~2'])
})

test('imageTree filter', () => {
  assert.deepEqual(imageTree(FIXTURE_IMAGES, 'ngin').map((t) => t.children?.length), [2])
  const one = imageTree(FIXTURE_IMAGES, 'stable')
  assert.deepEqual(one[0]!.children?.map((t) => t.label), ['stable'])
  assert.deepEqual(imageTree(FIXTURE_IMAGES, 'nomatch'), [])
})

test('volume and network trees', () => {
  const volumes: VolumeRow[] = [{ name: 'data', driver: 'local' }, { name: 'cache', driver: 'nfs' }]
  const networks: NetworkRow[] = [{ id: 'n1', name: 'bridge', driver: 'bridge', scope: 'local' }]
  assert.deepEqual(volumeTree(volumes, 'DAT'), [{ key: 'volume:data', label: 'data', description: 'local', icon: 'database' }])
  assert.equal(volumeTree(volumes, '').length, 2)
  assert.deepEqual(networkTree(networks, ''), [{ key: 'network:n1', label: 'bridge', description: 'bridge · local', icon: 'globe' }])
  assert.deepEqual(networkTree(networks, 'zzz'), [])
})

test('tree keys are unique across sections', () => {
  const containers = [...FIXTURE_CONTAINERS, c('f'.repeat(64), 'data', 'running'), c('9'.repeat(64), 'bridge', 'running')]
  const trees = [
    containerTree(containers, ''), imageTree(FIXTURE_IMAGES, ''),
    volumeTree([{ name: 'data', driver: 'local' }, { name: 'shop', driver: 'local' }], ''),
    networkTree([{ id: 'n1', name: 'bridge', driver: 'bridge', scope: 'local' }], ''),
  ]
  const keys: string[] = []
  const walk = (items: readonly TreeItem[]): void => { for (const i of items) { keys.push(i.key); walk(i.children ?? []) } }
  for (const t of trees) walk(t)
  assert.equal(new Set(keys).size, keys.length)
})

test('containerDetails omits empty fields and sets tones', () => {
  const plain = containerDetails(c('0123456789abcdef', 'x', 'running'))
  assert.deepEqual(plain, [
    { label: 'Image', value: 'img' }, { label: 'Status', value: 'Up 2 hours', tone: 'success' }, { label: 'ID', value: '0123456789ab', code: true },
  ])
  const full = containerDetails(c('0123456789abcdef', 'x', 'running', { ports: '80/tcp', project: 'shop', service: 'web' }))
  assert.deepEqual(full.map((i) => i.label), ['Image', 'Status', 'Ports', 'Compose', 'ID'])
  assert.deepEqual(full[2], { label: 'Ports', value: '80/tcp', code: true })
  assert.deepEqual(full[3], { label: 'Compose', value: 'shop / web' })
  for (const i of full) assert.equal(JSON.stringify(i).includes('undefined'), false)
  assert.equal(Object.values(full[0]!).includes(undefined as never), false)
})

test('containerDetails status tone', () => {
  const tone = (state: ContainerState, status: string) => containerDetails(c('x', 'x', state, { status }))[1]!.tone
  assert.equal(tone('paused', 'Up (Paused)'), 'warning')
  assert.equal(tone('restarting', 'Restarting (1) 3s ago'), 'warning')
  assert.equal(tone('dead', 'Dead'), 'danger')
  assert.equal(tone('exited', 'Exited (137) 1 hour ago'), 'danger')
  assert.equal(tone('exited', 'Exited (0) 1 hour ago'), undefined)
  assert.equal(tone('created', 'Created'), undefined)
  assert.equal('tone' in containerDetails(c('x', 'x', 'exited'))[1]!, false)
})

test('runningCount and defaultExpanded', () => {
  assert.equal(runningCount(FIXTURE_CONTAINERS), 2)
  assert.deepEqual(defaultExpanded(FIXTURE_CONTAINERS).sort(), ['project:blog', 'project:shop'])
  assert.deepEqual(defaultExpanded([]), [])
})
