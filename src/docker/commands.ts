import type { ContainerAction, TerminalKind } from '../protocol'

export type DockerCommand = { name: 'version' | 'ps' | 'images' | 'volumes' | 'networks' | 'action' | 'logs'; argv: string[] } // 'docker' 제외

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
