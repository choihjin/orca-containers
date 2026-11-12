import type { ContainerRow, ContainerState, HostId, ImageRow, NetworkRow, Problem, Result, Snapshot, VolumeRow } from '../protocol'

export type CommandResult = { name: string; code: number; lines: string[] } // 원격: stdout+stderr 합침, 로컬: stdout 뒤 stderr

const LABEL_MAX = 200
const STATES: readonly ContainerState[] = ['created', 'running', 'paused', 'restarting', 'removing', 'exited', 'dead']

export function cleanLabel(text: string, max: number): string {
  const clean = text.replace(/[\u0000-\u001f\u007f]/g, '')
  return clean.length > max ? `${clean.slice(0, max)}…` : clean
}

type Json = Record<string, unknown>

function parseJsonLine(line: string): Json | null {
  const trimmed = line.trim()
  if (!trimmed.startsWith('{')) return null
  try {
    const value: unknown = JSON.parse(trimmed)
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Json) : null
  } catch {
    return null
  }
}

function parseRows(lines: readonly string[]): Json[] {
  return lines.map(parseJsonLine).filter((row): row is Json => row !== null)
}

function str(row: Json, key: string): string {
  const value = row[key]
  return typeof value === 'string' ? cleanLabel(value, LABEL_MAX) : ''
}

// Reads one Compose label from docker's comma-joined "k=v,k=v" Labels string. The raw string is used
// (not str()) so a long label list is not truncated before the Compose keys.
function composeLabel(row: Json, key: 'project' | 'service'): string {
  const labels = row.Labels
  if (typeof labels !== 'string') return ''
  const match = new RegExp(`(?:^|,)com\\.docker\\.compose\\.${key}=([^,]*)`).exec(labels)
  return match?.[1] === undefined ? '' : cleanLabel(match[1], LABEL_MAX)
}

export function classifyFailure(result: CommandResult): Problem {
  const text = result.lines.join('\n').toLowerCase()
  if (result.code === 124) return { kind: 'timeout', message: 'The command timed out' }
  if (result.code === 127 || text.includes('command not found')) return { kind: 'docker-missing', message: 'Docker was not found' }
  if (text.includes('permission denied')) return { kind: 'permission-denied', message: 'Permission denied for the Docker socket' }
  if (text.includes('cannot connect to the docker daemon') || text.includes('is the docker daemon running')) {
    return { kind: 'daemon-down', message: 'The Docker daemon is not running' }
  }
  const first = result.lines.find((line) => line.trim() !== '' && parseJsonLine(line) === null)
  return { kind: 'failed', message: first === undefined ? `${result.name} failed with exit code ${result.code}` : cleanLabel(first.trim(), LABEL_MAX) }
}

function toState(value: string): ContainerState {
  return (STATES as readonly string[]).includes(value) ? (value as ContainerState) : 'unknown'
}

export function buildSnapshot(hostId: HostId, takenAt: number, results: readonly CommandResult[]): Result<Snapshot> {
  const find = (name: string): CommandResult =>
    results.find((r) => r.name === name) ?? { name, code: 1, lines: [`${name} produced no result`] }
  const fail = (problem: Problem): Result<Snapshot> => ({ ok: false, problem })

  const version = find('version')
  if (version.code !== 0) return fail(classifyFailure(version))
  const server = parseRows(version.lines).map((row) => row.Server).find((s) => typeof s === 'object' && s !== null) as Json | undefined
  if (server === undefined) return fail({ kind: 'daemon-down', message: 'The Docker daemon is not running' })

  const loaded: Json[][] = []
  for (const name of ['ps', 'images', 'volumes', 'networks']) {
    const result = find(name)
    if (result.code !== 0) return fail(classifyFailure(result))
    loaded.push(parseRows(result.lines))
  }
  const [ps = [], imageRows = [], volumeRows = [], networkRows = []] = loaded

  const containers: ContainerRow[] = ps.map((r) => ({
    id: str(r, 'ID'), name: str(r, 'Names'), image: str(r, 'Image'), state: toState(str(r, 'State')), status: str(r, 'Status'), ports: str(r, 'Ports'),
    project: composeLabel(r, 'project'), service: composeLabel(r, 'service'),
  }))
  const images: ImageRow[] = imageRows.map((r) => ({
    id: str(r, 'ID'), repository: str(r, 'Repository'), tag: str(r, 'Tag'), size: str(r, 'Size'), createdSince: str(r, 'CreatedSince'),
  }))
  const volumes: VolumeRow[] = volumeRows.map((r) => ({ name: str(r, 'Name'), driver: str(r, 'Driver') }))
  const networks: NetworkRow[] = networkRows.map((r) => ({ id: str(r, 'ID'), name: str(r, 'Name'), driver: str(r, 'Driver'), scope: str(r, 'Scope') }))
  return { ok: true, value: { hostId, takenAt, serverVersion: str(server, 'Version'), containers, images, volumes, networks } }
}
