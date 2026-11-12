export const REQUEST_TIMEOUT_MS = 110_000
export const WORK_BUDGET_MS = 100_000
export type RunOptions = { deadline: number; signal?: AbortSignal } // worker 안에서 한 요청의 예산
export type HostId = 'local' | `ssh:${string}`
export type HostStatus = 'ready' | 'unsupported' | 'unreachable' | 'no-workspace'
export type HostInfo = { id: HostId; label: string; kind: 'local' | 'ssh'; status: HostStatus }
// ssh-failed: ssh itself failed (unknown host, no login without a prompt, could not start). `message` says what failed
// and names the host when there is one (the could-not-start message has none).
export type ProblemKind = 'unsupported' | 'unreachable' | 'no-workspace' | 'docker-missing' | 'daemon-down'
  | 'permission-denied' | 'truncated' | 'timeout' | 'unknown-result' | 'invalid' | 'failed' | 'ssh-failed'
export type Problem = { kind: ProblemKind; message: string }
export type Result<T> = { ok: true; value: T } | { ok: false; problem: Problem }
export type ContainerState = 'created' | 'running' | 'paused' | 'restarting' | 'removing' | 'exited' | 'dead' | 'unknown'
export type ContainerRow = { id: string; name: string; image: string; state: ContainerState; status: string; ports: string;
  project: string; service: string } // Compose project/service; '' when the container has no such label
export type ImageRow = { id: string; repository: string; tag: string; size: string; createdSince: string }
export type VolumeRow = { name: string; driver: string }
export type NetworkRow = { id: string; name: string; driver: string; scope: string }
export type Snapshot = { hostId: HostId; takenAt: number; serverVersion: string; containers: ContainerRow[];
  images: ImageRow[]; volumes: VolumeRow[]; networks: NetworkRow[] }
export type ContainerAction = 'start' | 'stop' | 'restart' | 'remove'
export type TerminalKind = 'logs' | 'shell'
export type FocusContext = { displayName: string; branch: string; terminalIds: string[] }
export type Opened = { opened: true; workspace: string }
declare module 'orca' {
  interface PluginRequests {
    'hosts.list': { input: { refresh?: boolean }; output: Result<{ hosts: HostInfo[] }> }
    'hosts.matchFocus': { input: FocusContext; output: Result<{ hostId: HostId | null }> }
    'docker.snapshot': { input: { hostId: HostId }; output: Result<Snapshot> }
    'docker.action': { input: { hostId: HostId; action: ContainerAction; containerId: string }; output: Result<{ done: true }> }
    'docker.logs': { input: { hostId: HostId; containerId: string }; output: Result<{ lines: string[]; takenAt: number }> }
    // `workspace`: where the tab opened (the local workspace's name, or the SSH anchor path's last part).
    'docker.openTerminal': { input: { hostId: HostId; kind: TerminalKind; containerId: string; containerName: string }; output: Result<Opened> }
  }
}
