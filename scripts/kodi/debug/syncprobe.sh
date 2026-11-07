#!/bin/sh
# Performs one playback action over JSON-RPC, then prints the audio sync events
# Kodi logs during the next $WINDOW seconds (10 by default):
#   syncprobe.sh seek SECONDS   relative seek, e.g. 30 or -30
#   syncprobe.sh seek M:SS      seek to a time, e.g. 20:30 or 1:03:41
#   syncprobe.sh pause SECONDS  pause, wait, resume
#   syncprobe.sh open H:M:S     open episode $EPISODE at that resume point
# EPISODE defaults to 5063, Generation Kill S01E02 (H.264, DTS-HD MA).
set -eu

HERE=$(dirname "$(readlink -f "$0")")
LOG=/storage/.kodi/temp/kodi.log
WINDOW=${WINDOW:-10}
EPISODE=${EPISODE:-5063}

rpc() { python3 "$HERE/rpc.py" "$@" >/dev/null; }

# a JSON-RPC time object from M:SS or H:M:S
time_json() {
  echo "$1" | awk -F: '{
    if (NF == 2) { h = 0; m = $1; s = $2 } else { h = $1; m = $2; s = $3 }
    printf "{\"hours\":%d,\"minutes\":%d,\"seconds\":%d}", h, m, s
  }'
}

mark=$(wc -l <"$LOG")
case "$1" in
seek)
  case "$2" in
  *:*) rpc Player.Seek "{\"playerid\":1,\"value\":{\"time\":$(time_json "$2")}}" ;;
  *) rpc Player.Seek "{\"playerid\":1,\"value\":{\"seconds\":$2}}" ;;
  esac
  ;;
pause)
  rpc Player.PlayPause '{"playerid":1,"play":false}'
  sleep "$2"
  rpc Player.PlayPause '{"playerid":1,"play":true}'
  ;;
open)
  rpc Player.Open "{\"item\":{\"episodeid\":$EPISODE},\"options\":{\"resume\":$(time_json "$2")}}"
  ;;
*)
  sed -n '2,8s/^# //p' "$0" >&2
  exit 2
  ;;
esac
sleep "$WINDOW"

tail -n +"$((mark + 1))" "$LOG" | awk '
  /start sync of audio stream|SyncStream - average error|ErrorAdjust|SeekTime - seek ended|GENERAL_RESYNC|OnLostDisplay|display reset event|clock (stops|starts) in/ {
    print substr($0, 12, 12), substr($0, index($0, "<general>:") + 11)
  }
  /large audio sync error/ {
    if (!large++) print substr($0, 12, 12), substr($0, index($0, "<general>:") + 11)
  }
  /below threshold/ { insync = substr($0, 12, 12) }
  /start adjusting|above threshold/ { adjusts++ }
  /ErrorAdjust/ { corrections++ }
  END {
    printf "in sync at %s, %d adjust cycles, %d clock corrections, %d large-error lines\n",
      insync ? insync : "never", adjusts, corrections, large
  }'
