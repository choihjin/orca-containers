export const REQUEST_TIMEOUT_MS = 110_000
export const WORK_BUDGET_MS = 100_000
export type RunOptions = { deadline: number; signal?: AbortSignal } // worker 안에서 한 요청의 예산
export type HostId = 'local' | `ssh:${string}`
// unsupported: the local platform is not macOS or Linux, or the SSH host's stored kernel is not Linux or macOS.
// Orca's workspace listing does not decide a status: an SSH host is ready unless unsupported, and ssh tells the rest.
export type HostStatus = 'ready' | 'unsupported'
export type HostInfo = { id: HostId; label: string; kind: 'local' | 'ssh'; status: HostStatus }
// ssh-failed: ssh itself failed (unknown host, no login without a prompt, could not start). `message` says what failed
// and names the host when there is one (the could-not-start message has none).
// startup-shell: an SSH host's login startup files seem to start tmux, screen or byobu, so a terminal's typed command could land
// in that session; nothing was opened. `message` lists the files by their path in $HOME, e.g. `.bashrc, .config/fish/config.fish`.
export type ProblemKind = 'unsupported' | 'unreachable' | 'no-workspace' | 'docker-missing' | 'daemon-down'
  | 'permission-denied' | 'truncated' | 'timeout' | 'unknown-result' | 'invalid' | 'failed' | 'ssh-failed' | 'startup-shell'
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
export type ComposeAction = 'start' | 'stop' | 'restart' | 'down'
export type TerminalKind = 'logs' | 'shell'
export type ResourceKind = 'image' | 'volume' | 'network'
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
    // `allowStartupShell` (here, on pullTerminal and on composeUp): true opens an SSH host's terminal without reading its
    // login startup files first (the panel's Open anyway after a startup-shell answer). This Mac is never checked.
    'docker.openTerminal': {
      input: { hostId: HostId; kind: TerminalKind; containerId: string; containerName: string; allowStartupShell?: boolean }; output: Result<Opened>
    }
    // `ref`: an image id or reference, a volume name, or a network id. Never forced: Docker refuses an item in use.
    'docker.removeResource': { input: { hostId: HostId; kind: ResourceKind; ref: string }; output: Result<{ done: true }> }
    // Opens `docker pull <ref>` in an Orca terminal, as Shell does: a large pull outlasts any panel request.
    'docker.pullTerminal': { input: { hostId: HostId; ref: string; allowStartupShell?: boolean }; output: Result<Opened> }
    // A Compose project's start, stop, restart or down, as one compose command in the panel. `memberId`: one of the
    // project's containers, whose labels say where the project's files are. Down keeps volumes and images.
    'docker.composeAction': { input: { hostId: HostId; project: string; memberId: string; action: ComposeAction }; output: Result<{ done: true }> }
    // Opens `docker compose ... up -d` in an Orca terminal, as Pull does: it may pull or build for a long time.
    'docker.composeUp': { input: { hostId: HostId; project: string; memberId: string; allowStartupShell?: boolean }; output: Result<Opened> }
  }
}
