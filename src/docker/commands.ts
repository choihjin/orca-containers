import type { ComposeAction, ContainerAction, ResourceKind, TerminalKind } from '../protocol'

// argv: without 'docker'. timeoutSeconds: this command's own limit, when it is not the runners' default 20 s.
export type DockerCommand = {
  name: 'version' | 'ps' | 'images' | 'volumes' | 'networks' | 'action' | 'logs' | 'remove' | 'labels' | 'compose'
  argv: string[]
  timeoutSeconds?: number
}

// A command's own limit in seconds, or undefined for the runner's default. Both runners refuse anything else before
// they run a command.
export function ownTimeoutSeconds(command: DockerCommand): number | undefined {
  const seconds = command.timeoutSeconds
  if (seconds !== undefined && (!Number.isInteger(seconds) || seconds <= 0)) {
    throw new Error(`timeoutSeconds must be a positive whole number: ${seconds}`)
  }
  return seconds
}

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

// Compose's normalized project name: never an option, never two arguments.
const COMPOSE_PROJECT = /^[a-z0-9][a-z0-9_-]{0,62}$/
// C0 and C1 controls, DEL, the backslash (fish reads `\'` inside single quotes as an escape, so it could end the quotes
// of the typed Up command) and the Unicode line and paragraph separators.
const UNSAFE_PATH_CHAR = /[\x00-\x1f\x7f-\x9f\\\u2028\u2029]/
const COMPOSE_PATH_MAX = 1024
export const COMPOSE_FILES_MAX = 16
export const COMPOSE_TIMEOUT_SECONDS = 55

export function isComposeProject(name: string): boolean {
  return COMPOSE_PROJECT.test(name)
}

const COMPOSE_VERB: Record<ComposeAction, string> = { start: 'start', stop: 'stop', restart: 'restart', down: 'down' }

// Takes a raw request value too: only a string is looked up (Object.hasOwn would turn ['stop'] into 'stop').
export function isComposeAction(value: unknown): value is ComposeAction {
  return typeof value === 'string' && Object.hasOwn(COMPOSE_VERB, value)
}

// A working directory or a config file as Compose recorded it: absolute (so never an option), at most 1024 characters,
// none of UNSAFE_PATH_CHAR (so never a second line, or a way out of the quotes, in a typed command).
export function isComposePath(path: string): boolean {
  return path.startsWith('/') && path.length <= COMPOSE_PATH_MAX && !UNSAFE_PATH_CHAR.test(path)
}

// Where a project's files are, read from one member container's labels (parse.ts parseComposeTarget).
export type ComposeTarget = { project: string; dir: string; files: string[] }

export function composeLabelsCommand(memberId: string): DockerCommand {
  requireId(memberId)
  return { name: 'labels', argv: ['inspect', '--format', '{{json .Config.Labels}}', memberId] }
}

function composeBase(target: ComposeTarget): string[] {
  if (!isComposeProject(target.project)) throw new InvalidInputError('Invalid Compose project name')
  if (!isComposePath(target.dir)) throw new InvalidInputError('Invalid Compose project directory')
  const { files } = target
  if (files.length < 1 || files.length > COMPOSE_FILES_MAX || !files.every(isComposePath)) throw new InvalidInputError('Invalid Compose file list')
  return ['compose', '--project-directory', target.dir, '-p', target.project, ...files.flatMap((file) => ['-f', file])]
}

// One compose command for the whole project, in the panel, with a 55 s limit. Down keeps volumes and images
// (never -v, --volumes or --rmi).
export function composeCommand(target: ComposeTarget, action: ComposeAction): DockerCommand {
  if (!isComposeAction(action)) throw new InvalidInputError('Invalid Compose action')
  return { name: 'compose', argv: [...composeBase(target), COMPOSE_VERB[action]], timeoutSeconds: COMPOSE_TIMEOUT_SECONDS }
}

// Up runs in an Orca terminal: it may pull or build for longer than any panel request.
export function composeUpArgv(target: ComposeTarget): string[] {
  return ['docker', ...composeBase(target), 'up', '-d']
}
