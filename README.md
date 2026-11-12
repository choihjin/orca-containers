# Containers for Orca

![Containers panels for this Mac and an SSH host](assets/cover.png)

See and manage Docker containers from an [Orca](https://github.com/stablyai/orca) sidebar panel, on
this Mac and on your Linux or macOS SSH hosts. Pick a host and see its containers, images, volumes and networks.
Start, stop, restart, read logs, open a shell or delete a container; start, stop, restart, bring up or take down a
Compose project; delete images, volumes and networks; and pull images in an Orca terminal.

[한국어](README.ko.md)

## What it does

- **Host picker:** this Mac and each SSH host Orca knows.
- **Follow focused workspace:** on by default. The panel switches host only when the focused workspace
  identifies exactly one host.
- **Filter box:** every section shows only the items that contain the text you type (case does not
  matter).
- **Collapsible sections:** Containers, Images, Volumes and Networks, each with its count (Containers
  shows how many are running). Containers is open at first; the panel remembers which sections you
  opened.
- **Compose projects:** containers of the same Compose project are grouped under the project, and the
  other containers follow. Inside a Compose project a container shows a state icon, its service name and its status; other
  containers show their image and status.
- **Container details and actions:** selecting a container shows a card with its full name, image, status,
  ports, Compose project and ID, and the actions Start, Stop, Restart, Logs, Shell and Delete. Delete asks for
  confirmation and is disabled for running containers. Enter or a double-click on a container opens its
  logs. Shell opens a terminal on that host and Orca tries to bring that terminal to the front. A click on a Compose
  project row expands or collapses it and shows the project's card (see [Compose projects](#compose-projects)).
- **Images, volumes and networks:** selecting an image tag, a volume or a network shows a card with its
  details and a Delete button, which asks for confirmation. Delete is never forced, so Docker refuses to
  delete what is in use (for example a volume a container uses, or a network with containers connected),
  and the card shows Docker's message. An image tag is deleted by its name (Docker removes the image too
  when no other tag uses it), an image without a repository or tag by its ID. The built-in networks
  `bridge`, `host` and `none` cannot be deleted. A click on a repository row in Images expands or
  collapses it.
- **Pull images:** **Pull** on an image tag's card, or a name typed into the Images section (for example
  `nginx:latest`), runs `docker pull` in an Orca terminal on that host, the same way Shell does, so a large
  pull is not bound by the panel's request time limit. The panel refuses a name that is not an image
  reference before anything runs.
- **Logs in the panel:** Logs shows the container's last 200 log lines under its card, without colour
  codes, and refreshes them while the panel is visible: every 3 s for this Mac, every 10 s for SSH hosts.
  Picking another container switches the logs to it. **Open in terminal** follows the logs live in an Orca
  terminal on that host, and Orca tries to bring that terminal to the front.
- **Auto refresh** only while the panel is visible: every 10 s for this Mac, every 60 s for SSH hosts.
  Change both in the plugin's Settings: `refreshLocalSeconds` (3–600) and `refreshRemoteSeconds`
  (15–3600).
- **Language:** the panel follows Orca's UI language: Korean when Orca is in Korean, English otherwise.
  The plugin's **Language** setting (`language`) picks one instead: Follow Orca (`auto`, the default), English
  or 한국어. What Docker and ssh say (a daemon error, why ssh failed) and container statuses ("Up 5 days")
  stay in English, as they come.

## Compose projects

Selecting a Compose project row shows the project's card: how many services it has and how many of its
containers are running, with Start, Stop, Restart, Up and Down. The row expands or collapses on each click.

- **Start, Stop, Restart:** one `docker compose` command for the whole project, run in the panel the same way
  container actions are (over ssh on an SSH host). Start is enabled while a container of the project is not
  running, Stop and Restart while one is running. A command that has not finished after 55 seconds is stopped (on a
  Mac SSH host, which has no `timeout` command, the 60 s ssh limit applies instead). A command cut off after it may
  have reached Docker shows "Result unknown". After each command the panel reads the host again.
- **Down:** asks for confirmation, then runs `docker compose down`, which stops and removes the project's containers
  and networks. It never removes volumes or images (no `-v`, `--volumes` or `--rmi`).
- **Up:** runs `docker compose … up -d` in an Orca terminal on that host, the same way Pull does, because it may pull
  images or build for a long time. On an SSH host it needs what Pull needs: a workspace on that host in Orca, and
  Orca's own connection to that host.
- **Which files:** when you press a button, the worker reads the labels Compose put on one of the project's
  containers: the project directory (`com.docker.compose.project.working_dir`) and the Compose files
  (`com.docker.compose.project.config_files`). It then runs
  `docker compose --project-directory <dir> -p <project> -f <file>… <command>`, so the files must still be at those
  paths on that host. Other options the project was started with, such as `--profile` or `--env-file`, are not passed.
- If a press fails right after Up, it is because Up recreated the containers: refresh, then press again.
- A project with no containers left (after Down, for example) is not listed, so the panel cannot bring it up again:
  run `docker compose up -d` in its directory.

## Requirements

- Orca 1.4.255 or newer, on macOS or Linux. On Linux the panel calls the local host "This computer" where this
  README says "this Mac", and the plugin runs Orca's CLI as `orca-ide` (or `ORCA_CLI_COMMAND` when Orca sets it),
  never a bare `orca`, which on Linux is usually the GNOME screen reader.
- `docker` installed on this Mac, and on each SSH host you want to use
- Compose features need Docker Compose v2 (`docker compose`) on that host
- SSH hosts running Linux or macOS, added through Orca's own SSH host feature. On a Mac host, Docker Desktop must
  be running there (it starts its daemon only in a logged-in session).
- For each SSH host, a `Host` entry in `~/.ssh/config` on this Mac with exactly the Orca host name, that
  logs in with a key and no prompt (for example a key held by ssh-agent). To check, run
  `ssh -o BatchMode=yes <host name> true` in a terminal on this Mac: it must finish without an error.
  The host name must be made of ASCII letters, digits, `.`, `_` and `-`, and start with a letter or digit; other
  names cannot be used with ssh.
- Listing, actions (deleting and Compose actions included) and the logs in the panel need only that ssh login. Shell,
  **Open in terminal**, Pull and Compose Up on an SSH host also need a workspace on that host in Orca, and Orca's own
  connection to that host.

## Install

In Orca, open **Settings → Plugins**, choose **Add plugin → From a Git URL…**, paste the repository
URL with a version tag and install:

```text
https://github.com/choihjin/orca-containers#v0.5.0
```

Or from a terminal: `orca plugin install choihjin/orca-containers@v0.5.0` (on Linux, `orca-ide plugin install …`).

Orca shows what the plugin asks for before it runs anything. Review it, then enable it.

## How it works

- **This Mac:** the plugin's worker runs the `docker` command directly.
- **Finding `docker` on this Mac:** if `docker` is not in `/usr/local/bin`, `/opt/homebrew/bin`, `/usr/bin` or
  `/snap/bin`, the worker runs `<shell> -lc 'command -v docker'`. The shell is your `$SHELL` when it is sh, bash,
  zsh, dash or ksh, else `/bin/zsh`, else `/bin/sh`, and that shell's login startup files run (for zsh
  `~/.zshenv`, `~/.zprofile`, `~/.zlogin`; for bash the first of `~/.bash_profile`, `~/.bash_login`, `~/.profile`; for
  sh `/etc/profile` and `~/.profile`). A path it finds is
  reused, and while none is found this repeats on each refresh.
- **SSH hosts:** listing, actions (deleting and Compose Start, Stop, Restart and Down included) and the logs in the
  panel run `ssh <host name>`
  from this Mac, with the Orca host name as the ssh destination, and send a fixed script to `sh` on that
  host. They open no terminal and need only ssh: whether Orca can reach the host or has a workspace there
  does not matter.
  ssh runs with `BatchMode=yes`, so it never asks for a password or passphrase: a host it cannot
  log in to without a prompt shows "SSH connection failed" with what to fix. An ssh run that has not
  finished after 60 seconds is stopped.
- **Terminals on SSH hosts:** only Shell, **Open in terminal**, Pull and Compose Up open a terminal. They use Orca's own
  command-line tool (`orca … --environment <host>`) to open an Orca terminal in a workspace on that host, so
  they need a workspace on that host in Orca and Orca's own connection to it. Without them the panel says
  "Host unreachable" (Orca cannot reach the host) or "No workspace on this host".

## What it asks for

| Access | Why |
| --- | --- |
| Runs its own code in a separate Node.js process with your user account's access to this machine (`trusted-worker`) | The worker has to run `docker`, `ssh` and the Orca command-line tool |
| `workspace:read` | Read the focused workspace and the list of workspaces on this Mac, and hear when the focused workspace changes (for Follow focused workspace) |
| `terminal:send` | Open the live logs (Open in terminal), Shell, Pull and Compose Up terminals in a workspace on this Mac and run the fixed docker command there |
| `storage:own` | Store data in the plugin's own storage folder |
| `settings:own` | Read and change the plugin's own settings |

Running `docker`, `ssh` and the Orca command-line tool from the worker does not appear separately in Orca's
approval list. It falls under the `trusted-worker` access above. Terminals on SSH hosts (Shell, Open in
terminal, Pull and Compose Up) go through the Orca command-line tool.

## Limitations

- Each SSH request opens a new ssh connection, so SSH hosts answer more slowly than this Mac.
- An answer from an SSH host larger than 64 MiB is not shown; the panel says "List too long".
- The log view cuts a line after 500 characters and shows only the newest lines that fit in 15,000
  characters. Open in terminal shows them whole.
- Orca types a terminal's command into whatever the host's login shell starts, so a tmux, screen or byobu
  session there could receive it. Before Shell, Open in terminal, Pull or Compose Up opens a terminal on an SSH
  host, the plugin reads the login files in your home folder on that host (`.bashrc`, `.bash_profile`,
  `.bash_login`, `.profile`, `.zshrc`, `.zprofile`, `.zlogin`, `.zshenv`, `.config/fish/config.fish`) without
  running them. If a line names tmux, screen or byobu, nothing opens and the panel shows a warning with those
  files; **Open anyway** opens the terminal as asked. This Mac is not checked. The check is a guess from the file
  text, so it can miss a host or warn about one wrongly:
  - Text after `#` is ignored as a comment, so a `#` inside quotes hides the rest of that line.
  - A line that only mentions tmux is flagged too, for example oh-my-zsh's `plugins=(... tmux)` line, even when
    its autostart is off.
  - Files sourced from other places and the files in /etc are not read.
  - If reading the files fails (an ssh error or timeout), nothing is blocked; the terminal opens as before.
- Orca on Linux was tested with unit tests only, not on a real Linux desktop.
- Relative times ("3 minutes ago") are drawn by Orca in Orca's own UI language, whatever the Language setting says.
- The worker runs `docker` with its own environment: a `DOCKER_HOST` set only in your shell startup files
  (rootless Docker, colima) is not seen, so the panel may say Docker is not running while a terminal works.
- macOS SSH hosts were tested with a simulated Mac shell, not on a real remote Mac. On a Mac host, docker is
  looked up in PATH, then in /usr/local/bin, /opt/homebrew/bin and Docker Desktop's app bundle; a docker
  installed elsewhere is not found. A Mac host has no `timeout` command, so one stuck docker command waits for
  the 60 s ssh limit instead of 20 s (55 s for a Compose command).

## Not supported yet

- **Orca on Windows.** Not built yet, because it needs a Windows machine to verify. Orca's CLI there is
  `orca.cmd`, which Node cannot start without a shell. The Shell command's quoting also differs between cmd,
  PowerShell and WSL. Getting either wrong could let a value become a second command, so this waits until it can
  be tested.
- **Orca older than 1.4.255.** The panel and settings APIs it uses exist from Orca 1.4.246. The exact versions of
  the panel components and Orca CLI behaviours it relies on are not documented, and no older Orca was available
  to test. So the requirement stays at 1.4.255.

## Development

```sh
pnpm install
pnpm test        # orca plugin test .
pnpm typecheck   # writes Orca's typings, then tsc
orca plugin validate .
```

On Linux, use `orca-ide` where these commands say `orca`.

The icon, cover and screenshots are HTML pages in `assets/src`. `assets/src/render.sh shots` captures the
panel from the check scenarios (Orca's window must be hidden or minimized), and `assets/src/render.sh images`
renders the PNGs with headless Chrome.

## License

[MIT](LICENSE).

This project is not affiliated with, endorsed by, or sponsored by Docker, Inc. Docker is a trademark of Docker, Inc.; the name is used only to describe compatibility.
