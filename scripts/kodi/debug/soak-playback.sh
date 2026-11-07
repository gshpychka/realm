#!/bin/sh
# Keeps episode $EPISODE (5063 by default) playing for a soak test: every 30 s,
# opens it at 0:05:00 when nothing plays and seeks back there once playback
# passes 1:00:00.
set -eu

HERE=$(dirname "$(readlink -f "$0")")
EPISODE=${EPISODE:-5063}

rpc() { python3 "$HERE/rpc.py" "$@"; }

while true; do
  if [ "$(rpc Player.GetActivePlayers)" = "[]" ]; then
    rpc Player.Open "{\"item\":{\"episodeid\":$EPISODE},\"options\":{\"resume\":{\"hours\":0,\"minutes\":5,\"seconds\":0}}}" >/dev/null
  elif [ "$(rpc Player.GetProperties '{"playerid":1,"properties":["time"]}' | grep -o '"hours": [0-9]*' | grep -o '[0-9]*$')" -ge 1 ]; then
    rpc Player.Seek '{"playerid":1,"value":{"time":{"hours":0,"minutes":5,"seconds":0}}}' >/dev/null
  fi
  sleep 30
done
