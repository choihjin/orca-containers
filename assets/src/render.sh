#!/bin/bash
# Renders the plugin page images from the HTML sources in this folder.
#   assets/src/render.sh shots   # panel PNGs from the check scenarios (Orca's window must be hidden or minimized)
#   assets/src/render.sh images  # icon, cover and screenshots with headless Chrome
set -euo pipefail
cd "$(dirname "$0")/../.."
SRC=assets/src
CHROME="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
PROFILE="$(mktemp -d)"
trap 'rm -rf "$PROFILE"' EXIT

shoot() { # name scenario height
  for theme in light dark; do
    orca plugin shot . --scenario "$2" --theme "$theme" --width 400 --height "$3" --out "$SRC/shots/$1-$theme.png" --json >/dev/null
  done
}

render() { # html-with-query out width height
  "$CHROME" --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=1 \
    --default-background-color=00000000 --user-data-dir="$PROFILE" --allow-file-access-from-files \
    --virtual-time-budget=3000 --window-size="$3,$4" --screenshot="$2" "file://$PWD/$SRC/$1" >/dev/null 2>&1
}

case "${1:-}" in
  shots)
    mkdir -p "$SRC/shots"
    shoot ssh ssh 760
    shoot resources resources 760
    shoot sshFailed sshFailed 520
    shoot daemonDown daemonDown 520
    ;;
  images)
    mkdir -p assets/screenshots
    render icon.html assets/icon.png 512 512
    render cover.html assets/cover.png 1600 1000
    for theme in light dark; do
      render "frame.html?slide=ssh&shot=ssh&theme=$theme" "assets/screenshots/ssh-$theme.png" 1600 1000
      render "frame.html?slide=resources&shot=resources&theme=$theme" "assets/screenshots/resources-$theme.png" 1600 1000
      render "frame.html?slide=problems&shot=sshFailed,daemonDown&theme=$theme" "assets/screenshots/problems-$theme.png" 1600 1000
    done
    ;;
  *) echo "usage: $0 shots|images" >&2; exit 2 ;;
esac
