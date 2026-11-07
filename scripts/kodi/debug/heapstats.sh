#!/bin/sh
# Prints the memory Kodi's malloc holds in use, per arena (in use/claimed MB),
# in blocks of their own mapping and as RSS; once, or every INTERVAL seconds:
#   heapstats.sh [INTERVAL]
# Each sample attaches gdb, which stops Kodi for a fraction of a second.
set -eu

HERE=$(dirname "$(readlink -f "$0")")
XML=/tmp/kodi-malloc-info.xml

while true; do
  pid=$(pidof kodi.bin)
  gdb -q -batch -x "$HERE/heapstats.gdb" -p "$pid" >/dev/null 2>&1
  # in use per arena is what it claimed minus its free chunks
  stats=$(awk -F'"' '
    /<heap nr=/ { h = $2 }
    /<total type="(rest|fast)"/ && h != "" { free[h] += $6 }
    /<system type="current"/ && h != "" { claimed[h] = $4; h = "" }
    /<total type="mmap"/ { mapped = $6 }
    END {
      for (i in claimed) printf "arena%s=%d/%d ", i, (claimed[i] - free[i]) / 1048576, claimed[i] / 1048576
      printf "mmap=%d", mapped / 1048576
    }' "$XML")
  echo "$(date +%T) $stats rss=$(awk '/VmRSS/ { print int($2 / 1024) }' "/proc/$pid/status")"
  [ $# -gt 0 ] || break
  sleep "$1"
done
