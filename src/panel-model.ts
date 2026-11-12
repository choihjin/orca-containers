import type { IconName, KeyValueItem, TreeItem } from 'orca'
import { messages, type Lang } from './i18n'
import type {
  ContainerRow, ContainerState, HostId, HostInfo, ImageRow, NetworkRow, Problem, ResourceKind, Snapshot, VolumeRow,
} from './protocol'

export type Allowed = { start: boolean; stop: boolean; restart: boolean; logs: boolean; shell: boolean; remove: boolean }

export function allowedActions(state: ContainerState): Allowed {
  const none = { start: false, stop: false, restart: false, logs: true, shell: false, remove: false }
  switch (state) {
    case 'running': return { ...none, stop: true, restart: true, shell: true }
    case 'exited': return { ...none, start: true, restart: true, remove: true }
    case 'created': return { ...none, start: true, remove: true }
    case 'paused':
    case 'restarting': return { ...none, stop: true }
    case 'dead': return { ...none, remove: true }
    default: return none
  }
}

// Only an unsupported host is marked, and it cannot be picked.
export function hostOptions(hosts: readonly HostInfo[], lang: Lang = 'en'): { value: string; label: string; disabled?: boolean }[] {
  const m = messages[lang]
  return hosts.map((h) => {
    const ready = h.status === 'ready'
    const base = h.kind === 'local' && Object.hasOwn(m.localNames, h.label) ? m.localNames[h.label as keyof typeof m.localNames] : h.label
    const parts = h.kind === 'local' ? [] : [m.ssh]
    if (!ready) parts.push(m.unsupported)
    const label = parts.length > 0 ? `${base} (${parts.join(', ')})` : base
    return ready ? { value: h.id, label } : { value: h.id, label, disabled: true }
  })
}

export function nextHost(current: HostId | null, matched: HostId | null, follow: boolean, hosts: readonly HostInfo[]): HostId | null {
  if (follow && matched !== null && hosts.some((h) => h.id === matched && h.status === 'ready')) return matched
  if (current !== null && hosts.some((h) => h.id === current)) return current
  return hosts.find((h) => h.status === 'ready')?.id ?? null
}

export function refreshMs(hostId: HostId, settings: Record<string, unknown>): number {
  const local = hostId === 'local'
  const [key, min, max, fallback] = local ? ['refreshLocalSeconds', 3, 600, 10] as const : ['refreshRemoteSeconds', 15, 3600, 60] as const
  const v = settings[key]
  const seconds = typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max ? v : fallback
  return seconds * 1000
}

export const LOG_REFRESH_LOCAL_MS = 3_000
export const LOG_REFRESH_REMOTE_MS = 10_000
// Orca refuses a text over 16 KiB; the log view keeps under that with room to spare.
export const LOG_TEXT_MAX = 15_000
export const LOG_LINE_MAX = 500

export function logRefreshMs(hostId: HostId): number {
  return hostId === 'local' ? LOG_REFRESH_LOCAL_MS : LOG_REFRESH_REMOTE_MS
}

// CSI (ESC [ … final byte), OSC (ESC ] … ended by BEL or ESC \, or by the line's end), the other ESC
// sequences (ESC ( B, ESC =), and the one-byte C1 CSI.
const ESCAPES = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b[ -/]*[0-~]|\x9b[0-?]*[ -/]*[@-~]/g
// C0 and C1 control characters, DEL included; only the tab stays.
const CONTROLS = /[\x00-\x08\x0a-\x1f\x7f-\x9f]/g

function logLine(raw: string): string {
  const line = raw.replace(ESCAPES, '').replace(CONTROLS, '')
  if (line.length <= LOG_LINE_MAX) return line
  // A cut between the two halves of an emoji would leave half a character.
  const high = line.charCodeAt(LOG_LINE_MAX - 1)
  const end = high >= 0xd800 && high <= 0xdbff ? LOG_LINE_MAX - 1 : LOG_LINE_MAX
  return `${line.slice(0, end)}…`
}

// The newest lines that fit in LOG_TEXT_MAX characters, oldest first, without colour codes or control characters.
export function logText(lines: readonly string[]): string {
  const kept: string[] = []
  let length = -1 // the first line kept has no '\n' before it
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = logLine(lines[i] ?? '')
    if (length + 1 + line.length > LOG_TEXT_MAX) break
    length += 1 + line.length
    kept.push(line)
  }
  return kept.reverse().join('\n')
}

export function dueForRefresh(now: number, lastAt: number | null, visible: boolean, intervalMs: number, inFlight: boolean): boolean {
  if (!visible || inFlight) return false
  return lastAt === null || now - lastAt >= intervalMs
}

// The message of an invalid, failed or ssh-failed problem is what the daemon, ssh or the worker said, in English;
// a startup-shell problem's message is the list of the host's login files that may start tmux, screen or byobu.
export function problemCopy(problem: Problem, lang: Lang = 'en'): { title: string; description: string } {
  const copy = messages[lang].problems
  const { kind } = problem
  if (kind === 'invalid' || kind === 'failed' || kind === 'ssh-failed' || kind === 'startup-shell') {
    return { title: copy[kind].title, description: problem.message }
  }
  return { ...copy[kind] }
}

export function rejectionProblem(error: unknown): Problem {
  const e = (typeof error === 'object' && error !== null ? error : {}) as { code?: unknown; message?: unknown }
  const code = typeof e.code === 'string' && e.code !== '' ? e.code : 'error'
  const message = typeof e.message === 'string' ? e.message : String(error)
  return { kind: 'failed', message: `${code}: ${message}` }
}

const STATE_ICONS: Record<ContainerState, IconName> = {
  running: 'play', paused: 'pause', restarting: 'refresh', exited: 'stop', created: 'add', dead: 'error', removing: 'delete', unknown: 'info',
}

export function stateIcon(state: ContainerState): IconName {
  return STATE_ICONS[state] ?? 'info'
}

// Spaces around what the person typed do not count.
export function matchesFilter(filter: string, ...fields: string[]): boolean {
  const needle = filter.trim().toLowerCase()
  return needle === '' || fields.some((f) => f.toLowerCase().includes(needle))
}

// Case does not decide the order ('alpha', 'Beta', 'zeta'), only breaks a tie; English rules, so the
// order does not depend on the machine's locale.
const byName = (a: string, b: string): number => a.localeCompare(b, 'en', { sensitivity: 'base' }) || a.localeCompare(b, 'en')

// Orca refuses a whole render over a repeated tree key, and `docker images` lists one image once
// per tag, so a repeat gets a `~n` suffix. Keys are given before filtering, so they do not change with it.
function withUniqueKeys<T>(rows: readonly T[], keyOf: (row: T) => string): { row: T; key: string }[] {
  const seen = new Map<string, number>()
  return rows.map((row) => {
    const base = keyOf(row)
    const n = (seen.get(base) ?? 0) + 1
    seen.set(base, n)
    return { row, key: n === 1 ? base : `${base}~${n}` }
  })
}

function containerItem(r: ContainerRow): TreeItem {
  return { key: r.id, label: r.name, description: `${r.image} · ${r.status}`, icon: stateIcon(r.state) }
}

// Inside a Compose group the project already names the stack, so the row gets the room: the service and the status.
// Replicas of one service would read the same, so they get their number (`web 2`), or the full name without one.
function labelCounts(rows: readonly ContainerRow[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const r of rows) {
    const base = r.service === '' ? r.name : r.service
    counts.set(base, (counts.get(base) ?? 0) + 1)
  }
  return counts
}

function groupedItem(r: ContainerRow, taken: ReadonlyMap<string, number>): TreeItem {
  const base = r.service === '' ? r.name : r.service
  let label = base
  if ((taken.get(base) ?? 0) > 1) {
    const replica = /[-_](\d+)$/.exec(r.name)?.[1]
    label = replica === undefined ? r.name : `${base} ${replica}`
  }
  return { key: r.id, label, description: r.status, icon: stateIcon(r.state) }
}

export function containerTree(rows: readonly ContainerRow[], filter: string, lang: Lang = 'en'): TreeItem[] {
  const groups = new Map<string, ContainerRow[]>()
  const singles: ContainerRow[] = []
  for (const r of rows) {
    if (r.project === '') { singles.push(r); continue }
    const g = groups.get(r.project)
    if (g) g.push(r); else groups.set(r.project, [r])
  }
  const out: TreeItem[] = []
  for (const name of [...groups.keys()].sort(byName)) {
    const members = groups.get(name) ?? []
    const shown = matchesFilter(filter, name) ? members : members.filter((r) => matchesFilter(filter, r.name, r.image, r.service))
    if (shown.length === 0) continue
    const counts = labelCounts(members) // whole group, so a label does not change with the filter
    const running = members.filter((r) => r.state === 'running').length
    out.push({
      key: `project:${name}`, label: name, description: messages[lang].composeRunning(running, members.length), icon: 'layers',
      children: [...shown].sort((a, b) => byName(a.name, b.name)).map((r) => groupedItem(r, counts)),
    })
  }
  for (const r of [...singles].sort((a, b) => byName(a.name, b.name))) {
    if (matchesFilter(filter, r.name, r.image)) out.push(containerItem(r))
  }
  return out
}

const imageKey = (row: ImageRow) => `image:${row.id}:${row.tag}`
const volumeKey = (row: VolumeRow) => `volume:${row.name}`
const networkKey = (row: NetworkRow) => `network:${row.id}`

export function imageTree(rows: readonly ImageRow[], filter: string, lang: Lang = 'en'): TreeItem[] {
  const keyed = withUniqueKeys(rows, imageKey)
  const groups = new Map<string, typeof keyed>()
  for (const k of keyed) {
    const g = groups.get(k.row.repository)
    if (g) g.push(k); else groups.set(k.row.repository, [k])
  }
  const names = [...groups.keys()].sort((a, b) => (a === '<none>' ? 1 : 0) - (b === '<none>' ? 1 : 0) || byName(a, b))
  const out: TreeItem[] = []
  for (const name of names) {
    const members = groups.get(name) ?? []
    const shown = matchesFilter(filter, name) ? members : members.filter((m) => matchesFilter(filter, m.row.tag, m.row.id))
    if (shown.length === 0) continue
    out.push({
      key: `repo:${name}`, label: name, description: messages[lang].tags(members.length), icon: 'layers',
      children: shown.map((m) => ({ key: m.key, label: m.row.tag, description: `${m.row.size} · ${m.row.createdSince}`, icon: 'package' as const })),
    })
  }
  return out
}

export function volumeTree(rows: readonly VolumeRow[], filter: string): TreeItem[] {
  return withUniqueKeys(rows, volumeKey).filter(({ row: r }) => matchesFilter(filter, r.name, r.driver))
    .map(({ row: r, key }) => ({ key, label: r.name, description: r.driver, icon: 'database' as const }))
}

export function networkTree(rows: readonly NetworkRow[], filter: string): TreeItem[] {
  return withUniqueKeys(rows, networkKey).filter(({ row: r }) => matchesFilter(filter, r.name, r.driver, r.scope))
    .map(({ row: r, key }) => ({ key, label: r.name, description: `${r.driver} · ${r.scope}`, icon: 'globe' as const }))
}

// The kind of item a tree key names: image tag, volume and network rows. Container ids and group rows name none.
export function resourceKindOf(key: string): ResourceKind | null {
  if (key.startsWith('image:')) return 'image'
  if (key.startsWith('volume:')) return 'volume'
  if (key.startsWith('network:')) return 'network'
  return null
}

type Lists = Pick<Snapshot, 'containers' | 'images' | 'volumes' | 'networks'>

// Whether the trees draw the item with this key for this filter.
export function shownKey(lists: Lists, filter: string, key: string): boolean {
  const kind = resourceKindOf(key)
  const items = kind === 'image' ? imageTree(lists.images, filter)
    : kind === 'volume' ? volumeTree(lists.volumes, filter)
    : kind === 'network' ? networkTree(lists.networks, filter)
    : containerTree(lists.containers, filter)
  return items.some((item) => item.key === key || item.children?.some((child) => child.key === key) === true)
}

// The card of a selected image tag, volume or network.
export type ResourceDetails = {
  kind: ResourceKind
  key: string
  title: string
  items: KeyValueItem[]
  // Delete sends this as `ref`.
  removeRef: string
  // Why Delete is disabled (a built-in network); null when it is not.
  removeBlocked: string | null
  // What the delete question says will happen.
  removeText: string
  // Pull sends this; null for an image without a repository or tag.
  pullRef: string | null
}

const NONE = '<none>'
// Docker creates these itself and refuses to remove them.
const BUILT_IN_NETWORKS: readonly string[] = ['bridge', 'host', 'none']
const shortId = (id: string) => id.replace(/^sha256:/, '').slice(0, 12)

function rowAt<T>(rows: readonly T[], keyOf: (row: T) => string, key: string): T | null {
  return withUniqueKeys(rows, keyOf).find((k) => k.key === key)?.row ?? null
}

function imageDetails(row: ImageRow, key: string, lang: Lang): ResourceDetails {
  const m = messages[lang]
  const tagged = row.repository !== NONE && row.tag !== NONE
  const ref = `${row.repository}:${row.tag}`
  return {
    kind: 'image', key, title: row.repository === NONE ? shortId(row.id) : ref,
    items: [
      { label: m.fields.id, value: shortId(row.id), code: true }, { label: m.fields.size, value: row.size }, { label: m.fields.created, value: row.createdSince },
    ],
    removeRef: tagged ? ref : row.id, removeBlocked: null, pullRef: tagged ? ref : null,
    removeText: tagged ? m.removeTag : m.removeImage,
  }
}

export function resourceDetails(lists: Omit<Lists, 'containers'>, key: string, lang: Lang = 'en'): ResourceDetails | null {
  const m = messages[lang]
  const kind = resourceKindOf(key)
  if (kind === 'image') {
    const row = rowAt(lists.images, imageKey, key)
    return row === null ? null : imageDetails(row, key, lang)
  }
  if (kind === 'volume') {
    const row = rowAt(lists.volumes, volumeKey, key)
    if (row === null) return null
    return {
      kind, key, title: row.name, items: [{ label: m.fields.driver, value: row.driver }],
      removeRef: row.name, removeBlocked: null, removeText: m.removeVolume, pullRef: null,
    }
  }
  if (kind === 'network') {
    const row = rowAt(lists.networks, networkKey, key)
    if (row === null) return null
    return {
      kind, key, title: row.name,
      items: [
        { label: m.fields.driver, value: row.driver }, { label: m.fields.scope, value: row.scope }, { label: m.fields.id, value: shortId(row.id), code: true },
      ],
      removeRef: row.id, removeBlocked: BUILT_IN_NETWORKS.includes(row.name) ? m.builtInNetwork : null,
      removeText: m.removeNetwork, pullRef: null,
    }
  }
  return null
}

// The card of a selected Compose project, from all of its containers in the rows, whatever the filter shows.
export type ProjectDetails = {
  key: string
  name: string
  items: KeyValueItem[]
  // What its actions send as `memberId`: the project's first container in the rows. Its labels tell the worker
  // where the project's files are.
  memberId: string
  // Start: some container is not running. Stop and Restart: some container runs. Up and Down always apply.
  canStart: boolean
  canStop: boolean
}

const PROJECT_KEY = 'project:'

export function projectDetails(rows: readonly ContainerRow[], key: string, lang: Lang = 'en'): ProjectDetails | null {
  if (!key.startsWith(PROJECT_KEY)) return null
  const name = key.slice(PROJECT_KEY.length)
  // '' is the project of every container outside Compose.
  const members = name === '' ? [] : rows.filter((r) => r.project === name)
  const first = members[0]
  if (first === undefined) return null
  const { fields } = messages[lang]
  const running = runningCount(members)
  // As the tree labels them: a container without a service label stands for a service of its own.
  const services = new Set(members.map((r) => r.service === '' ? r.name : r.service)).size
  return {
    key, name, memberId: first.id,
    items: [{ label: fields.services, value: String(services) }, { label: fields.running, value: `${running} / ${members.length}` }],
    canStart: running < members.length, canStop: running > 0,
  }
}

function statusItem(row: ContainerRow, label: string): KeyValueItem {
  const item: KeyValueItem = { label, value: row.status }
  if (row.state === 'running') item.tone = 'success'
  else if (row.state === 'paused' || row.state === 'restarting') item.tone = 'warning'
  else if (row.state === 'dead') item.tone = 'danger'
  else if (row.state === 'exited') {
    const code = /Exited \((\d+)\)/.exec(row.status)
    if (code !== null && Number(code[1]) !== 0) item.tone = 'danger'
  }
  return item
}

export function containerDetails(row: ContainerRow, lang: Lang = 'en'): KeyValueItem[] {
  const { fields } = messages[lang]
  const items: KeyValueItem[] = [{ label: fields.image, value: row.image }, statusItem(row, fields.status)]
  if (row.ports !== '') items.push({ label: fields.ports, value: row.ports, code: true })
  if (row.project !== '') items.push({ label: fields.compose, value: `${row.project} / ${row.service}` })
  items.push({ label: fields.id, value: row.id.slice(0, 12), code: true })
  return items
}

export function runningCount(rows: readonly ContainerRow[]): number {
  return rows.filter((r) => r.state === 'running').length
}

export function defaultExpanded(rows: readonly ContainerRow[]): string[] {
  return [...new Set(rows.filter((r) => r.project !== '').map((r) => `project:${r.project}`))]
}
