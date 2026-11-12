import {
  Button, Callout, Card, CodeView, Collapsible, EmptyState, IconButton, Input, KeyValue, RelativeTime, Row, Select, Skeleton, Spinner, Stack,
  Switch, Text, Toolbar, Tree, atom, env, on, plugin, read, set, settings, update, type OrcaNode, type PanelContext, type Tone, type TreeItem,
} from 'orca'
import { isImageRef } from './docker/commands'
import { messages, resolveLang, type Lang, type Messages } from './i18n'
import {
  allowedActions, containerDetails, containerTree, dueForRefresh, hostOptions, imageTree, logRefreshMs, logText, networkTree, nextHost,
  problemCopy, projectDetails, refreshMs, rejectionProblem, resourceDetails, resourceKindOf, runningCount, shownKey, volumeTree, type Allowed,
  type ProjectDetails, type ResourceDetails,
} from './panel-model'
import {
  REQUEST_TIMEOUT_MS, type ComposeAction, type ContainerAction, type ContainerRow, type FocusContext, type HostId, type HostInfo, type Opened,
  type Problem, type ResourceKind, type Result, type Snapshot, type TerminalKind,
} from './protocol'

// What the panel shows for the selected host: the last snapshot it applied, the problem of the
// latest answer, and whether the latest request is still out (the in-flight flag).
type HostView = { hostId: HostId; snapshot: Snapshot | null; problem: Problem | null; loading: boolean }
// The item an action, its result or a delete question belongs to: a container id, a Compose project, image, volume
// or network tree key, or PULL_ROW. The card (or the pull row) draws only its own.
type Target = { hostId: HostId; id: string }
// A delete question, or a Compose project's Down question (kind `project`). `ref` is what the delete sends: the
// container id, the image reference or id, volume name or network id; for a project, its name.
type PendingDelete = Target & { name: string; kind: 'container' | 'project' | ResourceKind; ref: string }
// The log view under the card: its container, the cleaned text of the last answer it applied (null: none
// yet), the problem of the latest answer, and whether its logs are still on the way.
type LogView = Target & { text: string | null; takenAt: number | null; problem: Problem | null; loading: boolean }

const selectedHost = atom<HostId | null>('selectedHost', null, { persist: 'plugin' })
const followFocus = atom<boolean>('followFocus', true, { persist: 'plugin' })
const hostList = atom<HostInfo[] | null>(null)
const hostsProblem = atom<Problem | null>(null)
const hostsLoading = atom(false)
const hostView = atom<HostView | null>(null)
// A tree key: a container id, a Compose project row, or an image tag, volume or network row. Repository rows are
// never selected.
const selection = atom<string | null>(null)
const pendingDelete = atom<PendingDelete | null>(null)
const working = atom(false)
// An action's problem. A terminal request's also keeps Open anyway, which a startup-shell answer offers: that request
// again, past the check of the host's login files.
type ActionProblem = Target & { problem: Problem; openAnyway?: () => Promise<void> }
// Both clear on the next action or a host change.
const actionProblem = atom<ActionProblem | null>(null)
// "Opened logs in <workspace>." after a Logs, Shell, Pull or Up tab opened in the background; drawn in the language shown.
const openedNote = atom<(Target & { text: (m: Messages) => string }) | null>(null)
// Open for the selected container only: it follows the selection and closes when the selection clears.
const logView = atom<LogView | null>(null)
const filterText = atom('filter', '')
type Section = 'containers' | 'images' | 'volumes' | 'networks'
const SECTIONS_OPEN: Record<Section, boolean> = { containers: true, images: false, volumes: false, networks: false }
const sectionsOpen = atom<Record<Section, boolean>>('sections', SECTIONS_OPEN, { persist: 'plugin' })
// Compose projects the person collapsed; every other project the tree draws is expanded, new ones included.
const collapsedProjects = atom<string[]>([])
// Image repositories the person expanded; the others stay collapsed.
const expandedRepos = atom<string[]>([])
// The Images section's "Image to pull" field, and whether its last Pull was refused as not an image name.
const pullText = atom('')
const pullInvalid = atom(false)
// The Target id of the pull row's problem and note; no tree key looks like it.
const PULL_ROW = 'pull-by-name'
// The plugin's Language setting as last read (auto, en, ko, or anything else); with Orca's locale it picks the copy.
const languageSetting = atom<unknown>(undefined)

// Read while drawing, so a change of the setting draws the panel again; Orca's locale is read as it is.
function uiLang(): Lang {
  return resolveLang(read(languageSetting), env.locale)
}

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
  set(expandedRepos, [])
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
  if (selected !== null && !shownKey(answer.value, read(filterText), selected)) clearSelection()
  const pending = read(pendingDelete)
  if (pending !== null && !stillRemovable(answer.value, pending)) set(pendingDelete, null)
  // A problem or note goes with its item: one that comes back under the same key (a project brought up again, a
  // volume made again) starts clean. An item the filter only hides keeps them; the pull row is no item.
  const gone = (owner: Target | null) => owner !== null && owner.id !== PULL_ROW && !shownKey(answer.value, '', owner.id)
  if (gone(read(actionProblem))) set(actionProblem, null)
  if (gone(read(openedNote))) set(openedNote, null)
}

// A container must still be there in a state that allows removing it (it may have started running); a Compose
// project must still have a container; an image, volume or network must still be there under its key and be
// deleted by the same reference.
function stillRemovable(snapshot: Snapshot, pending: PendingDelete): boolean {
  if (pending.kind === 'container') {
    const pinned = snapshot.containers.find((c) => c.id === pending.id)
    return pinned !== undefined && allowedActions(pinned.state).remove
  }
  if (pending.kind === 'project') return projectDetails(snapshot.containers, pending.id) !== null
  const details = resourceDetails(snapshot, pending.id)
  return details !== null && details.removeBlocked === null && details.removeRef === pending.ref
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
    if (!alive(r)) return
    r.settings = values
    set(languageSetting, values.language)
  } catch {
    // Keep the last values; refreshMs falls back to the defaults.
  }
}

// Runs one command for `target`; every Toolbar and Pull button is disabled until it ends. `onOk` sees a success on the same host;
// `openAnyway` goes with a problem on the same host.
async function runCommand<T>(
  target: Target, send: () => Promise<Result<T>>, refreshAfter: boolean, onOk?: (value: T) => void, openAnyway?: () => Promise<void>,
): Promise<void> {
  if (read(working)) return
  const r = run
  set(working, true)
  set(actionProblem, null)
  set(openedNote, null)
  const answer = await answerOf(send)
  if (!alive(r)) return
  set(working, false)
  if (read(selectedHost) !== target.hostId) return
  if (!answer.ok) set(actionProblem, { ...target, problem: answer.problem, openAnyway })
  else onOk?.(answer.value)
  if (refreshAfter) await refreshSnapshot()
}

function containerAction(hostId: HostId, action: ContainerAction, containerId: string): Promise<void> {
  return runCommand({ hostId, id: containerId }, () => plugin.request('docker.action', { hostId, action, containerId }, DOCKER_REQUEST), true)
}

// What Open anyway adds to a terminal request; nothing otherwise.
type StartupShell = { allowStartupShell?: true }

// Opens a terminal tab for `target`: `send` sends one terminal request, its input fixed when the button was pressed, with
// `extra` added. The tab opens in the background (the plugin API cannot focus it), so the panel says where it is. Open
// anyway sends exactly that input again with allowStartupShell, on its own press only.
function openTab(
  target: Target, send: (extra: StartupShell) => Promise<Result<Opened>>, note: (m: Messages, workspace: string) => string, extra: StartupShell = {},
): Promise<void> {
  return runCommand(target, () => send(extra), false, ({ workspace }) => set(openedNote, { ...target, text: (m) => note(m, workspace) }),
    () => openTab(target, send, note, { allowStartupShell: true }))
}

function openTerminal(hostId: HostId, kind: TerminalKind, containerId: string, containerName: string): Promise<void> {
  const input = { hostId, kind, containerId, containerName }
  return openTab({ hostId, id: containerId }, (extra) => plugin.request('docker.openTerminal', { ...input, ...extra }, DOCKER_REQUEST),
    (m, workspace) => m.openedTerminal[kind](workspace))
}

// Opens `docker pull <ref>` in a terminal on the host, as Shell does; the note and a problem go to `target`
// (an image tag's card, or the pull row).
function pullImage(hostId: HostId, targetId: string, ref: string): Promise<void> {
  const input = { hostId, ref }
  return openTab({ hostId, id: targetId }, (extra) => plugin.request('docker.pullTerminal', { ...input, ...extra }, DOCKER_REQUEST),
    (m, workspace) => m.openedPull(ref, workspace))
}

// Start, Stop, Restart or Down for the whole project, as one compose command in the panel, then the host is read
// again. `memberId` comes from the rows shown now (see projectDetails).
function projectAction(hostId: HostId, key: string, action: ComposeAction): Promise<void> {
  const project = projectOf(key)
  if (project === null) return Promise.resolve()
  const { name, memberId } = project
  return runCommand({ hostId, id: key }, () =>
    plugin.request('docker.composeAction', { hostId, project: name, memberId, action }, DOCKER_REQUEST), true)
}

// Opens `docker compose … up -d` in a terminal on the host, as Pull does (it may pull or build for long), and says where.
function composeUp(hostId: HostId, key: string): Promise<void> {
  const project = projectOf(key)
  if (project === null) return Promise.resolve()
  const { name, memberId } = project
  const input = { hostId, project: name, memberId }
  return openTab({ hostId, id: key }, (extra) => plugin.request('docker.composeUp', { ...input, ...extra }, DOCKER_REQUEST),
    (m, workspace) => m.openedComposeUp(name, workspace))
}

// The same rule the worker applies; a refused name stays in the field with an error under it, and nothing is sent.
function pullByName(hostId: HostId): void {
  const ref = read(pullText).trim()
  if (!isImageRef(ref)) {
    set(pullInvalid, true)
    return
  }
  set(pullInvalid, false)
  void pullImage(hostId, PULL_ROW, ref)
}

// A new name also drops the pull row's startup-shell warning: its Open anyway would pull the name pressed before.
function changePullText(text: string): void {
  const changed = text !== read(pullText)
  set(pullText, text)
  set(pullInvalid, false)
  const problem = read(actionProblem)
  if (changed && problem !== null && problem.id === PULL_ROW && problem.problem.kind === 'startup-shell') set(actionProblem, null)
}

// Never forced: Docker refuses an item in use, and its answer shows on the card. A delete that went through
// clears the selection, unless the person has picked something else meanwhile.
function removeResource(hostId: HostId, key: string, kind: ResourceKind, ref: string): Promise<void> {
  return runCommand({ hostId, id: key }, () => plugin.request('docker.removeResource', { hostId, kind, ref }, DOCKER_REQUEST), true, () => {
    if (read(selection) === key) clearSelection()
  })
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
  if (pinned.kind === 'container') void containerAction(pinned.hostId, 'remove', pinned.id)
  else if (pinned.kind === 'project') void projectAction(pinned.hostId, pinned.id, 'down')
  else void removeResource(pinned.hostId, pinned.id, pinned.kind, pinned.ref)
}

// The selection, a pending delete and the log view change together: a delete question never outlives its
// card, and an open log view switches to the container picked next, or closes for anything else.
function changeSelection(next: string): void {
  if (next === read(selection)) return
  set(selection, next)
  set(pendingDelete, null)
  const logs = read(logView)
  if (logs === null) return
  if (containerOf(next) !== null) openLogs(logs.hostId, next)
  else closeLogs()
}

function clearSelection(): void {
  set(selection, null)
  set(pendingDelete, null)
  closeLogs()
}

function changeFilter(text: string): void {
  set(filterText, text)
  const selected = read(selection)
  const snapshot = read(hostView)?.snapshot ?? null
  if (selected !== null && (snapshot === null || !shownKey(snapshot, text, selected))) clearSelection()
}

const SECTION_OF: Record<PendingDelete['kind'], Section> = {
  container: 'containers', project: 'containers', image: 'images', volume: 'volumes', network: 'networks',
}

function setSectionOpen(section: Section, open: boolean): void {
  update(sectionsOpen, (before) => ({ ...SECTIONS_OPEN, ...before, [section]: open }))
  if (open) return
  // Closing a section hides its card, so a delete question there is dropped, and so is the log view under Containers.
  const pending = read(pendingDelete)
  if (pending !== null && SECTION_OF[pending.kind] === section) set(pendingDelete, null)
  if (section === 'containers') closeLogs()
}

function toggleProject(key: string, expanded: boolean): void {
  update(collapsedProjects, (before) => expanded ? before.filter((k) => k !== key) : before.includes(key) ? before : [...before, key])
}

function toggleRepo(key: string, expanded: boolean): void {
  update(expandedRepos, (before) => !expanded ? before.filter((k) => k !== key) : before.includes(key) ? before : [...before, key])
}

// Tree keys are container ids, `image:`, `volume:` and `network:` rows, and the group rows `project:<name>` and
// `repo:<name>`. A container, one of those rows or a project is picked (a group row also toggles); only a container
// opens its logs.
function containerOf(key: string): ContainerRow | null {
  return read(hostView)?.snapshot?.containers.find((c) => c.id === key) ?? null
}

function projectOf(key: string): ProjectDetails | null {
  const rows = read(hostView)?.snapshot?.containers ?? null
  return rows === null ? null : projectDetails(rows, key)
}

function resourceOf(key: string): ResourceDetails | null {
  const snapshot = read(hostView)?.snapshot ?? null
  return snapshot === null ? null : resourceDetails(snapshot, key)
}

// A click on a project row toggles it, as before, and now also selects the project, which opens its card.
function pickItem(key: string): void {
  if (containerOf(key) !== null || resourceOf(key) !== null) changeSelection(key)
  else if (key.startsWith('project:')) {
    toggleProject(key, read(collapsedProjects).includes(key))
    if (projectOf(key) !== null) changeSelection(key)
  } else if (key.startsWith('repo:')) toggleRepo(key, !read(expandedRepos).includes(key))
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
  const copy = problemCopy(problem, uiLang())
  return (
    <EmptyState title={copy.title} icon="warning">
      <Text muted>{copy.description}</Text>
    </EmptyState>
  )
}

function problemCallout(problem: Problem, tone: Tone, key: string): OrcaNode {
  const copy = problemCopy(problem, uiLang())
  return (
    <Callout key={key} tone={tone} title={copy.title}>
      <Text>{copy.description}</Text>
    </Callout>
  )
}

// An action's problem on its card (or under the pull row). A startup-shell answer is a warning instead, naming the login
// files that may start tmux, screen or byobu, with Open anyway. No command runs while it shows: each one clears it first.
function actionCallout(owned: ActionProblem | null, key: string): OrcaNode {
  if (owned === null) return null
  const { problem, openAnyway } = owned
  if (problem.kind !== 'startup-shell') return problemCallout(problem, 'danger', key)
  const lang = uiLang()
  const m = messages[lang]
  return (
    <Callout key={key} tone="warning" title={problemCopy(problem, lang).title}>
      <Stack gap="sm">
        <Text>{m.startupShellWarning(problem.message)}</Text>
        {openAnyway === undefined ? null : (
          <Row gap="xs">
            <Button key="open-anyway" size="sm" onPress={() => void openAnyway()}>{m.openAnyway}</Button>
          </Row>
        )}
      </Stack>
    </Callout>
  )
}

// A question, problem or note for another item (or host) is not drawn here.
const ownedBy = (hostId: HostId, id: string) => <T extends Target>(value: T | null): T | null =>
  value !== null && value.hostId === hostId && value.id === id ? value : null

// The note of the item drawn, in the language shown.
const noteText = (note: { text: (m: Messages) => string } | null, m: Messages): string | null => note === null ? null : note.text(m)

function deleteQuestion(pending: PendingDelete, text: string, busy: boolean): OrcaNode {
  const m = messages[uiLang()]
  return (
    <Callout key="confirm" tone="danger" title={m.deleteTitle(pending.name)}>
      <Stack gap="sm">
        <Text>{text}</Text>
        <Row gap="xs">
          <Button key="confirm-delete" tone="danger" disabled={busy} onPress={confirmDelete}>{m.delete}</Button>
          <Button key="cancel-delete" variant="ghost" onPress={() => set(pendingDelete, null)}>{m.cancel}</Button>
        </Row>
      </Stack>
    </Callout>
  )
}

function detailsCard(view: HostView, container: ContainerRow): OrcaNode {
  const lang = uiLang()
  const m = messages[lang]
  const busy = read(working)
  const allowed = allowedActions(container.state)
  const can = (name: keyof Allowed) => !busy && allowed[name]
  const act = (action: ContainerAction) => () => void containerAction(view.hostId, action, container.id)
  const terminal = (kind: TerminalKind) => () => void openTerminal(view.hostId, kind, container.id, container.name)
  const showLogs = () => openLogs(view.hostId, container.id)
  const askDelete = () =>
    set(pendingDelete, { hostId: view.hostId, id: container.id, name: container.name, kind: 'container', ref: container.id })
  const own = ownedBy(view.hostId, container.id)
  const pending = own(read(pendingDelete))
  const problem = own(read(actionProblem))
  const opened = noteText(own(read(openedNote)), m)
  return (
    <Card key="details" title={container.name} description={container.state}>
      <Stack gap="sm">
        <KeyValue items={containerDetails(container, lang)} />
        <Row gap="sm" align="center" wrap>
          <Toolbar label={m.containerActions}>
            <Button key="start" size="sm" icon="play" disabled={!can('start')} onPress={act('start')}>{m.start}</Button>
            <Button key="stop" size="sm" icon="stop" disabled={!can('stop')} onPress={act('stop')}>{m.stop}</Button>
            <Button key="restart" size="sm" icon="refresh" disabled={!can('restart')} onPress={act('restart')}>{m.restart}</Button>
            <Button key="logs" size="sm" icon="file-text" disabled={!can('logs')} onPress={showLogs}>{m.logs}</Button>
            <Button key="shell" size="sm" icon="terminal" disabled={!can('shell')} onPress={terminal('shell')}>{m.shell}</Button>
            <Button key="delete" size="sm" icon="delete" tone="danger" variant="outline" disabled={!can('remove')} onPress={askDelete}>{m.delete}</Button>
          </Toolbar>
          {busy ? <Spinner label={m.working} /> : null}
        </Row>
        {opened === null ? null : <Text muted size="sm">{opened}</Text>}
        {pending === null ? null : deleteQuestion(pending, m.removeContainer, busy)}
        {actionCallout(problem, 'action-problem')}
      </Stack>
    </Card>
  )
}

// The card of the selected image tag, volume or network: what it is, Pull (an image with a repository and tag), Delete.
function resourceCard(view: HostView, details: ResourceDetails): OrcaNode {
  const m = messages[uiLang()]
  const busy = read(working)
  const { kind, key, title, removeRef, removeBlocked, pullRef } = details
  const askDelete = () => set(pendingDelete, { hostId: view.hostId, id: key, name: title, kind, ref: removeRef })
  const own = ownedBy(view.hostId, key)
  const pending = own(read(pendingDelete))
  const problem = own(read(actionProblem))
  const opened = noteText(own(read(openedNote)), m)
  return (
    <Card key="details" title={title}>
      <Stack gap="sm">
        <KeyValue items={details.items} />
        <Row gap="sm" align="center" wrap>
          <Toolbar label={m.resourceActions[kind]}>
            {pullRef === null ? null : (
              <Button key="pull" size="sm" icon="download" disabled={busy} onPress={() => void pullImage(view.hostId, key, pullRef)}>{m.pull}</Button>
            )}
            <Button key="delete" size="sm" icon="delete" tone="danger" variant="outline" disabled={busy || removeBlocked !== null}
              onPress={askDelete}>{m.delete}</Button>
          </Toolbar>
          {busy ? <Spinner label={m.working} /> : null}
        </Row>
        {removeBlocked === null ? null : <Text key="delete-blocked" muted size="sm">{removeBlocked}</Text>}
        {opened === null ? null : <Text muted size="sm">{opened}</Text>}
        {pending === null ? null : deleteQuestion(pending, details.removeText, busy)}
        {actionCallout(problem, 'action-problem')}
      </Stack>
    </Card>
  )
}

// Down stops and removes the project's containers and networks, so it asks first, as Delete does.
function downQuestion(project: string, busy: boolean): OrcaNode {
  const m = messages[uiLang()]
  return (
    <Callout key="confirm" tone="danger">
      <Stack gap="sm">
        <Text>{m.downQuestion(project)}</Text>
        <Row gap="xs">
          <Button key="confirm-down" tone="danger" disabled={busy} onPress={confirmDelete}>{m.down}</Button>
          <Button key="cancel-down" variant="ghost" onPress={() => set(pendingDelete, null)}>{m.cancel}</Button>
        </Row>
      </Stack>
    </Callout>
  )
}

// The card of the selected Compose project: Start, Stop and Restart act on the whole project in the panel, Up opens
// its terminal, and Down asks first.
function projectCard(view: HostView, project: ProjectDetails): OrcaNode {
  const m = messages[uiLang()]
  const busy = read(working)
  const { key, name } = project
  // Down never goes out on one press: only confirmDelete sends it.
  const act = (action: Exclude<ComposeAction, 'down'>) => () => void projectAction(view.hostId, key, action)
  const askDown = () => set(pendingDelete, { hostId: view.hostId, id: key, name, kind: 'project', ref: name })
  const own = ownedBy(view.hostId, key)
  const pending = own(read(pendingDelete))
  const problem = own(read(actionProblem))
  const opened = noteText(own(read(openedNote)), m)
  return (
    <Card key="details" title={name}>
      <Stack gap="sm">
        <KeyValue items={project.items} />
        <Row gap="sm" align="center" wrap>
          <Toolbar label={m.projectActions}>
            <Button key="project-start" size="sm" icon="play" disabled={busy || !project.canStart} onPress={act('start')}>{m.start}</Button>
            <Button key="project-stop" size="sm" icon="stop" disabled={busy || !project.canStop} onPress={act('stop')}>{m.stop}</Button>
            <Button key="project-restart" size="sm" icon="refresh" disabled={busy || !project.canStop} onPress={act('restart')}>{m.restart}</Button>
            <Button key="project-up" size="sm" icon="upload" disabled={busy} onPress={() => void composeUp(view.hostId, key)}>{m.up}</Button>
            <Button key="project-down" size="sm" icon="delete" tone="danger" variant="outline" disabled={busy} onPress={askDown}>{m.down}</Button>
          </Toolbar>
          {busy ? <Spinner label={m.working} /> : null}
        </Row>
        {opened === null ? null : <Text muted size="sm">{opened}</Text>}
        {pending === null ? null : downQuestion(name, busy)}
        {actionCallout(problem, 'action-problem')}
      </Stack>
    </Card>
  )
}

// Before any lines: the problem or a placeholder. After: the lines, under the problem of a later failed refresh.
function logBody(logs: LogView): OrcaNode {
  const m = messages[uiLang()]
  if (logs.text === null) {
    if (logs.problem !== null) return problemState(logs.problem)
    return <Skeleton key="logs-loading" label={m.loadingLogs} lines={3} />
  }
  return (
    <Stack gap="xs">
      {logs.problem === null ? null : problemCallout(logs.problem, 'warning', 'logs-problem')}
      {logs.text.trim() === ''
        ? <Text key="no-logs" muted size="sm">{m.noLogs}</Text>
        : <CodeView key="logs-code" label={m.logs} code={logs.text} wrap maxHeight="md" />}
    </Stack>
  )
}

// Under the card: the last lines of the container's logs, refreshed while the panel is visible.
// "Open in terminal" follows them live in an Orca terminal, as the Logs button did before.
function logSection(view: HostView, container: ContainerRow, logs: LogView): OrcaNode {
  const m = messages[uiLang()]
  const busy = read(working)
  return (
    <Stack key="logs" gap="xs">
      <Row key="logs-header" gap="xs" align="center" justify="between" wrap>
        {logs.takenAt === null ? <Text muted size="xs">{m.logs}</Text> : <Text muted size="xs">{m.logsUpdated}<RelativeTime at={logs.takenAt} /></Text>}
        <Row gap="xs" align="center">
          <IconButton key="refresh-logs" icon="refresh" label={m.refreshLogs} size="sm" variant="ghost" disabled={logs.loading}
            onPress={() => void refreshLogs()} />
          <Button key="logs-terminal" size="sm" variant="ghost" icon="terminal" disabled={busy}
            onPress={() => void openTerminal(view.hostId, 'logs', container.id, container.name)}>{m.openInTerminal}</Button>
          <IconButton key="close-logs" icon="close" label={m.closeLogs} size="sm" variant="ghost" onPress={closeLogs} />
        </Row>
      </Row>
      {logBody(logs)}
    </Stack>
  )
}

// A muted line in place of an empty tree: the host has none, or the filter left none.
function emptyLine(id: Section, total: number): OrcaNode {
  const copy = messages[uiLang()].sections[id]
  return <Text key="empty" muted size="sm">{total === 0 ? copy.none : copy.noMatch}</Text>
}

function containersBody(view: HostView, snapshot: Snapshot, filter: string): OrcaNode {
  const lang = uiLang()
  const rows = snapshot.containers
  const items = containerTree(rows, filter, lang)
  const selected = read(selection)
  const container = rows.find((c) => c.id === selected) ?? null
  const project = selected === null || container !== null ? null : projectDetails(rows, selected, lang)
  const logs = read(logView)
  const ownLogs = logs !== null && container !== null && logs.hostId === view.hostId && logs.id === container.id ? logs : null
  const collapsed = read(collapsedProjects)
  return (
    <Stack gap="sm">
      {items.length === 0 ? emptyLine('containers', rows.length) : (
        <Tree
          key="containers-tree"
          label={messages[lang].sections.containers.title}
          items={items}
          maxHeight="lg"
          // '' keeps the Tree controlled when no container is selected; undefined would let it keep its own pick.
          // A selected project is not handed over either: Orca's Tree sends onSelect only for a row other than the
          // one it shows selected, so a project row shown selected would stop toggling on a click.
          selected={container?.id ?? ''}
          expanded={items.filter((item) => item.children !== undefined && !collapsed.includes(item.key)).map((item) => item.key)}
          onSelect={({ key }) => pickItem(key)}
          onToggle={({ key, expanded }) => toggleProject(key, expanded)}
          onAction={({ key }) => activateItem(view.hostId, key)}
        />
      )}
      {container === null ? null : detailsCard(view, container)}
      {project === null ? null : projectCard(view, project)}
      {container === null || ownLogs === null ? null : logSection(view, container, ownLogs)}
    </Stack>
  )
}

// "Image to pull" and its Pull button, at the top of the Images section, with what came of the last pull.
function pullRow(view: HostView): OrcaNode {
  const m = messages[uiLang()]
  const text = read(pullText)
  const invalid = read(pullInvalid)
  const own = ownedBy(view.hostId, PULL_ROW)
  const problem = own(read(actionProblem))
  const opened = noteText(own(read(openedNote)), m)
  return (
    <Stack key="pull-row" gap="xs">
      <Row gap="xs" align="end">
        {/* The placeholder is an example image name, the same in every language. */}
        <Input key="pull-ref" label={m.imageToPull} labelHidden placeholder="nginx:latest" value={text} invalid={invalid}
          onChange={changePullText} />
        <Button key="pull-by-name" size="sm" icon="download" disabled={read(working) || text.trim() === ''}
          onPress={() => pullByName(view.hostId)}>{m.pull}</Button>
      </Row>
      {invalid ? <Text key="pull-error" tone="danger" size="sm">{m.notAnImage}</Text> : null}
      {opened === null ? null : <Text key="pull-opened" muted size="sm">{opened}</Text>}
      {actionCallout(problem, 'pull-problem')}
    </Stack>
  )
}

// A section's tree and, under it, the card of its selected row. Images also get the pull row, and their repository
// rows toggle like Compose projects.
function resourceBody(view: HostView, snapshot: Snapshot, kind: ResourceKind, items: TreeItem[], total: number): OrcaNode {
  const lang = uiLang()
  const id = SECTION_OF[kind]
  const selected = read(selection)
  const details = selected !== null && resourceKindOf(selected) === kind ? resourceDetails(snapshot, selected, lang) : null
  const repos = read(expandedRepos)
  const groups = kind !== 'image' ? {} : {
    expanded: items.filter((item) => repos.includes(item.key)).map((item) => item.key),
    onToggle: ({ key, expanded }: { key: string; expanded: boolean }) => toggleRepo(key, expanded),
  }
  return (
    <Stack gap="sm">
      {kind === 'image' ? pullRow(view) : null}
      {items.length === 0 ? emptyLine(id, total) : (
        <Tree key={`${id}-tree`} label={messages[lang].sections[id].title} items={items} maxHeight="lg" selected={details?.key ?? ''}
          onSelect={({ key }) => pickItem(key)} {...groups} />
      )}
      {details === null ? null : resourceCard(view, details)}
    </Stack>
  )
}

// A closed section draws nothing inside, so hundreds of images cost nothing until it opens.
function section(id: Section, description: string, body: () => OrcaNode): OrcaNode {
  const open = { ...SECTIONS_OPEN, ...read(sectionsOpen) }[id] === true
  const title = messages[uiLang()].sections[id].title
  return (
    <Collapsible key={id} title={title} description={description} open={open} onChange={(next) => setSectionOpen(id, next)}>
      {open ? body() : null}
    </Collapsible>
  )
}

function hostBody(): OrcaNode {
  const lang = uiLang()
  const m = messages[lang]
  const hosts = read(hostList)
  if (hosts === null) {
    const problem = read(hostsProblem)
    return problem === null ? <Skeleton label={m.loadingHosts} lines={3} /> : null
  }
  const view = read(hostView)
  if (view === null) {
    return (
      <EmptyState title={m.noHostTitle} icon="info">
        <Text muted>{m.noHostDescription}</Text>
      </EmptyState>
    )
  }
  const snapshot = view.snapshot
  if (snapshot === null) {
    if (view.problem !== null) return problemState(view.problem)
    return <Skeleton label={m.loadingContainers} lines={4} />
  }
  const filter = read(filterText)
  const { containers, images, volumes, networks } = snapshot
  return (
    <Stack gap="sm">
      {view.problem === null ? null : problemCallout(view.problem, 'warning', 'snapshot-problem')}
      {section('containers', m.runningOfTotal(runningCount(containers), containers.length),
        () => containersBody(view, snapshot, filter))}
      {section('images', `${images.length}`,
        () => resourceBody(view, snapshot, 'image', imageTree(images, filter, lang), images.length))}
      {section('volumes', `${volumes.length}`,
        () => resourceBody(view, snapshot, 'volume', volumeTree(volumes, filter), volumes.length))}
      {section('networks', `${networks.length}`,
        () => resourceBody(view, snapshot, 'network', networkTree(networks, filter), networks.length))}
    </Stack>
  )
}

export default function Panel() {
  const lang = uiLang()
  const m = messages[lang]
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
          label={m.host}
          options={hostOptions(hosts ?? [], lang)}
          value={hostId ?? undefined}
          placeholder={m.chooseHost}
          onChange={(value) => {
            const picked = hosts?.find((h) => h.id === value)
            if (picked !== undefined && picked.id !== read(selectedHost)) selectHost(picked.id)
          }}
        />
        <IconButton icon="refresh" label={m.refresh} disabled={refreshing} onPress={() => void refreshAll()} />
      </Row>
      <Row gap="sm" align="center" justify="between" wrap>
        <Switch label={m.followFocus} checked={read(followFocus)} onChange={setFollow} />
        {takenAt === undefined ? null : <Text muted size="xs">{m.updated}<RelativeTime at={takenAt} /></Text>}
      </Row>
      <Input
        label={m.filter}
        labelHidden
        type="search"
        placeholder={m.filterPlaceholder}
        value={read(filterText)}
        onChange={changeFilter}
      />
      {hostsFailure === null ? null : problemCallout(hostsFailure, 'warning', 'hosts-problem')}
      {hostBody()}
    </Stack>
  )
}
