#!/usr/bin/env bash
# Installs customize/ and system.d/ on the kodi box and runs kodi-customize.
# Run from eve:
#   scripts/kodi/deploy.sh [host]
# A running Kodi takes the settings at once; the advanced settings and the
# memory settings load at the next Kodi start, and the subtitle position per
# display mode, the Skin Shortcuts pin and the pinned add-ons land at the next
# boot.
set -euo pipefail

HOST=${1:-kodi}
HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(git -C "$HERE" rev-parse --show-toplevel)
REMOTE=/storage/.config/kodi-customize
UNITS=(kodi-customize.service kodi-customize.path)
# InfoTagger 0.0.9, a release Kodi's repository lacks.
INFOTAGGER_REPO=https://github.com/jurialmunkey/script.module.infotagger
INFOTAGGER_COMMIT=c6272475996215648d19fd030dd12b3cadc1bd23

# The box's authorized_keys, one per line, as my.hosts.kodi.authorizedKeys declares them.
KEYS=$(nix eval --raw "$REPO#nixosConfigurations.reaper.config.my.hosts.kodi.authorizedKeys" \
  --apply 'builtins.concatStringsSep "\n"')

STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT
# A fetch by commit id checks the content against the pin.
git -C "$STAGE" init -q repo
git -C "$STAGE/repo" fetch -q --depth 1 "$INFOTAGGER_REPO" "$INFOTAGGER_COMMIT"
mkdir "$STAGE/addons"
git -C "$STAGE/repo" archive --prefix=script.module.infotagger/ FETCH_HEAD addon.xml icon.png resources |
  tar -C "$STAGE/addons" -xf -

tar -cf - -C "$HERE/customize" . -C "$STAGE" addons |
  ssh "$HOST" "rm -rf $REMOTE && mkdir $REMOTE && tar -C $REMOTE -xf -"
# system.d/ merges into the box's user units
tar -cf - -C "$HERE" system.d | ssh "$HOST" "tar -C /storage/.config -xf -"
printf '%s\n' "$KEYS" | ssh "$HOST" "cat > /storage/.ssh/authorized_keys.new &&
  mv /storage/.ssh/authorized_keys.new /storage/.ssh/authorized_keys"
ssh "$HOST" "systemctl daemon-reload &&
  systemctl enable ${UNITS[*]} &&
  systemctl start kodi-customize.path &&
  systemctl start kodi-customize.service &&
  journalctl -t kodi-customize --no-pager -n 5"
