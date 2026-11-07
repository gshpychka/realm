#!/bin/sh
# Lists a Bingie widget every 10 s, the add-on script Home runs on each widget
# refresh, for a soak test.
set -eu

HERE=$(dirname "$(readlink -f "$0")")

while true; do
  python3 "$HERE/rpc.py" Files.GetDirectory \
    '{"directory":"plugin://script.bingie.widgets/?action=random&mediatype=media&limit=5","media":"video"}' >/dev/null || true
  sleep 10
done
