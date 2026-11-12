// The panel's own words, in English and Korean. What Docker, ssh and the worker say (the message of an
// invalid, failed or ssh-failed problem, names, statuses) is shown as it comes and is not here.
import type { LocalHostLabel } from './platform'
import type { ProblemKind, ResourceKind, TerminalKind } from './protocol'

export type Lang = 'en' | 'ko'

// The plugin's Language setting: `en` or `ko` picks that language; `auto`, a missing value or anything else
// follows Orca's UI language (BCP-47): Korean for `ko` and its regional forms (`ko-KR`), English otherwise.
export function resolveLang(setting: unknown, locale: string): Lang {
  if (setting === 'en' || setting === 'ko') return setting
  const language = typeof locale === 'string' ? locale.split(/[-_]/)[0]?.toLowerCase() : undefined
  return language === 'ko' ? 'ko' : 'en'
}

// Problems whose description is the message that came with them; only their title is the panel's.
type MessageKind = 'invalid' | 'failed' | 'ssh-failed'
type SectionId = 'containers' | 'images' | 'volumes' | 'networks'

export type Messages = {
  // The host bar.
  host: string
  chooseHost: string
  refresh: string
  followFocus: string
  // Before the time of the last snapshot (a RelativeTime).
  updated: string
  /** The worker names the local host 'This Mac' or 'This computer'; these are those names in this language. */
  localNames: Record<LocalHostLabel, string>
  filter: string
  filterPlaceholder: string
  // A host option's suffix: "GPU1 (SSH, unsupported)".
  ssh: string
  unsupported: string
  loadingHosts: string
  noHostTitle: string
  noHostDescription: string
  loadingContainers: string
  // A section's title (also its tree's label), and the line in place of an empty tree.
  sections: Record<SectionId, { title: string; none: string; noMatch: string }>
  runningOfTotal: (running: number, total: number) => string
  // Tree row descriptions: a Compose project, an image repository.
  composeRunning: (running: number, total: number) => string
  tags: (count: number) => string
  // Card keys.
  fields: { image: string; status: string; ports: string; compose: string; id: string; size: string; created: string; driver: string; scope: string }
  // Card toolbars and buttons.
  containerActions: string
  resourceActions: Record<ResourceKind, string>
  start: string
  stop: string
  restart: string
  logs: string
  shell: string
  pull: string
  delete: string
  cancel: string
  working: string
  // The delete question: its title, and what it says will happen.
  deleteTitle: (name: string) => string
  removeContainer: string
  removeTag: string
  removeImage: string
  removeVolume: string
  removeNetwork: string
  builtInNetwork: string
  // Where a Logs, Shell or Pull tab opened (in the background).
  openedTerminal: Record<TerminalKind, (workspace: string) => string>
  openedPull: (ref: string, workspace: string) => string
  // The log view.
  logsUpdated: string
  refreshLogs: string
  closeLogs: string
  openInTerminal: string
  loadingLogs: string
  noLogs: string
  // The pull row.
  imageToPull: string
  notAnImage: string
  problems: Record<Exclude<ProblemKind, MessageKind>, { title: string; description: string }> & Record<MessageKind, { title: string }>
}

const en: Messages = {
  host: 'Host',
  chooseHost: 'Choose a host',
  refresh: 'Refresh',
  followFocus: 'Follow focused workspace',
  updated: 'Updated ',
  localNames: { 'This Mac': 'This Mac', 'This computer': 'This computer' },
  filter: 'Filter',
  filterPlaceholder: 'Filter containers, images…',
  ssh: 'SSH',
  unsupported: 'unsupported',
  loadingHosts: 'Loading hosts',
  noHostTitle: 'No host is ready',
  noHostDescription: 'Pick a host above when one becomes ready.',
  loadingContainers: 'Loading containers',
  sections: {
    containers: { title: 'Containers', none: 'No containers', noMatch: 'No containers match the filter' },
    images: { title: 'Images', none: 'No images', noMatch: 'No images match the filter' },
    volumes: { title: 'Volumes', none: 'No volumes', noMatch: 'No volumes match the filter' },
    networks: { title: 'Networks', none: 'No networks', noMatch: 'No networks match the filter' },
  },
  runningOfTotal: (running, total) => `${running} running / ${total}`,
  composeRunning: (running, total) => `compose · ${running}/${total} running`,
  tags: (count) => `${count} ${count === 1 ? 'tag' : 'tags'}`,
  fields: {
    image: 'Image', status: 'Status', ports: 'Ports', compose: 'Compose', id: 'ID', size: 'Size', created: 'Created', driver: 'Driver', scope: 'Scope',
  },
  containerActions: 'Container actions',
  resourceActions: { image: 'Image actions', volume: 'Volume actions', network: 'Network actions' },
  start: 'Start',
  stop: 'Stop',
  restart: 'Restart',
  logs: 'Logs',
  shell: 'Shell',
  pull: 'Pull',
  delete: 'Delete',
  cancel: 'Cancel',
  working: 'Working',
  deleteTitle: (name) => `Delete ${name}?`,
  removeContainer: 'The container is removed from the host. This cannot be undone.',
  removeTag: 'The tag is removed, and the image too when no other tag uses it. This cannot be undone.',
  removeImage: 'The image is removed from the host. This cannot be undone.',
  removeVolume: 'The volume and its data are removed from the host. This cannot be undone.',
  removeNetwork: 'The network is removed from the host. This cannot be undone.',
  builtInNetwork: "Docker's built-in networks cannot be deleted.",
  openedTerminal: {
    logs: (workspace) => `Opened logs in ${workspace}.`,
    shell: (workspace) => `Opened shell in ${workspace}.`,
  },
  openedPull: (ref, workspace) => `Opened pull: ${ref} in ${workspace}.`,
  logsUpdated: 'Logs updated ',
  refreshLogs: 'Refresh logs',
  closeLogs: 'Close logs',
  openInTerminal: 'Open in terminal',
  loadingLogs: 'Loading logs',
  noLogs: 'No log output',
  imageToPull: 'Image to pull',
  notAnImage: 'Not an image name. Use one like nginx:latest or ghcr.io/org/app:1.2.',
  problems: {
    unsupported: { title: 'Not supported here', description: 'This version supports Orca on macOS or Linux, with Linux or macOS SSH hosts.' },
    unreachable: { title: 'Host unreachable', description: 'Orca could not reach this host. Check its SSH connection in Orca.' },
    'no-workspace': { title: 'No workspace on this host', description: 'Open a workspace on this host in Orca first.' },
    'docker-missing': { title: 'Docker CLI not found', description: 'Install the docker command on this host.' },
    'daemon-down': { title: 'Docker is not running', description: 'Start the Docker daemon on this host.' },
    'permission-denied': { title: 'Permission denied', description: 'Your account cannot use the Docker socket on this host.' },
    truncated: { title: 'List too long', description: 'The output was too large to show.' },
    timeout: { title: 'Timed out', description: 'Docker did not answer in time.' },
    'unknown-result': { title: 'Result unknown', description: 'The command was sent, but its result did not come back. Refresh to check.' },
    invalid: { title: 'Invalid request' },
    failed: { title: 'Command failed' },
    'ssh-failed': { title: 'SSH connection failed' },
  },
}

// Plain 합니다체, as in README.ko.md. Docker, SSH, Compose, Pull and Shell stay in English.
const ko: Messages = {
  host: '호스트',
  chooseHost: '호스트 선택',
  refresh: '새로고침',
  followFocus: '포커스된 워크스페이스 따라가기',
  updated: '마지막 갱신 ',
  localNames: { 'This Mac': '이 Mac', 'This computer': '이 컴퓨터' },
  filter: '필터',
  filterPlaceholder: '컨테이너, 이미지 필터…',
  ssh: 'SSH',
  unsupported: '지원 안 함',
  loadingHosts: '호스트를 불러오는 중',
  noHostTitle: '준비된 호스트가 없습니다',
  noHostDescription: '호스트가 준비되면 위에서 고르세요.',
  loadingContainers: '컨테이너를 불러오는 중',
  sections: {
    containers: { title: '컨테이너', none: '컨테이너가 없습니다', noMatch: '필터에 맞는 컨테이너가 없습니다' },
    images: { title: '이미지', none: '이미지가 없습니다', noMatch: '필터에 맞는 이미지가 없습니다' },
    volumes: { title: '볼륨', none: '볼륨이 없습니다', noMatch: '필터에 맞는 볼륨이 없습니다' },
    networks: { title: '네트워크', none: '네트워크가 없습니다', noMatch: '필터에 맞는 네트워크가 없습니다' },
  },
  runningOfTotal: (running, total) => `${total}개 중 ${running}개 실행 중`,
  composeRunning: (running, total) => `Compose · ${running}/${total} 실행 중`,
  tags: (count) => `태그 ${count}개`,
  fields: {
    image: '이미지', status: '상태', ports: '포트', compose: 'Compose', id: 'ID', size: '크기', created: '생성', driver: '드라이버', scope: '범위',
  },
  containerActions: '컨테이너 작업',
  resourceActions: { image: '이미지 작업', volume: '볼륨 작업', network: '네트워크 작업' },
  start: '시작',
  stop: '중지',
  restart: '재시작',
  logs: '로그',
  shell: 'Shell',
  pull: 'Pull',
  delete: '삭제',
  cancel: '취소',
  working: '작업 중',
  deleteTitle: (name) => `${name} 삭제`,
  removeContainer: '호스트에서 컨테이너를 삭제합니다. 되돌릴 수 없습니다.',
  removeTag: '태그를 삭제하고, 이미지에 다른 태그가 없으면 이미지도 삭제합니다. 되돌릴 수 없습니다.',
  removeImage: '호스트에서 이미지를 삭제합니다. 되돌릴 수 없습니다.',
  removeVolume: '호스트에서 볼륨을 데이터와 함께 삭제합니다. 되돌릴 수 없습니다.',
  removeNetwork: '호스트에서 네트워크를 삭제합니다. 되돌릴 수 없습니다.',
  builtInNetwork: 'Docker 기본 네트워크는 삭제할 수 없습니다.',
  openedTerminal: {
    logs: (workspace) => `${workspace}에 로그 터미널을 열었습니다.`,
    shell: (workspace) => `${workspace}에 Shell을 열었습니다.`,
  },
  openedPull: (ref, workspace) => `${workspace}에 ${ref} Pull 터미널을 열었습니다.`,
  logsUpdated: '로그 갱신 ',
  refreshLogs: '로그 새로고침',
  closeLogs: '로그 닫기',
  openInTerminal: '터미널에서 열기',
  loadingLogs: '로그를 불러오는 중',
  noLogs: '로그가 없습니다',
  imageToPull: 'Pull할 이미지',
  notAnImage: '이미지 이름이 아닙니다. nginx:latest나 ghcr.io/org/app:1.2처럼 입력하세요.',
  problems: {
    unsupported: { title: '여기서는 지원하지 않습니다', description: '이 버전은 macOS·Linux의 Orca와 Linux·macOS SSH 호스트를 지원합니다.' },
    unreachable: { title: '호스트에 연결할 수 없습니다', description: 'Orca가 이 호스트에 연결하지 못했습니다. Orca에서 이 호스트의 SSH 연결을 확인하세요.' },
    'no-workspace': { title: '이 호스트에 워크스페이스가 없습니다', description: '먼저 Orca에서 이 호스트의 워크스페이스를 여세요.' },
    'docker-missing': { title: 'Docker CLI를 찾을 수 없습니다', description: '이 호스트에 docker 명령을 설치하세요.' },
    'daemon-down': { title: 'Docker가 실행 중이 아닙니다', description: '이 호스트에서 Docker 데몬을 시작하세요.' },
    'permission-denied': { title: '권한이 없습니다', description: '지금 계정으로는 이 호스트의 Docker 소켓을 쓸 수 없습니다.' },
    truncated: { title: '목록이 너무 깁니다', description: '출력이 너무 커서 보여 줄 수 없습니다.' },
    timeout: { title: '시간이 초과되었습니다', description: 'Docker가 제시간에 응답하지 않았습니다.' },
    'unknown-result': { title: '결과를 알 수 없습니다', description: '명령은 보냈지만 결과가 돌아오지 않았습니다. 새로고침해서 확인하세요.' },
    invalid: { title: '잘못된 요청입니다' },
    failed: { title: '명령이 실패했습니다' },
    'ssh-failed': { title: 'SSH 연결에 실패했습니다' },
  },
}

export const messages: Record<Lang, Messages> = { en, ko }
