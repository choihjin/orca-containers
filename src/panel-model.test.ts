import { test, assert } from 'orca/testing'
import type { ContainerRow, ContainerState, HostInfo, ImageRow, NetworkRow, Problem, ProblemKind, VolumeRow } from './protocol'
import type { TreeItem } from 'orca'
import {
  allowedActions, containerDetails, containerTree, defaultExpanded, dueForRefresh, hostOptions, imageTree, LOG_LINE_MAX, LOG_REFRESH_LOCAL_MS,
  LOG_REFRESH_REMOTE_MS, LOG_TEXT_MAX, logRefreshMs, logText, matchesFilter, networkTree, nextHost, problemCopy, projectDetails, refreshMs,
  rejectionProblem, resourceDetails, resourceKindOf, runningCount, shownKey, stateIcon, volumeTree,
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

// Only an unsupported host gets a status in its label; every ready host can be picked (no "unreachable" or
// "no workspace" labels: Orca's workspace listing no longer decides).
test('host options mark and disable only unsupported hosts', () => {
  const options = hostOptions([
    host('local', 'This Mac', 'ready'), host('ssh:GPU1', 'GPU1', 'ready'), host('ssh:cloud-gpu', 'cloud-gpu', 'ready'),
    host('ssh:old', 'old', 'unsupported'),
  ])
  assert.deepEqual(options, [
    { value: 'local', label: 'This Mac' },
    { value: 'ssh:GPU1', label: 'GPU1 (SSH)' },
    { value: 'ssh:cloud-gpu', label: 'cloud-gpu (SSH)' },
    { value: 'ssh:old', label: 'old (SSH, unsupported)', disabled: true },
  ])
  assert.deepEqual(hostOptions([host('local', 'Mac', 'unsupported')]), [{ value: 'local', label: 'Mac (unsupported)', disabled: true }])
  // The local host's own label: "This Mac" on macOS, "This computer" on Linux.
  assert.deepEqual(hostOptions([host('local', 'This computer', 'ready')]), [{ value: 'local', label: 'This computer' }])
  // In Korean the local host's own names read 이 Mac / 이 컴퓨터; SSH host names stay as they are.
  assert.deepEqual(hostOptions([host('local', 'This Mac', 'ready'), host('ssh:GPU1', 'GPU1', 'ready')], 'ko').map((o) => o.label), ['이 Mac', 'GPU1 (SSH)'])
  assert.deepEqual(hostOptions([host('local', 'This computer', 'unsupported')], 'ko').map((o) => o.label), ['이 컴퓨터 (지원 안 함)'])
  assert.ok(options.slice(0, 3).every((o) => !('disabled' in o)), JSON.stringify(options))
})

test('follows focus only when enabled and the match is usable', () => {
  const hosts = [host('local', 'Mac', 'ready'), host('ssh:A', 'A', 'ready'), host('ssh:B', 'B', 'unsupported')]
  assert.equal(nextHost('local', 'ssh:A', true, hosts), 'ssh:A')
  assert.equal(nextHost('local', 'ssh:A', false, hosts), 'local')
  assert.equal(nextHost('local', 'ssh:B', true, hosts), 'local')
  assert.equal(nextHost('local', 'ssh:gone', true, hosts), 'local')
  assert.equal(nextHost(null, null, true, hosts), 'local')
  assert.equal(nextHost('ssh:gone', null, true, [host('local', 'Mac', 'unsupported'), host('ssh:A', 'A', 'ready')]), 'ssh:A')
  assert.equal(nextHost('ssh:B', null, true, [host('ssh:B', 'B', 'unsupported')]), 'ssh:B')
  assert.equal(nextHost(null, null, true, [host('ssh:B', 'B', 'unsupported')]), null)
  assert.equal(nextHost(null, null, true, []), null)
})

// Auto-pick takes the first ready host: an unsupported This Mac is skipped for the first SSH host.
test('auto-picks the first ready host and skips unsupported ones', () => {
  const hosts = [host('local', 'Mac', 'unsupported'), host('ssh:old', 'old', 'unsupported'), host('ssh:A', 'A', 'ready'), host('ssh:B', 'B', 'ready')]
  assert.equal(nextHost(null, null, true, hosts), 'ssh:A')
  assert.equal(nextHost(null, 'ssh:B', true, hosts), 'ssh:B')
  assert.equal(nextHost(null, 'ssh:old', true, hosts), 'ssh:A')
  assert.equal(nextHost(null, 'ssh:B', false, hosts), 'ssh:A')
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
  const expected: Record<Exclude<ProblemKind, 'invalid' | 'failed' | 'ssh-failed' | 'startup-shell'>, [string, string]> = {
    unsupported: ['Not supported here', 'This version supports Orca on macOS or Linux, with Linux or macOS SSH hosts.'],
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
  // The worker's message is the list of login files.
  const files = '.bashrc, .config/fish/config.fish'
  assert.deepEqual(problemCopy({ kind: 'startup-shell', message: files }), { title: 'This host may start tmux, screen or byobu', description: files })
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

const IMAGE_ID = `sha256:5f1e6a2b0c3d${'0'.repeat(52)}`
const UNTAGGED_ID = `sha256:${'9'.repeat(64)}`
const NET_ID = '7'.repeat(64)
const RESOURCES = {
  containers: FIXTURE_CONTAINERS,
  images: [
    // One image tagged `latest` in two repositories: both rows have the key `image:<id>:latest`, so the second gets `~2`.
    { id: IMAGE_ID, repository: 'nginx', tag: 'latest', size: '192MB', createdSince: '2 weeks ago' },
    { id: IMAGE_ID, repository: 'myreg/nginx', tag: 'latest', size: '192MB', createdSince: '2 weeks ago' },
    { id: UNTAGGED_ID, repository: '<none>', tag: '<none>', size: '1.2GB', createdSince: '3 months ago' },
    { id: UNTAGGED_ID, repository: 'app', tag: '<none>', size: '1.2GB', createdSince: '3 months ago' },
  ],
  volumes: [{ name: 'pgdata', driver: 'local' }],
  networks: [
    { id: NET_ID, name: 'ml_default', driver: 'bridge', scope: 'local' },
    { id: 'a'.repeat(64), name: 'bridge', driver: 'bridge', scope: 'local' },
    { id: 'b'.repeat(64), name: 'host', driver: 'host', scope: 'local' },
    { id: 'c'.repeat(64), name: 'none', driver: 'null', scope: 'local' },
  ],
}

test('resource keys name their kind; container ids and group rows name none', () => {
  assert.equal(resourceKindOf(`image:${IMAGE_ID}:latest`), 'image')
  assert.equal(resourceKindOf('volume:pgdata'), 'volume')
  assert.equal(resourceKindOf(`network:${NET_ID}`), 'network')
  for (const key of ['a'.repeat(64), 'project:shop', 'repo:nginx', 'images:x', '']) assert.equal(resourceKindOf(key), null, key)
})

test('an image tag card: repository:tag, its short id, size and age, Pull and Delete by that reference', () => {
  assert.deepEqual(resourceDetails(RESOURCES, `image:${IMAGE_ID}:latest`), {
    kind: 'image', key: `image:${IMAGE_ID}:latest`, title: 'nginx:latest',
    items: [{ label: 'ID', value: '5f1e6a2b0c3d', code: true }, { label: 'Size', value: '192MB' }, { label: 'Created', value: '2 weeks ago' }],
    removeRef: 'nginx:latest', removeBlocked: null, pullRef: 'nginx:latest',
    removeText: 'The tag is removed, and the image too when no other tag uses it. This cannot be undone.',
  })
  // The same image under another repository: its `~2` row is pulled and deleted by its own reference.
  const other = resourceDetails(RESOURCES, `image:${IMAGE_ID}:latest~2`)
  assert.deepEqual([other?.title, other?.removeRef, other?.pullRef], ['myreg/nginx:latest', 'myreg/nginx:latest', 'myreg/nginx:latest'])
})

test('an image without a repository and tag is titled by its short id, has no Pull and deletes by id', () => {
  const untagged = resourceDetails(RESOURCES, `image:${UNTAGGED_ID}:<none>`)
  assert.deepEqual([untagged?.title, untagged?.pullRef, untagged?.removeRef, untagged?.removeText], [
    '999999999999', null, UNTAGGED_ID, 'The image is removed from the host. This cannot be undone.',
  ])
  assert.deepEqual(untagged?.items[0], { label: 'ID', value: '999999999999', code: true })
  // A repository without a tag: titled by both, but neither pulled nor deleted by that name.
  const noTag = resourceDetails(RESOURCES, `image:${UNTAGGED_ID}:<none>~2`)
  assert.deepEqual([noTag?.title, noTag?.pullRef, noTag?.removeRef], ['app:<none>', null, UNTAGGED_ID])
})

test('a volume card: its name and driver, deleted by name', () => {
  assert.deepEqual(resourceDetails(RESOURCES, 'volume:pgdata'), {
    kind: 'volume', key: 'volume:pgdata', title: 'pgdata', items: [{ label: 'Driver', value: 'local' }],
    removeRef: 'pgdata', removeBlocked: null, pullRef: null,
    removeText: 'The volume and its data are removed from the host. This cannot be undone.',
  })
})

test('a network card: its name, driver, scope and short id, deleted by id; built-in networks cannot be deleted', () => {
  assert.deepEqual(resourceDetails(RESOURCES, `network:${NET_ID}`), {
    kind: 'network', key: `network:${NET_ID}`, title: 'ml_default',
    items: [{ label: 'Driver', value: 'bridge' }, { label: 'Scope', value: 'local' }, { label: 'ID', value: '777777777777', code: true }],
    removeRef: NET_ID, removeBlocked: null, pullRef: null, removeText: 'The network is removed from the host. This cannot be undone.',
  })
  for (const id of ['a', 'b', 'c']) {
    const builtIn = resourceDetails(RESOURCES, `network:${id.repeat(64)}`)
    assert.deepEqual([builtIn?.removeRef, builtIn?.removeBlocked], [id.repeat(64), "Docker's built-in networks cannot be deleted."], id)
  }
})

test('no card for a key that is not an image, volume or network on this host', () => {
  for (const key of ['a'.repeat(64), 'repo:nginx', 'project:shop', 'volume:gone', `network:${'d'.repeat(64)}`, `image:${IMAGE_ID}:stable`, '']) {
    assert.equal(resourceDetails(RESOURCES, key), null, key)
  }
})

// The rows as the host lists them: the project's first container in the rows is not the first in the tree.
const PROJECT_ROWS = [
  c('1'.repeat(12), 'loose', 'exited'),
  c('2'.repeat(12), 'shop-web-1', 'running', { project: 'shop', service: 'web' }),
  c('3'.repeat(12), 'shop-web-2', 'exited', { project: 'shop', service: 'web' }),
  c('4'.repeat(12), 'shop-db-1', 'exited', { project: 'shop', service: 'db' }),
  c('5'.repeat(12), 'blog-app-1', 'running', { project: 'blog', service: 'app' }),
]

test('a Compose project card: its services, how many containers run, its first container in the rows, and which actions apply', () => {
  assert.deepEqual(projectDetails(PROJECT_ROWS, 'project:shop'), {
    key: 'project:shop', name: 'shop', memberId: '2'.repeat(12),
    items: [{ label: 'Services', value: '2' }, { label: 'Running', value: '1 / 3' }],
    canStart: true, canStop: true,
  })
  // Start needs a container that is not running (paused counts); Stop and Restart need one that runs.
  const project = (...states: ContainerState[]) =>
    projectDetails(states.map((s, i) => c(String(i).repeat(12), `p-${i}`, s, { project: 'p', service: `s${i}` })), 'project:p')
  assert.deepEqual([project('running', 'running')?.canStart, project('running', 'running')?.canStop], [false, true])
  assert.deepEqual([project('exited', 'created')?.canStart, project('exited', 'created')?.canStop], [true, false])
  assert.deepEqual([project('running', 'paused')?.canStart, project('running', 'paused')?.canStop], [true, true])
  assert.deepEqual(project('paused')?.items, [{ label: 'Services', value: '1' }, { label: 'Running', value: '0 / 1' }])
  // A container without a service label counts as a service of its own.
  const unlabelled = projectDetails([c('6'.repeat(12), 'a', 'running', { project: 'p' }), c('7'.repeat(12), 'b', 'running', { project: 'p' })], 'project:p')
  assert.deepEqual(unlabelled?.items[0], { label: 'Services', value: '2' })
})

test('no project card for a project with no containers, or for a key that is not a project row', () => {
  for (const key of ['project:gone', 'project:', 'project:Shop', '2'.repeat(12), 'repo:shop', 'volume:shop', 'shop', '']) {
    assert.equal(projectDetails(PROJECT_ROWS, key), null, key)
  }
  assert.equal(projectDetails([], 'project:shop'), null)
})

test('the project card in Korean: field names translated, the counts as they are', () => {
  assert.deepEqual(projectDetails(PROJECT_ROWS, 'project:blog', 'ko')?.items, [{ label: '서비스', value: '1' }, { label: '실행 중', value: '1 / 1' }])
  assert.deepEqual(projectDetails(PROJECT_ROWS, 'project:blog', 'en'), projectDetails(PROJECT_ROWS, 'project:blog'))
})

test('shownKey: whether the trees draw an item for this filter', () => {
  const shown = (filter: string, key: string) => shownKey(RESOURCES, filter, key)
  // Containers: grouped or not.
  assert.equal(shown('', 'a'.repeat(64)), true)
  assert.equal(shown('zeta', 'c'.repeat(64)), true)
  assert.equal(shown('zeta', 'a'.repeat(64)), false)
  assert.equal(shown('', 'f'.repeat(64)), false)
  // A Compose project row: drawn while the filter leaves it any container.
  assert.equal(shown('', 'project:shop'), true)
  assert.equal(shown('db', 'project:shop'), true)
  assert.equal(shown('zeta', 'project:shop'), false)
  assert.equal(shown('', 'project:gone'), false)
  // Images, volumes and networks.
  assert.equal(shown('', `image:${IMAGE_ID}:latest~2`), true)
  assert.equal(shown('nginx', `image:${IMAGE_ID}:latest`), true)
  assert.equal(shown('pg', `image:${IMAGE_ID}:latest`), false)
  assert.equal(shown('PG', 'volume:pgdata'), true)
  assert.equal(shown('ml', 'volume:pgdata'), false)
  assert.equal(shown('ml_', `network:${NET_ID}`), true)
  assert.equal(shown('pg', `network:${NET_ID}`), false)
  assert.equal(shown('', 'volume:gone'), false)
})

// Korean: the same functions with `ko`; what Docker, ssh and the worker say stays as it came.
test('problem copy in Korean: fixed titles and descriptions, the message as it came for invalid, failed, ssh-failed and startup-shell', () => {
  const expected: Record<Exclude<ProblemKind, 'invalid' | 'failed' | 'ssh-failed' | 'startup-shell'>, [string, string]> = {
    unsupported: ['여기서는 지원하지 않습니다', '이 버전은 macOS·Linux의 Orca와 Linux·macOS SSH 호스트를 지원합니다.'],
    unreachable: ['호스트에 연결할 수 없습니다', 'Orca가 이 호스트에 연결하지 못했습니다. Orca에서 이 호스트의 SSH 연결을 확인하세요.'],
    'no-workspace': ['이 호스트에 워크스페이스가 없습니다', '먼저 Orca에서 이 호스트의 워크스페이스를 여세요.'],
    'docker-missing': ['Docker CLI를 찾을 수 없습니다', '이 호스트에 docker 명령을 설치하세요.'],
    'daemon-down': ['Docker가 실행 중이 아닙니다', '이 호스트에서 Docker 데몬을 시작하세요.'],
    'permission-denied': ['권한이 없습니다', '지금 계정으로는 이 호스트의 Docker 소켓을 쓸 수 없습니다.'],
    truncated: ['목록이 너무 깁니다', '출력이 너무 커서 보여 줄 수 없습니다.'],
    timeout: ['시간이 초과되었습니다', 'Docker가 제시간에 응답하지 않았습니다.'],
    'unknown-result': ['결과를 알 수 없습니다', '명령은 보냈지만 결과가 돌아오지 않았습니다. 새로고침해서 확인하세요.'],
  }
  for (const [kind, [title, description]] of Object.entries(expected)) {
    assert.deepEqual(problemCopy({ kind: kind as ProblemKind, message: 'ignored' }, 'ko'), { title, description })
  }
  assert.deepEqual(problemCopy({ kind: 'invalid', message: 'bad id' }, 'ko'), { title: '잘못된 요청입니다', description: 'bad id' })
  assert.deepEqual(problemCopy({ kind: 'failed', message: 'boom' }, 'ko'), { title: '명령이 실패했습니다', description: 'boom' })
  const sshMessage = 'No ssh host named "GPU1" on this Mac. Add a "Host GPU1" entry with key login to ~/.ssh/config.'
  assert.deepEqual(problemCopy({ kind: 'ssh-failed', message: sshMessage }, 'ko'), { title: 'SSH 연결에 실패했습니다', description: sshMessage })
  const files = '.bashrc, .config/fish/config.fish'
  assert.deepEqual(problemCopy({ kind: 'startup-shell', message: files }, 'ko'), { title: '이 호스트는 tmux, screen 또는 byobu를 띄울 수 있습니다', description: files })
  // English stays the default, and `en` asks for it.
  assert.deepEqual(problemCopy({ kind: 'timeout', message: '' }, 'en'), { title: 'Timed out', description: 'Docker did not answer in time.' })
})

test('host options in Korean: the local host in Korean, SSH host names as they are, SSH in English, unsupported translated', () => {
  const options = hostOptions([
    host('local', 'This Mac', 'ready'), host('ssh:GPU1', 'GPU1', 'ready'), host('ssh:old', 'old', 'unsupported'),
  ], 'ko')
  assert.deepEqual(options, [
    { value: 'local', label: '이 Mac' },
    { value: 'ssh:GPU1', label: 'GPU1 (SSH)' },
    { value: 'ssh:old', label: 'old (SSH, 지원 안 함)', disabled: true },
  ])
  assert.deepEqual(hostOptions([host('local', 'Mac', 'unsupported')], 'ko'), [{ value: 'local', label: 'Mac (지원 안 함)', disabled: true }])
  assert.deepEqual(hostOptions([host('ssh:old', 'old', 'unsupported')], 'en'), [{ value: 'ssh:old', label: 'old (SSH, unsupported)', disabled: true }])
})

test('tree descriptions in Korean: counts translated, Docker values as they came', () => {
  const tree = containerTree(FIXTURE_CONTAINERS, '', 'ko')
  assert.deepEqual(tree.map((t) => [t.key, t.description]), [
    ['project:blog', 'Compose · 0/1 실행 중'], ['project:shop', 'Compose · 1/2 실행 중'], ['e'.repeat(64), 'img · Exited (0) 1 hour ago'], ['c'.repeat(64), 'img · Up 2 hours'],
  ])
  assert.deepEqual(tree[1]!.children?.map((t) => t.description), ['Exited (0) 1 hour ago', 'Up 2 hours'])
  // The keys and labels do not depend on the language.
  const strip = (items: readonly TreeItem[]): unknown => items.map((t) => [t.key, t.label, strip(t.children ?? [])])
  assert.deepEqual(strip(tree), strip(containerTree(FIXTURE_CONTAINERS, '')))
  const images = imageTree(FIXTURE_IMAGES, '', 'ko')
  assert.deepEqual(images.map((t) => t.description), ['태그 2개', '태그 2개', '태그 1개'])
  assert.deepEqual(images[1]!.children?.map((t) => t.description), ['10MB · 2 days ago', '10MB · 2 days ago'])
  assert.deepEqual(strip(images), strip(imageTree(FIXTURE_IMAGES, '')))
  assert.deepEqual(imageTree(FIXTURE_IMAGES, '', 'en').map((t) => t.description), ['2 tags', '2 tags', '1 tag'])
})

test('details cards in Korean: field names and delete copy translated, values as they came', () => {
  const full = containerDetails(c('0123456789abcdef', 'x', 'exited', { ports: '80/tcp', project: 'shop', service: 'web', status: 'Exited (1) 2 hours ago' }), 'ko')
  assert.deepEqual(full, [
    { label: '이미지', value: 'img' }, { label: '상태', value: 'Exited (1) 2 hours ago', tone: 'danger' }, { label: '포트', value: '80/tcp', code: true },
    { label: 'Compose', value: 'shop / web' }, { label: 'ID', value: '0123456789ab', code: true },
  ])
  const tag = resourceDetails(RESOURCES, `image:${IMAGE_ID}:latest`, 'ko')
  assert.deepEqual(tag, {
    kind: 'image', key: `image:${IMAGE_ID}:latest`, title: 'nginx:latest',
    items: [{ label: 'ID', value: '5f1e6a2b0c3d', code: true }, { label: '크기', value: '192MB' }, { label: '생성', value: '2 weeks ago' }],
    removeRef: 'nginx:latest', removeBlocked: null, pullRef: 'nginx:latest',
    removeText: '태그를 삭제하고, 이미지에 다른 태그가 없으면 이미지도 삭제합니다. 되돌릴 수 없습니다.',
  })
  assert.equal(resourceDetails(RESOURCES, `image:${UNTAGGED_ID}:<none>`, 'ko')?.removeText, '호스트에서 이미지를 삭제합니다. 되돌릴 수 없습니다.')
  const volume = resourceDetails(RESOURCES, 'volume:pgdata', 'ko')
  assert.deepEqual([volume?.items, volume?.removeText], [[{ label: '드라이버', value: 'local' }], '호스트에서 볼륨을 데이터와 함께 삭제합니다. 되돌릴 수 없습니다.'])
  const network = resourceDetails(RESOURCES, `network:${NET_ID}`, 'ko')
  assert.deepEqual([network?.items.map((i) => i.label), network?.removeText, network?.removeBlocked], [
    ['드라이버', '범위', 'ID'], '호스트에서 네트워크를 삭제합니다. 되돌릴 수 없습니다.', null,
  ])
  assert.equal(resourceDetails(RESOURCES, `network:${'a'.repeat(64)}`, 'ko')?.removeBlocked, 'Docker 기본 네트워크는 삭제할 수 없습니다.')
  // English stays the default, and `en` asks for it.
  assert.deepEqual(resourceDetails(RESOURCES, 'volume:pgdata', 'en'), resourceDetails(RESOURCES, 'volume:pgdata'))
  assert.deepEqual(containerDetails(c('x', 'x', 'running'), 'en').map((i) => i.label), ['Image', 'Status', 'ID'])
})
