import {
  Button, Callout, Card, CodeView, Collapsible, EmptyState, IconButton, Input, KeyValue, RelativeTime, Row, Select, Skeleton, Spinner, Stack,
  Switch, Text, Toolbar, Tree, atom, on, plugin, read, set, settings, update, type OrcaNode, type PanelContext, type Tone, type TreeItem,
} from 'orca'
import {
  allowedActions, containerDetails, containerTree, dueForRefresh, hostOptions, imageTree, logRefreshMs, logText, networkTree, nextHost,
  problemCopy, refreshMs, rejectionProblem, runningCount, volumeTree, type Allowed,
} from './panel-model'
import {
  REQUEST_TIMEOUT_MS, type ContainerAction, type ContainerRow, type FocusContext, type HostId, type HostInfo, type Problem, type Result,
  type Snapshot, type TerminalKind,
} from './protocol'

// What the panel shows for the selected host: the last snapshot it applied, the problem of the
// latest answer, and whether the latest request is still out (the in-flight flag).
type HostView = { hostId: HostId; snapshot: Snapshot | null; problem: Problem | null; loading: boolean }
// The container an action, its result or a delete question belongs to; the card draws only its own.
type Target = { hostId: HostId; id: string }
type PendingDelete = Target & { name: string }
// The log view under the card: its container, the cleaned text of the last answer it applied (null: none
// yet), the problem of the latest answer, and whether its logs are still on the way.
type LogView = Target & { text: string | null; takenAt: number | null; problem: Problem | null; loading: boolean }

const selectedHost = atom<HostId | null>('selectedHost', null, { persist: 'plugin' })
const followFocus = atom<boolean>('followFocus', true, { persist: 'plugin' })
const hostList = atom<HostInfo[] | null>(null)
const hostsProblem = atom<Problem | null>(null)
const hostsLoading = atom(false)
const hostView = atom<HostView | null>(null)
const selection = atom<string | null>(null)
const pendingDelete = atom<PendingDelete | null>(null)
const working = atom(false)
// Both clear on the next action or a host change.
const actionProblem = atom<(Target & { problem: Problem }) | null>(null)
// "Opened logs in <workspace>." after a Logs/Shell tab opened in the background.
const openedNote = atom<(Target & { text: string }) | null>(null)
// Open for the selected container only: it follows the selection and closes when the selection clears.
const logView = atom<LogView | null>(null)
const filterText = atom('filter', '')
type Section = 'containers' | 'images' | 'volumes' | 'networks'
const SECTIONS_OPEN: Record<Section, boolean> = { containers: true, images: false, volumes: false, networks: false }
const sectionsOpen = atom<Record<Section, boolean>>('sections', SECTIONS_OPEN, { persist: 'plugin' })
// Compose projects the person collapsed; every other project the tree draws is expanded, new ones included.
const collapsedProjects = atom<string[]>([])

// Per panel run, reset by setup: plain values the screen does not draw.
type Run = {
  signal: AbortSignal
  generation: number
  lastAt: number | null
  settings: Record<string, unknown>
  focus: FocusContext | null
  focusGeneration: number
  // The last ok matchFocus answer (undefined: none yet). Follow acts only when it changes.
  lastMatch: HostId | null | undefined
  // The next ok answer is followed even if it equals lastMatch (the switch was just turned on).
  forceFollow: boolean
  // A focus match that arrived before the host list; used once the list loads.
  earlyMatch: HostId | null
  logGeneration: number
  logLastAt: number | null
  // One logs request at a time per view: a refresh asked for while one is out for the same generation waits
  // for it (logWanted), then asks for whatever the view shows by then. Over SSH a second request would only
  // queue behind the first. logFlight is the generation the request out was sent for (null: none); after a
  // close (a host change, say) it is an older one, so the new view asks at once instead of waiting.
  logFlight: number | null
  logWanted: boolean
}
let run: Run = newRun(AbortSignal.abort())

function newRun(signal: AbortSignal): Run {
  return {
    signal, generation: 0, lastAt: null, settings: {}, focus: null, focusGeneration: 0, lastMatch: undefined, forceFollow: false,
    earlyMatch: null, logGeneration: 0, logLastAt: null, logFlight: null, logWanted: false,
  }
}
const alive = (r: Run) => r === run && !r.signal.aborted
const DOCKER_REQUEST = { timeoutMs: REQUEST_TIMEOUT_MS }
// The worker gives each Orca CLI host listing 10 s, and focus matching may also list local terminals.
const HOSTS_REQUEST = { timeoutMs: 60_000 }

async function answerOf<T>(request: () => Promise<Result<T>>): Promise<Result<T>> {
  try {
    return await request()
  } catch (error) {
    return { ok: false, problem: rejectionProblem(error) }
  }
}

function selectHost(hostId: HostId | null): void {
  set(selectedHost, hostId)
  clearSelection()
  set(collapsedProjects, [])
  set(actionProblem, null)
  set(openedNote, null)
  run.lastAt = null
  if (hostId === null) {
    set(hostView, null)
    return
  }
  set(hostView, { hostId, snapshot: null, problem: null, loading: true })
  void refreshSnapshot()
}

async function refreshSnapshot(): Promise<void> {
  const hostId = read(selectedHost)
  const current = read(hostView)
  if (hostId === null || current === null || current.hostId !== hostId) return
  const r = run
  const generation = ++r.generation
  set(hostView, { ...current, loading: true })
  const answer = await answerOf(() => plugin.request('docker.snapshot', { hostId }, DOCKER_REQUEST))
  // Only the newest request counts, and only while its host is still the one selected.
  if (!alive(r) || generation !== r.generation || read(selectedHost) !== hostId) return
  r.lastAt = Date.now()
  const before = read(hostView)
  if (!answer.ok) {
    set(hostView, { hostId, snapshot: before?.snapshot ?? null, problem: answer.problem, loading: false })
    return
  }
  set(hostView, { hostId, snapshot: answer.value, problem: null, loading: false })
  // Gone, or no longer in the tree the filter leaves.
  const selected = read(selection)
  if (selected !== null && !shownInTree(answer.value.containers, read(filterText), selected)) clearSelection()
  const pending = read(pendingDelete)
  const pinned = pending === null ? undefined : answer.value.containers.find((c) => c.id === pending.id)
  // Gone, or now in a state where removing is not allowed (e.g. it started running).
  if (pending !== null && (pinned === undefined || !allowedActions(pinned.state).remove)) set(pendingDelete, null)
}

// `refresh` (the Refresh button) makes the worker read the hosts again and forget the kernels it remembered.
async function loadHosts(refresh = false): Promise<void> {
  const r = run
  set(hostsLoading, true)
  const answer = await answerOf(() => plugin.request('hosts.list', { refresh }, HOSTS_REQUEST))
  if (!alive(r)) return
  set(hostsLoading, false)
  if (!answer.ok) {
    set(hostsProblem, answer.problem) // the last good list stays
    return
  }
  set(hostsProblem, null)
  const hosts = answer.value.hosts
  set(hostList, hosts)
  const next = nextHost(read(selectedHost), r.earlyMatch, read(followFocus), hosts)
  r.earlyMatch = null
  if (next !== read(selectedHost) || read(hostView) === null) selectHost(next)
}

async function refreshAll(): Promise<void> {
  const before = read(selectedHost)
  await loadHosts(true)
  // A changed selection has already started its own snapshot.
  if (read(selectedHost) === before) await refreshSnapshot()
}

async function follow(focus: FocusContext): Promise<void> {
  const r = run
  const generation = ++r.focusGeneration
  const answer = await answerOf(() => plugin.request('hosts.matchFocus', focus, HOSTS_REQUEST))
  if (!alive(r) || generation !== r.focusGeneration || !answer.ok) return
  const matched = answer.value.hostId
  const changed = r.forceFollow || matched !== r.lastMatch
  r.lastMatch = matched
  r.forceFollow = false
  // The same match again (e.g. a terminal opened) must not undo a host the person picked.
  if (!changed) return
  const hosts = read(hostList)
  if (hosts === null) {
    r.earlyMatch = matched
    return
  }
  const next = nextHost(read(selectedHost), matched, read(followFocus), hosts)
  if (next !== read(selectedHost)) selectHost(next)
}

function setFollow(on: boolean): void {
  set(followFocus, on)
  const focus = on ? run.focus : null
  run.forceFollow = focus !== null
  if (focus !== null) void follow(focus)
}

const sameFocus = (a: FocusContext, b: FocusContext) =>
  a.displayName === b.displayName && a.branch === b.branch &&
  a.terminalIds.length === b.terminalIds.length && a.terminalIds.every((id, i) => id === b.terminalIds[i])

async function loadSettings(r: Run): Promise<void> {
  try {
    const values = await settings.get()
    if (alive(r)) r.settings = values
  } catch {
    // Keep the last values; refreshMs falls back to the defaults.
  }
}

// Runs one command for `target`; the whole Toolbar is disabled until it ends. `onOk` sees a success on the same host.
async function runCommand<T>(target: Target, send: () => Promise<Result<T>>, refreshAfter: boolean, onOk?: (value: T) => void): Promise<void> {
  if (read(working)) return
  const r = run
  set(working, true)
  set(actionProblem, null)
  set(openedNote, null)
  const answer = await answerOf(send)
  if (!alive(r)) return
  set(working, false)
  if (read(selectedHost) !== target.hostId) return
  if (!answer.ok) set(actionProblem, { ...target, problem: answer.problem })
  else onOk?.(answer.value)
  if (refreshAfter) await refreshSnapshot()
}

function containerAction(hostId: HostId, action: ContainerAction, containerId: string): Promise<void> {
  return runCommand({ hostId, id: containerId }, () => plugin.request('docker.action', { hostId, action, containerId }, DOCKER_REQUEST), true)
}

// The tab opens in the background (the plugin API cannot focus it), so the panel says where it is.
function openTerminal(hostId: HostId, kind: TerminalKind, containerId: string, containerName: string): Promise<void> {
  const target = { hostId, id: containerId }
  return runCommand(target, () => plugin.request('docker.openTerminal', { hostId, kind, containerId, containerName }, DOCKER_REQUEST), false,
    ({ workspace }) => set(openedNote, { ...target, text: `Opened ${kind} in ${workspace}.` }))
}

// Shows the log view for this container, fetching at once; for the container it already shows, a fetch now.
function openLogs(hostId: HostId, containerId: string): void {
  const current = read(logView)
  if (current !== null && current.hostId === hostId && current.id === containerId) {
    if (!current.loading) void refreshLogs()
    return
  }
  set(logView, { hostId, id: containerId, text: null, takenAt: null, problem: null, loading: true })
  run.logLastAt = null
  void refreshLogs()
}

function closeLogs(): void {
  if (read(logView) === null) return
  set(logView, null)
  // An answer still out is dropped, and nothing waits for it any more.
  run.logGeneration++
  run.logWanted = false
  run.logLastAt = null
}

async function refreshLogs(): Promise<void> {
  const current = read(logView)
  if (current === null) return
  const r = run
  if (!current.loading) set(logView, { ...current, loading: true })
  if (r.logFlight === r.logGeneration) {
    r.logWanted = true
    return
  }
  const { hostId, id } = current
  const generation = ++r.logGeneration
  r.logFlight = generation
  const answer = await answerOf(() => plugin.request('docker.logs', { hostId, containerId: id }, DOCKER_REQUEST))
  if (!alive(r)) return
  // Only its own flight ends here: an answer from before a close leaves the newer request and its wait alone.
  if (r.logFlight === generation) {
    r.logFlight = null
    // Asked for again meanwhile: this answer is dropped and the view's container is asked for now.
    if (r.logWanted) {
      r.logWanted = false
      void refreshLogs()
      return
    }
  }
  // Only the newest request counts, and only while its container and host are still the ones selected.
  const now = read(logView)
  const shown = now !== null && now.hostId === read(selectedHost) && now.id === read(selection) ? now : null
  if (generation !== r.logGeneration || shown === null || shown.hostId !== hostId || shown.id !== id) {
    // A dropped answer must not leave the shown view loading with no request out for it.
    if (shown?.loading === true && r.logFlight !== r.logGeneration) void refreshLogs()
    return
  }
  r.logLastAt = Date.now()
  if (!answer.ok) set(logView, { ...shown, problem: answer.problem, loading: false }) // the text it had stays
  else set(logView, { ...shown, text: logText(answer.value.lines), takenAt: answer.value.takenAt, problem: null, loading: false })
}

function confirmDelete(): void {
  const pinned = read(pendingDelete)
  if (pinned === null) return
  set(pendingDelete, null)
  void containerAction(pinned.hostId, 'remove', pinned.id)
}

// The selection, a pending delete and the log view change together: a delete question never outlives its
// container's card, and an open log view switches to the container picked next.
function changeSelection(next: string): void {
  if (next === read(selection)) return
  set(selection, next)
  set(pendingDelete, null)
  const logs = read(logView)
  if (logs !== null) openLogs(logs.hostId, next)
}

function clearSelection(): void {
  set(selection, null)
  set(pendingDelete, null)
  closeLogs()
}

function shownInTree(rows: readonly ContainerRow[], filter: string, id: string): boolean {
  return containerTree(rows, filter).some((item) => item.key === id || item.children?.some((child) => child.key === id) === true)
}

function changeFilter(text: string): void {
  set(filterText, text)
  const selected = read(selection)
  if (selected !== null && !shownInTree(read(hostView)?.snapshot?.containers ?? [], text, selected)) clearSelection()
}

function setSectionOpen(section: Section, open: boolean): void {
  update(sectionsOpen, (before) => ({ ...SECTIONS_OPEN, ...before, [section]: open }))
  // Closing the section hides the card, so a delete question and the log view there are dropped.
  if (section === 'containers' && !open) {
    set(pendingDelete, null)
    closeLogs()
  }
}

function toggleProject(key: string, expanded: boolean): void {
  update(collapsedProjects, (before) => expanded ? before.filter((k) => k !== key) : before.includes(key) ? before : [...before, key])
}

// Tree keys are container ids or `project:<name>`; only a container id picks or opens anything (a group row toggles).
function containerOf(key: string): ContainerRow | null {
  return read(hostView)?.snapshot?.containers.find((c) => c.id === key) ?? null
}

function pickItem(key: string): void {
  if (containerOf(key) !== null) changeSelection(key)
  else if (key.startsWith('project:')) toggleProject(key, read(collapsedProjects).includes(key))
}

// Enter or a double click: the container becomes the selected one and its log view opens under its card,
// as the Logs button would (which is disabled while an action runs).
function activateItem(hostId: HostId, key: string): void {
  const container = containerOf(key)
  if (container === null) return
  changeSelection(container.id)
  if (!read(working)) openLogs(hostId, container.id)
}

export function setup(ctx: PanelContext): void {
  const r = newRun(ctx.signal)
  run = r
  void loadSettings(r)
  ctx.subscriptions.push(settings.onDidChange(() => void loadSettings(r)))
  // Orca also sends this when the focused workspace's terminals open, close or are renamed.
  ctx.subscriptions.push(on('workspace.changed', ({ context }) => {
    if (context === null) {
      r.focus = null
      return
    }
    const focus = { displayName: context.displayName, branch: context.branch, terminalIds: context.terminals.map((t) => t.id) }
    if (r.focus !== null && sameFocus(r.focus, focus)) return
    r.focus = focus
    if (read(followFocus)) void follow(focus)
  }))
  const tick = () => {
    const hostId = read(selectedHost)
    const current = read(hostView)
    if (hostId === null || current === null) return
    const visible = read(ctx.visible)
    if (dueForRefresh(Date.now(), r.lastAt, visible, refreshMs(hostId, r.settings), current.loading)) void refreshSnapshot()
    const logs = read(logView)
    if (logs !== null && logs.hostId === hostId && logs.id === read(selection) &&
      dueForRefresh(Date.now(), r.logLastAt, visible, logRefreshMs(hostId), logs.loading)) void refreshLogs()
  }
  const timer = setInterval(tick, 1000)
  ctx.subscriptions.push({ dispose: () => clearInterval(timer) })
  void loadHosts()
}

function problemState(problem: Problem): OrcaNode {
  const copy = problemCopy(problem)
  return (
    <EmptyState title={copy.title} icon="warning">
      <Text muted>{copy.description}</Text>
    </EmptyState>
  )
}

function problemCallout(problem: Problem, tone: Tone, key: string): OrcaNode {
  const copy = problemCopy(problem)
  return (
    <Callout key={key} tone={tone} title={copy.title}>
      <Text>{copy.description}</Text>
    </Callout>
  )
}

function detailsCard(view: HostView, container: ContainerRow): OrcaNode {
  const busy = read(working)
  const allowed = allowedActions(container.state)
  const can = (name: keyof Allowed) => !busy && allowed[name]
  const act = (action: ContainerAction) => () => void containerAction(view.hostId, action, container.id)
  const terminal = (kind: TerminalKind) => () => void openTerminal(view.hostId, kind, container.id, container.name)
  const showLogs = () => openLogs(view.hostId, container.id)
  const askDelete = () => set(pendingDelete, { hostId: view.hostId, id: container.id, name: container.name })
  // A question, problem or note for another container (or host) is not drawn here.
  const own = <T extends Target>(value: T | null): T | null =>
    value !== null && value.hostId === view.hostId && value.id === container.id ? value : null
  const pending = own(read(pendingDelete))
  const problem = own(read(actionProblem))?.problem ?? null
  const opened = own(read(openedNote))?.text ?? null
  return (
    <Card key="details" title={container.name} description={container.state}>
      <Stack gap="sm">
        <KeyValue items={containerDetails(container)} />
        <Row gap="sm" align="center" wrap>
          <Toolbar label="Container actions">
            <Button key="start" size="sm" icon="play" disabled={!can('start')} onPress={act('start')}>Start</Button>
            <Button key="stop" size="sm" icon="stop" disabled={!can('stop')} onPress={act('stop')}>Stop</Button>
            <Button key="restart" size="sm" icon="refresh" disabled={!can('restart')} onPress={act('restart')}>Restart</Button>
            <Button key="logs" size="sm" icon="file-text" disabled={!can('logs')} onPress={showLogs}>Logs</Button>
            <Button key="shell" size="sm" icon="terminal" disabled={!can('shell')} onPress={terminal('shell')}>Shell</Button>
            <Button key="delete" size="sm" icon="delete" tone="danger" variant="outline" disabled={!can('remove')} onPress={askDelete}>Delete</Button>
          </Toolbar>
          {busy ? <Spinner label="Working" /> : null}
        </Row>
        {opened === null ? null : <Text muted size="sm">{opened}</Text>}
        {pending === null ? null : (
          <Callout key="confirm" tone="danger" title={`Delete ${pending.name}?`}>
            <Stack gap="sm">
              <Text>The container is removed from the host. This cannot be undone.</Text>
              <Row gap="xs">
                <Button key="confirm-delete" tone="danger" disabled={busy} onPress={confirmDelete}>Delete</Button>
                <Button key="cancel-delete" variant="ghost" onPress={() => set(pendingDelete, null)}>Cancel</Button>
              </Row>
            </Stack>
          </Callout>
        )}
        {problem === null ? null : problemCallout(problem, 'danger', 'action-problem')}
      </Stack>
    </Card>
  )
}

// Before any lines: the problem or a placeholder. After: the lines, under the problem of a later failed refresh.
function logBody(logs: LogView): OrcaNode {
  if (logs.text === null) {
    if (logs.problem !== null) return problemState(logs.problem)
    return <Skeleton key="logs-loading" label="Loading logs" lines={3} />
  }
  return (
    <Stack gap="xs">
      {logs.problem === null ? null : problemCallout(logs.problem, 'warning', 'logs-problem')}
      {logs.text.trim() === ''
        ? <Text key="no-logs" muted size="sm">No log output</Text>
        : <CodeView key="logs-code" label="Logs" code={logs.text} wrap maxHeight="md" />}
    </Stack>
  )
}

// Under the card: the last lines of the container's logs, refreshed while the panel is visible.
// "Open in terminal" follows them live in an Orca terminal, as the Logs button did before.
function logSection(view: HostView, container: ContainerRow, logs: LogView): OrcaNode {
  const busy = read(working)
  return (
    <Stack key="logs" gap="xs">
      <Row key="logs-header" gap="xs" align="center" justify="between" wrap>
        {logs.takenAt === null ? <Text muted size="xs">Logs</Text> : <Text muted size="xs">Logs updated <RelativeTime at={logs.takenAt} /></Text>}
        <Row gap="xs" align="center">
          <IconButton key="refresh-logs" icon="refresh" label="Refresh logs" size="sm" variant="ghost" disabled={logs.loading}
            onPress={() => void refreshLogs()} />
          <Button key="logs-terminal" size="sm" variant="ghost" icon="terminal" disabled={busy}
            onPress={() => void openTerminal(view.hostId, 'logs', container.id, container.name)}>Open in terminal</Button>
          <IconButton key="close-logs" icon="close" label="Close logs" size="sm" variant="ghost" onPress={closeLogs} />
        </Row>
      </Row>
      {logBody(logs)}
    </Stack>
  )
}

// A muted line in place of an empty tree: the host has none, or the filter left none.
function emptyLine(noun: string, total: number): OrcaNode {
  return <Text key="empty" muted size="sm">{total === 0 ? `No ${noun}` : `No ${noun} match the filter`}</Text>
}

function containersBody(view: HostView, snapshot: Snapshot, filter: string): OrcaNode {
  const rows = snapshot.containers
  const items = containerTree(rows, filter)
  const selected = read(selection)
  const container = rows.find((c) => c.id === selected) ?? null
  const logs = read(logView)
  const ownLogs = logs !== null && container !== null && logs.hostId === view.hostId && logs.id === container.id ? logs : null
  const collapsed = read(collapsedProjects)
  return (
    <Stack gap="sm">
      {items.length === 0 ? emptyLine('containers', rows.length) : (
        <Tree
          key="containers-tree"
          label="Containers"
          items={items}
          maxHeight="lg"
          // '' keeps the Tree controlled when nothing is selected; undefined would let it keep its own pick.
          selected={selected ?? ''}
          expanded={items.filter((item) => item.children !== undefined && !collapsed.includes(item.key)).map((item) => item.key)}
          onSelect={({ key }) => pickItem(key)}
          onToggle={({ key, expanded }) => toggleProject(key, expanded)}
          onAction={({ key }) => activateItem(view.hostId, key)}
        />
      )}
      {container === null ? null : detailsCard(view, container)}
      {container === null || ownLogs === null ? null : logSection(view, container, ownLogs)}
    </Stack>
  )
}

function readOnlyTree(label: string, noun: string, items: TreeItem[], total: number): OrcaNode {
  return items.length === 0 ? emptyLine(noun, total) : <Tree key={`${noun}-tree`} label={label} items={items} maxHeight="lg" />
}

// A closed section draws nothing inside, so hundreds of images cost nothing until it opens.
function section(id: Section, title: string, description: string, body: () => OrcaNode): OrcaNode {
  const open = { ...SECTIONS_OPEN, ...read(sectionsOpen) }[id] === true
  return (
    <Collapsible key={id} title={title} description={description} open={open} onChange={(next) => setSectionOpen(id, next)}>
      {open ? body() : null}
    </Collapsible>
  )
}

function hostBody(): OrcaNode {
  const hosts = read(hostList)
  if (hosts === null) {
    const problem = read(hostsProblem)
    return problem === null ? <Skeleton label="Loading hosts" lines={3} /> : null
  }
  const view = read(hostView)
  if (view === null) {
    return (
      <EmptyState title="No host is ready" icon="info">
        <Text muted>Pick a host above when one becomes ready.</Text>
      </EmptyState>
    )
  }
  const snapshot = view.snapshot
  if (snapshot === null) {
    if (view.problem !== null) return problemState(view.problem)
    return <Skeleton label="Loading containers" lines={4} />
  }
  const filter = read(filterText)
  const { containers, images, volumes, networks } = snapshot
  return (
    <Stack gap="sm">
      {view.problem === null ? null : problemCallout(view.problem, 'warning', 'snapshot-problem')}
      {section('containers', 'Containers', `${runningCount(containers)} running / ${containers.length}`,
        () => containersBody(view, snapshot, filter))}
      {section('images', 'Images', `${images.length}`, () => readOnlyTree('Images', 'images', imageTree(images, filter), images.length))}
      {section('volumes', 'Volumes', `${volumes.length}`,
        () => readOnlyTree('Volumes', 'volumes', volumeTree(volumes, filter), volumes.length))}
      {section('networks', 'Networks', `${networks.length}`,
        () => readOnlyTree('Networks', 'networks', networkTree(networks, filter), networks.length))}
    </Stack>
  )
}

export default function Panel() {
  const hosts = read(hostList)
  const hostId = read(selectedHost)
  const view = read(hostView)
  const hostsFailure = read(hostsProblem)
  const refreshing = read(hostsLoading) || view?.loading === true
  const takenAt = view?.snapshot?.takenAt
  return (
    <Stack gap="sm">
      <Row gap="xs" align="end">
        <Select
          label="Host"
          options={hostOptions(hosts ?? [])}
          value={hostId ?? undefined}
          placeholder="Choose a host"
          onChange={(value) => {
            const picked = hosts?.find((h) => h.id === value)
            if (picked !== undefined && picked.id !== read(selectedHost)) selectHost(picked.id)
          }}
        />
        <IconButton icon="refresh" label="Refresh" disabled={refreshing} onPress={() => void refreshAll()} />
      </Row>
      <Row gap="sm" align="center" justify="between" wrap>
        <Switch label="Follow focused workspace" checked={read(followFocus)} onChange={setFollow} />
        {takenAt === undefined ? null : <Text muted size="xs">Updated <RelativeTime at={takenAt} /></Text>}
      </Row>
      <Input
        label="Filter"
        labelHidden
        type="search"
        placeholder="Filter containers, images…"
        value={read(filterText)}
        onChange={changeFilter}
      />
      {hostsFailure === null ? null : problemCallout(hostsFailure, 'warning', 'hosts-problem')}
      {hostBody()}
    </Stack>
  )
}
