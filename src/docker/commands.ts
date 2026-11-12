import type { ContainerAction, ResourceKind, TerminalKind } from '../protocol'

export type DockerCommand = { name: 'version' | 'ps' | 'images' | 'volumes' | 'networks' | 'action' | 'logs' | 'remove'; argv: string[] } // 'docker' 제외

export const SNAPSHOT_COMMANDS: readonly DockerCommand[] = [
  { name: 'version', argv: ['version', '--format', '{{json .}}'] },
  { name: 'ps', argv: ['ps', '-a', '--no-trunc', '--format', '{{json .}}'] },
  { name: 'images', argv: ['images', '--no-trunc', '--format', '{{json .}}'] },
  { name: 'volumes', argv: ['volume', 'ls', '--format', '{{json .}}'] },
  { name: 'networks', argv: ['network', 'ls', '--no-trunc', '--format', '{{json .}}'] },
]

const CONTAINER_ID = /^[0-9a-f]{12,64}$/

export function isContainerId(value: string): boolean {
  return CONTAINER_ID.test(value)
}

export class InvalidInputError extends Error {}

const ACTION_VERB: Record<ContainerAction, string> = { start: 'start', stop: 'stop', restart: 'restart', remove: 'rm' }

function requireId(id: string): void {
  if (!isContainerId(id)) throw new InvalidInputError('Invalid container id')
}

export function actionCommand(action: ContainerAction, id: string): DockerCommand {
  requireId(id)
  if (!Object.hasOwn(ACTION_VERB, action)) throw new InvalidInputError('Invalid container action')
  return { name: 'action', argv: [ACTION_VERB[action], id] }
}

export function logsCommand(id: string): DockerCommand {
  requireId(id)
  return { name: 'logs', argv: ['logs', '--tail', '200', id] }
}

export function terminalArgv(kind: TerminalKind, id: string): string[] {
  requireId(id)
  if (kind === 'logs') return ['docker', 'logs', '-f', '--tail', '200', id]
  if (kind === 'shell') return ['docker', 'exec', '-it', id, 'sh', '-c', 'command -v bash >/dev/null 2>&1 && exec bash || exec sh']
  throw new InvalidInputError('Invalid terminal kind')
}

// Every value below starts with a letter or digit (or `sha256:`), so none can be read as an option, and none holds a
// space, so none can become a second argument.
const IMAGE_ID = /^(sha256:)?[0-9a-f]{12,64}$/
const IMAGE_REF = /^[A-Za-z0-9][A-Za-z0-9._/:@-]*$/
const IMAGE_DIGEST = /^sha256:[0-9a-f]{64}$/
const VOLUME_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,254}$/
const NETWORK_ID = /^[0-9a-f]{12,64}$/

// A name, tag or digest reference (`repo:tag`, `ghcr.io/org/app:1.2`, `localhost:5000/x`, `name@sha256:<64 hex>`):
// 1 to 255 characters, no `..`, and at most one `@`, only for a sha256 digest at the end.
export function isImageRef(value: string): boolean {
  if (value.length > 255 || !IMAGE_REF.test(value) || value.includes('..')) return false
  const [, digest, extra] = value.split('@')
  return digest === undefined || (extra === undefined && IMAGE_DIGEST.test(digest))
}

const REMOVABLE: Record<ResourceKind, { valid: (ref: string) => boolean; what: string }> = {
  image: { valid: (ref) => IMAGE_ID.test(ref) || isImageRef(ref), what: 'image id or reference' },
  volume: { valid: (ref) => VOLUME_NAME.test(ref), what: 'volume name' },
  network: { valid: (ref) => NETWORK_ID.test(ref), what: 'network id' },
}

// `docker image|volume|network rm <ref>`, never forced: the daemon refuses an item in use.
export function removeCommand(kind: ResourceKind, ref: string): DockerCommand {
  if (!Object.hasOwn(REMOVABLE, kind)) throw new InvalidInputError('Invalid resource kind')
  if (!REMOVABLE[kind].valid(ref)) throw new InvalidInputError(`Invalid ${REMOVABLE[kind].what}`)
  return { name: 'remove', argv: [kind, 'rm', ref] }
}

export function pullArgv(ref: string): string[] {
  if (!isImageRef(ref)) throw new InvalidInputError('Invalid image reference')
  return ['docker', 'pull', ref]
}
