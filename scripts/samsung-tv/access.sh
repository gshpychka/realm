#!/usr/bin/env bash
# Run a bounded root command on the Samsung TV from a controller on its LAN.
# Usage: scripts/samsung-tv/access.sh TV_ADDRESS [tv-access options] [command]
# Example: scripts/samsung-tv/access.sh 192.168.1.215 'id -u'
#
# Enable Developer Mode in Apps > App Settings (enter 12345 with the on-screen
# keypad), allow hoard's LAN IP 192.168.1.3, then restart the TV. The address is
# explicit because the TV currently uses a different MAC from its DHCP reservation.
# Root verified on QE65S95CAUXUA, Tizen 9.0.0, firmware
# T-PTMCDEUC-0090-REL-202603190158 (TV menu: 2220.4), on 2026-11-15.
# Each invocation acquires root and cleans up its temporary job. No persistent
# TV service is installed. Firmware updates can remove access; root does not
# bypass every SMACK/UEP restriction. App cleanup is unsupported on this build.
# Vetro uses Host PC IP 127.0.0.1 for autonomous root. While that is set, this
# direct SDB wrapper cannot connect; restore hoard's IP and restart to use it.
set -euo pipefail

if [ "$#" -eq 0 ]; then
  printf 'Usage: %s TV_ADDRESS [tv-access options] [command]\n' "$0" >&2
  exit 2
fi

TV_ADDRESS=$1
shift
CONTROLLER=${TV_CONTROLLER:-hoard}
TOOLS=github:invaliddayta/samsung-tv-tools/abb8e15da3fcdf8d27f7745842522545f7e43208#tv-access

# Quote each argument for the controller's shell, including the root command.
# Build locally: reaper's availability must not gate access to the TV.
printf -v remote_command '%q ' nix run --option builders '' "$TOOLS" -- --tv "$TV_ADDRESS" "$@"
exec ssh -o BatchMode=yes -o ConnectTimeout=10 "$CONTROLLER" "$remote_command"
