#!/usr/bin/env bash
# Cold HAOS capture through the independent host-debug SSH daemon, never an add-on.
set +x
set -euo pipefail
umask 077

die() {
  printf '%s\n' "$*" >&2
  exit 1
}
usage() {
  cat <<'EOF'
capture-haos.sh --host HOST --known-hosts FILE --output DIRECTORY
  --core CONTAINER --matter CONTAINER --mqtt CONTAINER --tailscale CONTAINER
  --ssh-addon CONTAINER --mcp CONTAINER [--port 22222]
  [--apply CAPTURE-HAOS-HOST] [--leave-stopped]

Without --apply, inspect the chosen containers and host without stopping anything.
Copy a verified host key for port 22222 into FILE first. No host keys are accepted
automatically. --leave-stopped is an explicit cutover operation; otherwise every
previously running container/service is restarted after capture, including failure.
The resulting directory contains plaintext credentials. Keep it outside Git/Nix.
EOF
}

host='' known_hosts='' output='' core='' matter='' mqtt='' tailscale='' ssh_addon='' mcp='' apply=''
port=22222
leave_stopped=false
while (($#)); do
  case "$1" in
  --host)
    host=${2:?}
    shift 2
    ;;
  --known-hosts)
    known_hosts=${2:?}
    shift 2
    ;;
  --output)
    output=${2:?}
    shift 2
    ;;
  --port)
    port=${2:?}
    shift 2
    ;;
  --core)
    core=${2:?}
    shift 2
    ;;
  --matter)
    matter=${2:?}
    shift 2
    ;;
  --mqtt)
    mqtt=${2:?}
    shift 2
    ;;
  --tailscale)
    tailscale=${2:?}
    shift 2
    ;;
  --ssh-addon)
    ssh_addon=${2:?}
    shift 2
    ;;
  --mcp)
    mcp=${2:?}
    shift 2
    ;;
  --apply)
    apply=${2:?}
    shift 2
    ;;
  --leave-stopped)
    leave_stopped=true
    shift
    ;;
  --help)
    usage
    exit 0
    ;;
  *) die "unknown capture argument: $1" ;;
  esac
done
[[ $host =~ ^[A-Za-z0-9][A-Za-z0-9_.:-]*$ ]] || die 'a safe explicit source host is required'
[[ $port == 22222 ]] || die 'capture requires HAOS host-debug SSH port 22222; add-on SSH is insufficient'
[[ -r $known_hosts && -n $output ]] || die '--known-hosts and --output are required'
[[ -f $known_hosts ]] || die 'known-hosts must be a regular trusted file'
known_hosts_mode=$(stat -Lc %a -- "$known_hosts")
(((8#$known_hosts_mode & 0022) == 0)) || die 'known-hosts must not be writable by group or others'
declare -A chosen_roles=()
for container in "$core" "$matter" "$mqtt" "$tailscale" "$ssh_addon" "$mcp"; do
  [[ $container =~ ^[A-Za-z0-9][A-Za-z0-9_.-]*$ ]] || die 'all six explicit container roles are required'
  [[ ! -v chosen_roles[$container] ]] || die 'each source container must have exactly one migration role'
  chosen_roles[$container]=1
done
[[ -z $apply || $apply == "CAPTURE-HAOS-$host" ]] || die 'capture confirmation token does not match the source host'
[[ $leave_stopped == false || -n $apply ]] || die '--leave-stopped requires --apply'
[[ ! -e $output ]] || die 'capture output must not already exist'
output=$(realpath -m -- "$output")
case "$output" in /nix/store | /nix/store/*) die 'private captures must stay outside the Nix store' ;; esac
ancestor=$output
while [[ $ancestor != / ]]; do
  if [[ -f $ancestor/.git ]] || [[ -f $ancestor/.git/HEAD ]]; then
    die 'private captures must stay outside every Git checkout'
  fi
  ancestor=$(dirname -- "$ancestor")
done
mkdir -m 0700 -- "$output"
output=$(cd -- "$output" && pwd -P)
ssh_options=(-F /dev/null -o BatchMode=yes -o ConnectTimeout=10 -o StrictHostKeyChecking=yes
  -o "UserKnownHostsFile=$known_hosts" -o ServerAliveInterval=15 -o ServerAliveCountMax=3 -p "$port")
mode=inspect
[[ -z $apply ]] || mode=capture
# All remote arguments are restricted to plain names above; no remote shell input
# is interpolated from config files, provider fields, credentials or inspected paths.
remote="sh -s -- $mode $leave_stopped $core $matter $mqtt $tailscale $ssh_addon $mcp"
partial=$output/capture.tar.partial
# shellcheck disable=SC2029 # Restricted plain names are deliberately remote arguments.
if ! ssh "${ssh_options[@]}" "root@$host" "$remote" >"$partial" <<'REMOTE'
set -eu
set +x
umask 077
fail() { echo "$*" >&2; exit 1; }
mode=$1 leave_stopped=$2 core=$3 matter=$4 mqtt=$5 tailscale=$6 ssh_addon=$7 mcp=$8
[ "$(id -u)" = 0 ] || fail 'host root access is required'
grep -q '^ID=haos$\|^ID="haos"$' /etc/os-release || fail 'source is not the HAOS host'
command -v docker >/dev/null || fail 'host Docker is unavailable'
command -v systemctl >/dev/null || fail 'host systemd is unavailable'
[ -d /mnt/data ] || fail 'HAOS persistent data mount is unavailable'
[ "$(docker inspect --format '{{.Name}}' hassio_supervisor)" = /hassio_supervisor ] || fail 'Supervisor container is unavailable'
supervisor_unit=
for candidate in haos-supervisor.service hassos-supervisor.service; do
  if [ -n "$(systemctl show -p FragmentPath --value "$candidate")" ]; then supervisor_unit=$candidate; break; fi
done
[ -n "$supervisor_unit" ] || fail 'Supervisor host unit is unavailable'
command -v lsblk >/dev/null || fail 'lsblk is required to preserve old disk identities'
command -v findmnt >/dev/null || fail 'findmnt is required to preserve old disk identities'
mount_source() {
  source=$(docker inspect --format "{{range .Mounts}}{{if eq .Destination \"$2\"}}{{println .Source}}{{end}}{{end}}" "$1")
  [ -n "$source" ] && [ -d "$source" ] || fail 'required container mount is unavailable'
  case "$source" in *'
'*) fail 'ambiguous container mount' ;; esac
  (cd "$source" && pwd -P)
}
config=$(mount_source "$core" /config)
media=$(mount_source "$core" /media)
share=$(mount_source "$core" /share)
ssl=$(mount_source "$core" /ssl)
matter_data=$(mount_source "$matter" /data)
mqtt_data=$(mount_source "$mqtt" /data)
tailscale_data=$(mount_source "$tailscale" /data)
ssh_data=$(mount_source "$ssh_addon" /data)
mcp_data=$(mount_source "$mcp" /data)
supervisor_data=$(mount_source hassio_supervisor /data)
backup_data=$supervisor_data/backup
[ -d "$backup_data" ] || fail 'Supervisor backup directory is unavailable'
[ -d /var/lib/bluetooth ] || fail 'host Bluetooth state directory is unavailable'
[ -f "$config/home-assistant_v2.db" ] || fail 'HA recorder database is unavailable'
[ -f "$config/.HA_VERSION" ] || fail 'persistent Core version stamp is unavailable'
find "$backup_data" -maxdepth 1 -type f -name '*.tar' | grep -q . || fail 'create an original HAOS full backup before capture'
for name in "$core" "$matter" "$mqtt" "$tailscale" "$ssh_addon" "$mcp"; do
  docker inspect --format '{{.Name}} {{.Config.Image}} running={{.State.Running}}' "$name" >&2
done
if [ "$mode" = inspect ]; then
  printf 'HAOS host-debug access verified; six role mounts and backup/Bluetooth state exist.\n'
  exit 0
fi
# Stopping the Tailscale add-on must not remove this capture's transport.
set -- ${SSH_CONNECTION:-}
server_address=${3:-}
case "$server_address" in 100.*|fd7a:115c:a1e0:*) fail 'use a direct LAN source address, not Tailscale, for cold capture' ;; esac
[ -n "$server_address" ] || fail 'SSH connection metadata is missing'
stage=$(mktemp -d /mnt/data/.ha-migration-capture.XXXXXX)
running=$stage/running-containers
: > "$running"
supervisor_active=false bluetooth_active=false complete=false
systemctl is-active --quiet "$supervisor_unit" && supervisor_active=true
systemctl is-active --quiet bluetooth.service && bluetooth_active=true
# Supervisor's graceful shutdown may stop other managed add-ons too. Preserve
# their running state, rather than restarting only the six migrated roles.
docker ps --format '{{.Names}}' | awk '$0 != "hassio_supervisor"' > "$running"
recover() {
  status=$?
  trap - EXIT HUP INT TERM
  restart_failed=false
  if [ "$complete" != true ] || [ "$leave_stopped" != true ]; then
    # Restore add-ons/core before Supervisor resumes monitoring them.
    [ "$bluetooth_active" != true ] || systemctl start bluetooth.service >/dev/null 2>&1 || restart_failed=true
    awk '{line[NR]=$0} END {for(i=NR;i>0;i--) print line[i]}' "$running" | while IFS= read -r name; do docker start "$name" >/dev/null 2>&1 || exit 1; done || restart_failed=true
    [ "$supervisor_active" != true ] || systemctl start "$supervisor_unit" >/dev/null 2>&1 || restart_failed=true
  fi
  if [ "$restart_failed" = true ]; then
    echo "Source restart failed; protected recovery journal retained at $stage" >&2
    exit 1
  fi
  rm -rf "$stage"
  exit "$status"
}
trap recover EXIT
trap 'exit 1' HUP INT TERM
# Preserve original images, mounts, labels, environment and restart state as
# private evidence. Docker inspect may contain tokens, so it never goes to logs.
set --
while IFS= read -r container; do
  case "$container" in ''|*[!A-Za-z0-9_.-]*) fail 'invalid container name in complete app inventory' ;; esac
  set -- "$@" "$container"
done <<CONTAINERS
$(docker ps --all --format '{{.Names}}')
CONTAINERS
[ "$#" -gt 0 ] || fail 'complete container inventory is empty'
docker inspect "$@" > "$stage/docker-inspect.json"
{
  uname -m; uname -r; cat /etc/os-release
  if [ -r /proc/device-tree/model ]; then tr '\000' '\n' < /proc/device-tree/model; fi
  if command -v vcgencmd >/dev/null; then vcgencmd bootloader_version || true; vcgencmd bootloader_config || true; fi
} > "$stage/host.txt"
lsblk --json --bytes -o PATH,TYPE,SIZE,MODEL,SERIAL,WWN,MAJ:MIN,MOUNTPOINTS > "$stage/storage.json"
findmnt > "$stage/mounts.txt"
findmnt -n -o SOURCE --target / > "$stage/root-device"
findmnt -n -o SOURCE --target /mnt/data > "$stage/data-device"
findmnt -n -o SOURCE --target /mnt/boot > "$stage/boot-device"
for kind in data boot; do
  device=$(cat "$stage/$kind-device")
  lsblk -s -n -o PATH,TYPE "$device" | awk '$2=="disk" {print $1}' > "$stage/$kind-disk"
  [ "$(wc -l < "$stage/$kind-disk")" = 1 ] || fail 'cannot identify a unique original backing disk'
  disk=$(cat "$stage/$kind-disk")
  serial=$(lsblk -d -n -o SERIAL "$disk" | tr -d '[:space:]')
  wwn=$(lsblk -d -n -o WWN "$disk" | tr -d '[:space:]')
  [ -n "$serial$wwn" ] || fail 'original boot/data disk lacks a stable serial/WWN; no services were stopped'
done
cp "$config/.HA_VERSION" "$stage/HA_VERSION"
printf 'core\t%s\nmedia\t%s\nshare\t%s\nssl\t%s\nmatter\t%s\nmqtt\t%s\ntailscale\t%s\nssh_addon\t%s\nmcp\t%s\nbackups\t%s\nbluetooth\t%s\n' "$config" "$media" "$share" "$ssl" "$matter_data" "$mqtt_data" "$tailscale_data" "$ssh_data" "$mcp_data" "$backup_data" /var/lib/bluetooth > "$stage/source-paths"
printf '%s\n' "$supervisor_unit" > "$stage/supervisor-unit"
printf 'supervisor=%s\nbluetooth=%s\n' "$supervisor_active" "$bluetooth_active" > "$stage/active-services"
# Conservative raw-size headroom includes existing backup archives; no ENOSPC
# halfway through a stopped capture merely because compression was optimistic.
required=0
for source in "$config" "$media" "$share" "$ssl" "$matter_data" "$mqtt_data" "$tailscale_data" "$ssh_data" "$mcp_data" "$backup_data" /var/lib/bluetooth; do
  size=$(du -sk "$source" | awk '{print $1}')
  required=$((required + size))
done
available=$(df -Pk "$stage" | awk 'END {print $4}')
[ "$available" -gt "$((required + required / 5 + 102400))" ] || fail 'insufficient HAOS data-disk space for a protected cold capture'
[ "$supervisor_active" != true ] || systemctl stop "$supervisor_unit"
while IFS= read -r name; do docker stop -t 120 "$name" >/dev/null; done < "$running"
[ "$bluetooth_active" != true ] || systemctl stop bluetooth.service
# Every state archive retains ownership, modes, timestamps and internal symlinks.
tar -C "$config" -cf "$stage/config.tar" .
tar -C "$media" -cf "$stage/media.tar" .
tar -C "$share" -cf "$stage/share.tar" .
tar -C "$ssl" -cf "$stage/ssl.tar" .
tar -C "$matter_data" -cf "$stage/matter.tar" .
tar -C "$mqtt_data" -cf "$stage/mqtt-addon.tar" .
tar -C "$tailscale_data" -cf "$stage/tailscale-addon.tar" .
tar -C "$ssh_data" -cf "$stage/ssh-addon.tar" .
tar -C "$mcp_data" -cf "$stage/mcp-addon.tar" .
tar -C "$backup_data" -cf "$stage/haos-backups.tar" .
tar -C /var/lib/bluetooth -cf "$stage/bluetooth.tar" .
(cd "$stage" && sha256sum ./*.tar > SHA256SUMS)
printf 'haos-cold-capture-v1\n' > "$stage/CAPTURE_COMPLETE"
# Only archive bytes use stdout; all diagnostics stay on stderr.
tar -C "$stage" -cf - .
complete=true
REMOTE
then
  rm -f -- "$partial"
  rmdir -- "$output"
  die 'capture did not complete; source recovery was attempted by the remote trap'
fi
if [[ $mode == inspect ]]; then
  cat -- "$partial"
  rm -f -- "$partial"
  rmdir -- "$output"
  exit 0
fi
# Verify the outer archive before extraction; names are fixed by this script.
while IFS= read -r member; do
  case "$member" in
  ./ | ./running-containers | ./docker-inspect.json | ./host.txt | ./storage.json | ./mounts.txt | ./root-device | ./data-device | ./boot-device | ./data-disk | ./boot-disk | ./HA_VERSION | ./source-paths | ./supervisor-unit | ./active-services | ./config.tar | ./media.tar | ./share.tar | ./ssl.tar | ./matter.tar | ./mqtt-addon.tar | ./tailscale-addon.tar | ./ssh-addon.tar | ./mcp-addon.tar | ./haos-backups.tar | ./bluetooth.tar | ./SHA256SUMS | ./CAPTURE_COMPLETE) ;;
  *) die 'capture returned an unexpected archive member' ;;
  esac
done < <(tar -tf "$partial")
tar -xf "$partial" -C "$output" --no-same-owner
rm -f -- "$partial"
(cd -- "$output" && sha256sum --check --status SHA256SUMS) || die 'captured archive checksum verification failed'
[[ $(cat -- "$output/CAPTURE_COMPLETE") == haos-cold-capture-v1 ]] || die 'capture completion marker is invalid'
jq -n --slurpfile storage "$output/storage.json" \
  --rawfile data_disk "$output/data-disk" --rawfile boot_disk "$output/boot-disk" \
  --rawfile root_device "$output/root-device" --rawfile data_device "$output/data-device" \
  --rawfile boot_device "$output/boot-device" --rawfile version "$output/HA_VERSION" \
  --rawfile sources "$output/source-paths" \
  --argjson leave_stopped "$leave_stopped" \
  --arg core "$core" --arg matter "$matter" --arg mqtt "$mqtt" \
  --arg tailscale "$tailscale" --arg ssh_addon "$ssh_addon" --arg mcp "$mcp" '
  def trim: sub("[\\r\\n]+$"; "");
  def disk($path):
    [$storage[0].blockdevices[] | recurse(.children[]?) | select(.path == ($path|trim) and .type == "disk")][0]
    | if . == null then error("original disk is missing from topology") else
      {path, serial: ((.serial // "")|gsub("^[[:space:]]+|[[:space:]]+$"; "")),
       wwn: ((.wwn // "")|gsub("^[[:space:]]+|[[:space:]]+$"; "")),
       model: (.model // ""), size_bytes: .size, maj_min: ."maj:min"} end;
  {schema_version: 1, capture_format: "haos-cold-capture-v1", ha_version: ($version|trim),
   disk: disk($data_disk), protected_disks: ([disk($data_disk),disk($boot_disk)]|unique_by(.path)),
   source: {root_device: ($root_device|trim), data_device: ($data_device|trim), boot_device: ($boot_device|trim), leave_stopped: $leave_stopped,
     containers: {core:$core,matter:$matter,mqtt:$mqtt,tailscale:$tailscale,ssh_addon:$ssh_addon,mcp:$mcp},
     data_sources: ($sources | split("\n") | map(select(length > 0)|split("\t")|{key:.[0],value:.[1]}) | from_entries)}}
  | if any(.protected_disks[]; .serial == "" and .wwn == "") then error("an original disk lacks a stable serial/WWN identity") else . end
  ' >"$output/inventory.json"
chmod -R go-rwx -- "$output"
(cd -- "$output" && sha256sum -- ./running-containers ./docker-inspect.json ./host.txt \
  ./storage.json ./mounts.txt ./root-device ./data-device ./boot-device ./data-disk \
  ./boot-disk ./HA_VERSION ./source-paths ./supervisor-unit ./active-services \
  ./config.tar ./media.tar ./share.tar ./ssl.tar ./matter.tar ./mqtt-addon.tar ./tailscale-addon.tar ./ssh-addon.tar \
  ./mcp-addon.tar ./haos-backups.tar ./bluetooth.tar ./CAPTURE_COMPLETE ./inventory.json >SHA256SUMS)
printf 'Protected cold capture completed. Source leave-stopped=%s.\n' "$leave_stopped"
