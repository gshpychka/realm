#!/usr/bin/env bash
# Pushes kodi-customize to the kodi box and runs it. Run from eve:
#   scripts/kodi/deploy.sh [host]
# A running Kodi takes the settings at once; the subtitle position per display
# mode, the Skin Shortcuts pin and the pinned add-ons land at the next boot.
set -euo pipefail

HOST=${1:-kodi}
HERE=$(cd "$(dirname "$0")" && pwd)
REMOTE=/storage/.config/kodi-customize
UNITS=(kodi-customize.service kodi-customize.path)
# InfoTagger 0.0.9, a release Kodi's repository lacks.
INFOTAGGER_REPO=https://github.com/jurialmunkey/script.module.infotagger
INFOTAGGER_COMMIT=c6272475996215648d19fd030dd12b3cadc1bd23

STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT
# A fetch by commit id checks the content against the pin.
git -C "$STAGE" init -q repo
git -C "$STAGE/repo" fetch -q --depth 1 "$INFOTAGGER_REPO" "$INFOTAGGER_COMMIT"
mkdir "$STAGE/addons"
git -C "$STAGE/repo" archive --prefix=script.module.infotagger/ FETCH_HEAD addon.xml icon.png resources |
  tar -C "$STAGE/addons" -xf -

tar -cf - -C "$HERE" kodi-customize.sh kodi-settings-rpc.py kodi-hdr10plus.py kodi-reload-skin.py skin-overrides snippets -C "$STAGE" addons |
  ssh "$HOST" "rm -rf $REMOTE && mkdir $REMOTE && tar -C $REMOTE -xf -"
for unit in "${UNITS[@]}"; do
  ssh "$HOST" "cat > /storage/.config/system.d/$unit" <"$HERE/$unit"
done
ssh "$HOST" "systemctl daemon-reload &&
  systemctl enable ${UNITS[*]} &&
  systemctl start kodi-customize.path &&
  systemctl start kodi-customize.service &&
  journalctl -t kodi-customize --no-pager -n 5"
