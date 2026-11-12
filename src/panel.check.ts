// `orca plugin check` renders the panel once per scenario. Every scenario stubs all six worker
// requests, so check never reaches the worker's docker or Orca CLI calls. The log view opens only on a
// press and nothing a scenario seeds can open it, so no scenario draws it.
import type { PluginRequests } from 'orca'
import { defineCheck, type CheckScenario } from 'orca/testing'
import type { ContainerRow, HostId, HostInfo, Problem, Result, Snapshot } from './protocol'

type Stubs = { [K in keyof PluginRequests]-?: (input: PluginRequests[K]['input']) => PluginRequests[K]['output'] }

// A missing request name is a type error here, not a silent call into the real worker.
function scenario(r: Stubs, options: Omit<CheckScenario, 'requests'> = {}): CheckScenario & { requests: Stubs } {
  return { ...options, requests: r }
}

const LOCAL: HostInfo = { id: 'local', label: 'This Mac', kind: 'local', status: 'ready' }
const GPU1: HostInfo = { id: 'ssh:GPU1', label: 'GPU1', kind: 'ssh', status: 'ready' }
const GPU2: HostInfo = { id: 'ssh:GPU2', label: 'GPU2', kind: 'ssh', status: 'unreachable' }

const row = (
  id: string, name: string, image: string, state: ContainerRow['state'], status: string, ports = '', compose = { project: '', service: '' },
): ContainerRow => ({ id, name, image, state, status, ports, ...compose })
const CONTAINERS: Record<string, ContainerRow[]> = {
  local: [
    row('0123456789ab', 'web', 'nginx:1.27', 'running', 'Up 3 hours', '0.0.0.0:8080->80/tcp'),
    row('123456789abc', 'db', 'postgres:16', 'exited', 'Exited (0) 2 days ago'),
  ],
  // A Compose project with two services, and one container of its own.
  'ssh:GPU1': [
    row('23456789abcd', 'ml-trainer-1', 'pytorch/pytorch:2.5.1-cuda12.4-cudnn9-runtime', 'running', 'Up 5 days', '',
      { project: 'ml', service: 'trainer' }),
    row('3456789abcde', 'ml-jupyter-1', 'jupyter/base-notebook:latest', 'running', 'Up 5 days', '0.0.0.0:8888->8888/tcp',
      { project: 'ml', service: 'jupyter' }),
    row('456789abcdef', 'old-run', 'pytorch/pytorch:2.5.1-cuda12.4-cudnn9-runtime', 'exited', 'Exited (137) 3 weeks ago'),
  ],
}

function snapshot(hostId: HostId, containers: ContainerRow[]): Result<Snapshot> {
  const full = containers.length > 0
  return {
    ok: true,
    value: {
      hostId, takenAt: Date.now(), serverVersion: '27.3.1', containers,
      images: full ? [{ id: 'sha256:5f1e6a2b', repository: 'nginx', tag: '1.27', size: '192MB', createdSince: '2 weeks ago' }] : [],
      volumes: full ? [{ name: 'pgdata', driver: 'local' }] : [],
      networks: full
        ? [
            { id: '9a8b7c6d5e4f', name: 'bridge', driver: 'bridge', scope: 'local' },
            { id: '8b7c6d5e4f3a', name: 'host', driver: 'host', scope: 'local' },
          ]
        : [],
    },
  }
}
const failure = (problem: Problem): { ok: false; problem: Problem } => ({ ok: false, problem })

function stubs(hosts: HostInfo[], snap: Stubs['docker.snapshot']): Stubs {
  return {
    'hosts.list': () => ({ ok: true, value: { hosts } }),
    'hosts.matchFocus': () => ({ ok: true, value: { hostId: null } }),
    'docker.snapshot': snap,
    'docker.action': () => ({ ok: true, value: { done: true } }),
    'docker.openTerminal': () => ({ ok: true, value: { opened: true, workspace: 'orca-docker' } }),
    'docker.logs': () => ({
      ok: true,
      value: { lines: ['/docker-entrypoint.sh: Configuration complete; ready for start up', 'GET / HTTP/1.1 200'], takenAt: Date.now() },
    }),
  }
}
const listed = ({ hostId }: { hostId: HostId }) => snapshot(hostId, CONTAINERS[hostId] ?? [])

export default defineCheck({
  local: scenario(stubs([LOCAL, GPU1], listed)),
  ssh: scenario(stubs([LOCAL, GPU1], listed), { persisted: { plugin: { selectedHost: 'ssh:GPU1' } } }),
  daemonDown: scenario(stubs([LOCAL, GPU1], () =>
    failure({ kind: 'daemon-down', message: 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock.' }))),
  unreachable: scenario(stubs([LOCAL, GPU2], () => failure({ kind: 'unreachable', message: 'ssh: connect to host timed out' })), {
    persisted: { plugin: { selectedHost: 'ssh:GPU2' } },
  }),
  empty: scenario(stubs([LOCAL], ({ hostId }) => snapshot(hostId, []))),
  // This Mac with every section open, for the plugin page screenshots.
  resources: scenario(stubs([LOCAL, GPU1], listed), {
    persisted: { plugin: { sections: { containers: true, images: true, volumes: true, networks: true } } },
  }),
})
