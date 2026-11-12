import type { CommandResult } from '../docker/parse'
import { MARK } from './script'

type Kind = 'READY' | 'BEGIN' | 'SEC' | 'RC' | 'END'
type Marker = { kind: Kind; id: string; before: string; rest: string }

const MARKER_RE = new RegExp(`${MARK}(READY|BEGIN|SEC|RC|END)_([A-Za-z0-9]+)__`)

const clean = (line: string): string => line.replace(/\r$/, '')

// Text before the marker is output of an earlier command that had no trailing newline.
function parseMarker(raw: string): Marker | null {
  const line = clean(raw)
  const m = MARKER_RE.exec(line)
  if (!m) return null
  return { kind: m[1] as Kind, id: m[2] ?? '', before: line.slice(0, m.index), rest: line.slice(m.index + m[0].length).trim() }
}

// The kernel `uname -s` printed on this run's READY line.
export function readyInfo(lines: readonly string[], nonce: string): { kernel: string } | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    const marker = parseMarker(lines[i] ?? '')
    if (marker?.kind !== 'READY' || marker.id !== nonce) continue
    const [kernel] = marker.rest.split(/\s+/)
    if (kernel) return { kernel }
  }
  return null
}

export function extractRun(
  lines: readonly string[],
  nonce: string,
): { complete: boolean; truncated: boolean; results: CommandResult[] } {
  const marks = lines.map(parseMarker)
  const own = (i: number, kind: Kind): boolean => marks[i]?.kind === kind && marks[i]?.id === nonce
  let end = -1
  for (let i = lines.length - 1; i >= 0; i--) {
    if (own(i, 'END')) {
      end = i
      break
    }
  }
  if (end < 0) return { complete: false, truncated: false, results: [] }
  let begin = -1
  for (let i = end - 1; i >= 0; i--) {
    if (own(i, 'BEGIN')) {
      begin = i
      break
    }
  }
  const results: CommandResult[] = []
  let buffer: string[] = []
  const flush = (before: string | undefined): void => {
    if (before) buffer.push(before)
  }
  for (let i = begin + 1; i < end; i++) {
    const marker = marks[i]
    if (marker && marker.id === nonce && (marker.kind === 'SEC' || marker.kind === 'RC')) {
      flush(marker.before)
      if (marker.kind === 'RC') {
        const [name = '', code] = marker.rest.split(/\s+/)
        results.push({ name, code: Number(code), lines: buffer })
      }
      buffer = []
    } else if (marker) {
      flush(marker.before) // a marker of another run: keep only the output glued before it
    } else {
      buffer.push(clean(lines[i] ?? ''))
    }
  }
  return { complete: true, truncated: begin < 0, results }
}
