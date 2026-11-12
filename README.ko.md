# Containers for Orca

![이 Mac과 SSH 호스트의 Containers 패널](assets/cover.png)

[Orca](https://github.com/stablyai/orca) 사이드바 패널에서 Docker 컨테이너를 보고 관리합니다. 이 Mac과
Linux SSH 호스트 모두 지원합니다. 호스트를 고르면 컨테이너, 이미지, 볼륨, 네트워크를 볼 수 있습니다(이미지,
볼륨, 네트워크는 보기만 가능). 컨테이너는 시작, 중지, 재시작하거나 로그를 보고 셸을 열고 삭제할 수 있습니다.

[English](README.md)

## 기능

- **호스트 선택:** 이 Mac과 Orca에 등록된 SSH 호스트.
- **포커스된 워크스페이스 따라가기:** 기본값은 켜짐입니다. 포커스된 워크스페이스가 호스트 하나로
  특정될 때만 호스트를 바꿉니다.
- **필터:** 입력한 글자가 들어간 항목만 섹션마다 보여 줍니다. 대소문자는 가리지 않습니다.
- **접는 섹션:** Containers, Images, Volumes, Networks로 나뉘고, 섹션마다 개수가 표시됩니다(Containers는
  실행 중인 수도 함께). 처음에는 Containers만 펼쳐져 있고, 어떤 섹션을 펼쳤는지는 패널이 기억합니다.
- **Compose 프로젝트별 묶음:** 같은 Compose 프로젝트의 컨테이너는 그 프로젝트 아래에 모이고, 나머지
  컨테이너는 그 뒤에 나옵니다. Compose 프로젝트 안의 컨테이너는 상태 아이콘, 서비스 이름, 상태가 보이고, 그 밖의 컨테이너는
  이미지와 상태가 보입니다.
- **컨테이너 상세와 동작:** 컨테이너를 선택하면 전체 이름, 이미지, 상태, 포트, Compose 프로젝트, ID가 담긴 카드가
  나오고, 그 카드에서 Start, Stop, Restart, Logs, Shell, Delete를 쓸 수 있습니다. Delete는 확인을 거치고,
  실행 중인 컨테이너에는 비활성화됩니다. 컨테이너에서 Enter를 누르거나 더블클릭하면 로그가 열립니다. Shell은 해당 호스트에 터미널을 열고, Orca가 그
  터미널을 앞으로 가져오려고 시도합니다. Compose 프로젝트 행을 클릭하면 접히거나 펼쳐집니다.
- **패널 안의 로그:** Logs를 누르면 컨테이너 로그의 마지막 200줄이 색상 코드 없이 카드 아래에 나오고, 패널이 보이는
  동안 새로 고쳐집니다. 이 Mac은 3초, SSH 호스트는 10초 간격입니다. 다른 컨테이너를 고르면 로그도 그 컨테이너로
  바뀝니다. **Open in terminal**을 누르면 해당 호스트의 Orca 터미널에서 로그를 실시간으로 따라가고, Orca가 그 터미널을
  앞으로 가져오려고 시도합니다.
- **자동 새로고침**은 패널이 보일 때만 합니다. 이 Mac은 10초, SSH 호스트는 60초 간격입니다. 플러그인
  Settings에서 `refreshLocalSeconds`(3–600)와 `refreshRemoteSeconds`(15–3600)로 바꿀 수 있습니다.

## 필요한 것

- macOS의 Orca 1.4.255 이상
- 이 Mac과, 사용할 SSH 호스트마다 `docker` 설치
- Orca의 SSH 호스트 기능으로 추가한 Linux 호스트
- SSH 호스트마다 이 Mac의 `~/.ssh/config`에 Orca 호스트 이름과 똑같은 `Host` 항목. 그 항목은 프롬프트 없이 키로
  로그인해야 합니다(예: ssh-agent에 올린 키). 확인하려면 이 Mac의 터미널에서
  `ssh -o BatchMode=yes <호스트 이름> true`를 실행해 보세요. 오류 없이 끝나야 합니다. 호스트 이름은 영문자, 숫자,
  `.`, `_`, `-`로 이루어지고 첫 글자가 영문자나 숫자여야 합니다. 그 밖의 이름은 ssh로 쓸 수 없습니다.

## 설치

Orca에서 **Settings → Plugins**를 열고 **Add plugin → From a Git URL…**을 고른 뒤, 버전 태그를 붙인
저장소 주소를 붙여 넣어 설치합니다.

```text
https://github.com/choihjin/orca-containers#v0.1.1
```

터미널에서는 `orca plugin install choihjin/orca-containers@v0.1.1`으로도 설치할 수 있습니다.

Orca는 실행 전에 플러그인이 요청하는 권한을 보여 줍니다. 확인한 뒤 켜세요.

## 동작 방식

- **이 Mac:** 플러그인 워커가 `docker` 명령을 직접 실행합니다.
- **이 Mac에서 `docker` 찾기:** `/usr/local/bin`, `/opt/homebrew/bin`, `/usr/bin`에 `docker`가 없으면 워커가
  `/bin/zsh -lc 'command -v docker'`를 실행합니다. 이때 zsh 로그인 시작 파일(`~/.zshenv`, `~/.zprofile`,
  `~/.zlogin`)이 실행됩니다. 찾은 경로는 다시 쓰고, 찾지 못하는 동안은 새로 고칠 때마다 다시 실행합니다.
- **SSH 호스트:** 목록, 동작, 패널 안의 로그는 이 Mac에서 `ssh <호스트 이름>`을 실행합니다. ssh 접속 대상은
  Orca 호스트 이름 그대로이고, 그 호스트의 `sh`에 정해진 스크립트를 보냅니다. 터미널은 열지 않습니다.
  ssh는 `BatchMode=yes`로 실행하므로 비밀번호나 passphrase를 묻지 않습니다. 프롬프트 없이 로그인할 수 없는
  호스트에는 "SSH connection failed"와 함께 고칠 점이 표시됩니다. 60초가 지나도 끝나지 않은 ssh 실행은 멈춥니다.
- **SSH 호스트의 터미널:** 터미널은 Shell과 **Open in terminal**을 누를 때만 열립니다. Orca 자체 명령줄
  도구(`orca … --environment <호스트>`)로 그 호스트의 워크스페이스에 Orca 터미널을 엽니다.

## 요청하는 권한

| 권한 | 이유 |
| --- | --- |
| 별도 Node.js 프로세스에서, 이 컴퓨터에 대한 내 사용자 계정 권한으로 자체 코드 실행 (`trusted-worker`) | 워커가 `docker`, `ssh`, Orca 명령줄 도구를 실행해야 함 |
| `workspace:read` | 포커스된 워크스페이스와 이 Mac의 워크스페이스 목록을 읽고, 포커스된 워크스페이스가 바뀌는 것을 받음 (포커스된 워크스페이스 따라가기용) |
| `terminal:send` | 이 Mac의 워크스페이스에 실시간 로그(Open in terminal)와 Shell 터미널을 열고 정해진 docker 명령을 실행 |
| `storage:own` | 플러그인 전용 저장 폴더에 데이터 저장 |
| `settings:own` | 플러그인 자체 설정을 읽고 변경 |

워커가 `docker`, `ssh`, Orca 명령줄 도구를 실행하는 것은 Orca의 승인 목록에 따로 나타나지 않습니다. 위의
`trusted-worker` 권한에 포함됩니다. SSH 호스트의 터미널(Shell과 Open in terminal)은 Orca 명령줄 도구를
통해 엽니다.

## 한계

- SSH 요청마다 ssh 연결을 새로 엽니다. 그래서 SSH 호스트는 이 Mac보다 느리게 응답합니다.
- SSH 호스트의 응답이 64 MiB를 넘으면 보여 주지 않고 패널에 "List too long"이 표시됩니다.
- 패널의 로그는 한 줄을 500자에서 자르고, 15,000자 안에 들어가는 최근 줄만 보여 줍니다. Open in terminal에서는
  잘리지 않고 보입니다.
- SSH 호스트의 로그인 셸 시작 파일이 tmux나 screen을 자동으로 붙이면, Shell이나 Open in terminal의 docker 명령이
  그 프로그램에 입력될 수 있습니다.

## v1에 없는 것

이후 버전에서 하려는 일입니다. 각 항목은 착수 전에 시험으로 확인합니다. Compose up/down, 이미지·볼륨·네트워크
삭제와 pull, Linux나 Windows의 Orca, macOS SSH 호스트, 1.4.255보다 오래된 Orca, 한국어 UI, 로그인 셸이 tmux나
screen을 자동으로 붙이는 SSH 호스트 감지.

## 개발

```sh
pnpm install
pnpm test        # orca plugin test .
pnpm typecheck   # Orca 타입을 생성한 뒤 tsc 실행
orca plugin validate .
```

아이콘, 커버, 스크린샷은 `assets/src`의 HTML 페이지로 만듭니다. `assets/src/render.sh shots`는 check 시나리오의 패널을
찍고(Orca 창을 숨기거나 최소화해야 함), `assets/src/render.sh images`는 headless Chrome으로 PNG를 만듭니다.

## 라이선스

[MIT](LICENSE).

This project is not affiliated with, endorsed by, or sponsored by Docker, Inc. Docker is a trademark of Docker, Inc.; the name is used only to describe compatibility.
