#!/usr/bin/env bash
# Restart only the source state recorded by capture-haos.sh, never candidate NixOS.
set +x
set -euo pipefail
umask 077

die() {
  printf '%s\n' "$*" >&2
  exit 1
}
usage() {
  cat <<'EOF'
recover-haos.sh (--capture DIRECTORY | --remote-journal PATH)
  --host HOST --known-hosts FILE [--apply RECOVER-HAOS-HOST]

Validate the source HAOS recovery plan by default. Apply starts previously active
Bluetooth, recorded containers in reverse capture order, then previously active
Supervisor. Stop the candidate's controllers before restarting the old source.
Only independent host-debug SSH port 22222 is used, with an existing trusted key.

--capture requires a complete capture and its full verified checksum manifest.
--remote-journal accepts only /mnt/data/.ha-migration-capture.XXXXXX retained after
a failed capture/restart. This validates recovery metadata, not a complete backup.
EOF
}
capture='' journal='' host='' known_hosts='' apply=''
while (($#)); do
  case "$1" in
  --capture)
    capture=${2:?}
    shift 2
    ;;
  --remote-journal)
    journal=${2:?}
    shift 2
    ;;
  --host)
    host=${2:?}
    shift 2
    ;;
  --known-hosts)
    known_hosts=${2:?}
    shift 2
    ;;
  --apply)
    apply=${2:?}
    shift 2
    ;;
  --help)
    usage
    exit 0
    ;;
  *) die 'unknown source recovery argument' ;;
  esac
done
[[ $host =~ ^[A-Za-z0-9][A-Za-z0-9_.:-]*$ ]] || die 'a safe explicit source host is required'
[[ -f $known_hosts && -r $known_hosts ]] || die 'a regular trusted known-hosts file is required'
known_hosts_mode=$(stat -Lc %a -- "$known_hosts")
(((8#$known_hosts_mode & 0022) == 0)) || die 'known-hosts must not be writable by group or others'
[[ -z $apply || $apply == "RECOVER-HAOS-$host" ]] || die 'recovery confirmation token does not match the source host'
[[ -n $capture && -z $journal || -z $capture && -n $journal ]] || die 'choose exactly one complete capture or retained remote journal'
mode=inspect
[[ -z $apply ]] || mode=apply
remote="sh -s -- $mode"
if [[ -n $capture ]]; then
  [[ -d $capture ]] || die 'capture directory is unavailable'
  awk '
    {name=$2; sub(/^\.\//, "", name)}
    name !~ /^((config|media|share|ssl|matter|mqtt-addon|tailscale-addon|ssh-addon|mcp-addon|haos-backups|bluetooth)\.tar|running-containers|docker-inspect\.json|host\.txt|storage\.json|mounts\.txt|root-device|data-device|boot-device|data-disk|boot-disk|HA_VERSION|source-paths|supervisor-unit|active-services|CAPTURE_COMPLETE|inventory\.json)$/ {exit 1}
    NF != 2 || seen[name]++ {exit 1}
    END {if (NR != 27) exit 1}
    ' "$capture/SHA256SUMS" || die 'unexpected capture checksum inventory'
  while read -r _hash name; do
    name=${name#./}
    [[ -f $capture/$name && ! -L $capture/$name ]] || die 'capture members must be regular files'
  done <"$capture/SHA256SUMS"
  (cd -- "$capture" && sha256sum --check --strict --status SHA256SUMS) || die 'capture checksums do not match'
  [[ $(cat -- "$capture/CAPTURE_COMPLETE") == haos-cold-capture-v1 ]] || die 'cold capture is incomplete'
  jq -e '.schema_version == 1 and .capture_format == "haos-cold-capture-v1"' "$capture/inventory.json" >/dev/null || die 'unsupported capture inventory'
  awk 'NR==1 && /^(haos|hassos)-supervisor\.service$/ {next} {exit 1} END {if(NR!=1) exit 1}' "$capture/supervisor-unit" || die 'invalid Supervisor recovery metadata'
  awk 'NR==1 && /^supervisor=(true|false)$/ {next} NR==2 && /^bluetooth=(true|false)$/ {next} {exit 1} END {if(NR!=2) exit 1}' "$capture/active-services" || die 'invalid active-service recovery metadata'
  awk '/^[A-Za-z0-9][A-Za-z0-9_.-]*$/ && $0!="hassio_supervisor" && !seen[$0]++ {next} {exit 1}' "$capture/running-containers" || die 'invalid container recovery metadata'
  supervisor=$(cat -- "$capture/supervisor-unit")
  mapfile -t active <"$capture/active-services"
  mapfile -t containers <"$capture/running-containers"
  remote+=" recorded $supervisor ${active[0]#supervisor=} ${active[1]#bluetooth=}"
  for ((index = ${#containers[@]} - 1; index >= 0; index--)); do remote+=" ${containers[index]}"; done
else
  [[ $journal =~ ^/mnt/data/\.ha-migration-capture\.[A-Za-z0-9]{6}$ ]] || die 'remote journal must be the exact retained capture directory'
  remote+=" journal $journal"
fi
ssh_options=(-F /dev/null -o BatchMode=yes -o ConnectTimeout=10 -o StrictHostKeyChecking=yes
  -o "UserKnownHostsFile=$known_hosts" -o ServerAliveInterval=15 -o ServerAliveCountMax=3 -p 22222)
# shellcheck disable=SC2029 # Every remote argument above has a restricted plain-name grammar.
ssh "${ssh_options[@]}" "root@$host" "$remote" <<'REMOTE'
set +x
set -eu
fail() { echo "$*" >&2; exit 1; }
mode=$1 source=$2
shift 2
[ "$(id -u)" = 0 ] || fail 'host root access is required'
grep -q '^ID=haos$\|^ID="haos"$' /etc/os-release || fail 'source is not the HAOS host'
command -v docker >/dev/null || fail 'host Docker is unavailable'
command -v systemctl >/dev/null || fail 'host systemd is unavailable'
[ -d /mnt/data ] || fail 'HAOS persistent data mount is unavailable'
case "$mode" in inspect|apply) ;; *) fail 'invalid recovery mode' ;; esac
case "$source" in
journal)
  journal=$1
  case "$journal" in /mnt/data/.ha-migration-capture.??????) ;; *) fail 'invalid recovery journal path' ;; esac
  [ -d "$journal" ] && [ ! -L "$journal" ] || fail 'retained recovery journal is unavailable'
  [ "$(stat -c %u:%a "$journal")" = 0:700 ] || fail 'retained recovery journal must belong to root with mode 0700'
  for file in supervisor-unit active-services running-containers; do
    [ -f "$journal/$file" ] && [ ! -L "$journal/$file" ] || fail 'retained recovery metadata is unavailable'
  done
  awk 'NR==1 && /^(haos|hassos)-supervisor\.service$/ {next} {exit 1} END {if(NR!=1) exit 1}' "$journal/supervisor-unit" || fail 'invalid Supervisor recovery metadata'
  awk 'NR==1 && /^supervisor=(true|false)$/ {next} NR==2 && /^bluetooth=(true|false)$/ {next} {exit 1} END {if(NR!=2) exit 1}' "$journal/active-services" || fail 'invalid active-service recovery metadata'
  awk '/^[A-Za-z0-9][A-Za-z0-9_.-]*$/ && $0!="hassio_supervisor" && !seen[$0]++ {next} {exit 1}' "$journal/running-containers" || fail 'invalid container recovery metadata'
  supervisor=$(cat "$journal/supervisor-unit")
  supervisor_active=$(sed -n '1s/^supervisor=//p' "$journal/active-services")
  bluetooth_active=$(sed -n '2s/^bluetooth=//p' "$journal/active-services")
  containers=$(awk '{line[NR]=$0} END {for(i=NR;i>0;i--) print line[i]}' "$journal/running-containers")
  # The validated names contain no whitespace or glob metacharacters.
  set -- $containers
  ;;
recorded)
  supervisor=$1 supervisor_active=$2 bluetooth_active=$3
  shift 3
  ;;
*) fail 'invalid recovery metadata source' ;;
esac
case "$supervisor" in haos-supervisor.service|hassos-supervisor.service) ;; *) fail 'invalid Supervisor unit' ;; esac
case "$supervisor_active:$bluetooth_active" in true:true|true:false|false:true|false:false) ;; *) fail 'invalid recorded service state' ;; esac
[ -n "$(systemctl show -p FragmentPath --value "$supervisor")" ] || fail 'recorded Supervisor unit is unavailable'
for name do
  case "$name" in ''|*[!A-Za-z0-9_.-]*|[_.-]*|hassio_supervisor) fail 'invalid recorded container name' ;; esac
  [ "$(docker inspect --format '{{.Name}}' "$name" 2>/dev/null)" = "/$name" ] || fail 'a recorded source container is unavailable'
done
if [ "$mode" = inspect ]; then
  printf 'Validated HAOS recovery plan: %s containers; Bluetooth=%s; Supervisor=%s. No services changed.\n' "$#" "$bluetooth_active" "$supervisor_active"
  exit 0
fi
failed=false
[ "$bluetooth_active" != true ] || systemctl start bluetooth.service >/dev/null 2>&1 || failed=true
for name do docker start "$name" >/dev/null 2>&1 || failed=true; done
[ "$supervisor_active" != true ] || systemctl start "$supervisor" >/dev/null 2>&1 || failed=true
[ "$failed" = false ] || fail 'some recorded HAOS services could not be restarted; recovery metadata was retained'
printf 'Recorded HAOS recovery commands completed.\n'
REMOTE
