#!/usr/bin/env bash
# Restore private state only into a fresh, mounted, offline NixOS installation.
set +x
set -euo pipefail
umask 077

die() {
  printf '%s\n' "$*" >&2
  exit 1
}
usage() {
  cat <<'EOF'
restore-target.sh --capture DIRECTORY --private DIRECTORY --target-root MOUNTPOINT
  --target-disk DEVICE --expected-serial SERIAL [--expected-wwn WWN]
  [--ssh-host-keys DIRECTORY] [--replace-generated-host-keys]
  [--apply RESTORE-HOME-ASSISTANT]

Validate by default. Apply only to a fresh offline NixOS root on the explicitly
identified candidate disk. The old source disks recorded in inventory.json are
never accepted as candidates. All native controller services remain persistently
masked after restore; a separate explicit cutover step must remove those masks.

Private input files: secrets.yaml, ha-mcp.env, mosquitto-passwords,
restic-repository, restic-password, restic-environment.
By default preserve validated OpenSSH keys from the source SSH add-on. Explicitly
provide --ssh-host-keys for a separately generated and pinned identity instead.
Replacing installer-generated candidate keys requires --replace-generated-host-keys;
their original bytes are retained in the target's protected migration metadata.
EOF
}
capture='' private='' target_root='' target_disk='' expected_serial='' expected_wwn='' apply=''
ssh_host_keys=''
replace_generated_keys=false
while (($#)); do
  case "$1" in
  --capture)
    capture=${2:?}
    shift 2
    ;;
  --private)
    private=${2:?}
    shift 2
    ;;
  --target-root)
    target_root=${2:?}
    shift 2
    ;;
  --target-disk)
    target_disk=${2:?}
    shift 2
    ;;
  --expected-serial)
    expected_serial=${2:?}
    shift 2
    ;;
  --expected-wwn)
    expected_wwn=${2:?}
    shift 2
    ;;
  --apply)
    apply=${2:?}
    shift 2
    ;;
  --ssh-host-keys)
    ssh_host_keys=${2:?}
    shift 2
    ;;
  --replace-generated-host-keys)
    replace_generated_keys=true
    shift
    ;;
  --help)
    usage
    exit 0
    ;;
  *) die "unknown restore argument: $1" ;;
  esac
done
[[ -d $capture && -d $private && -d $target_root && -b $target_disk ]] || die 'capture/private directories, mounted target root and target disk are required'
[[ -n $expected_serial || -n $expected_wwn ]] || die 'an explicit candidate serial or WWN is required'
[[ -z $apply || $apply == RESTORE-HOME-ASSISTANT ]] || die 'incorrect restore confirmation token'
capture=$(realpath -e -- "$capture")
private=$(realpath -e -- "$private")
target_root=$(realpath -e -- "$target_root")
target_disk=$(realpath -e -- "$target_disk")
[[ $target_root != / ]] || die 'refusing the running root filesystem'
[[ $(findmnt -n -o TARGET --mountpoint "$target_root") == "$target_root" ]] || die 'target root must be its own mounted filesystem'
target_device=$(findmnt -n -o SOURCE --mountpoint "$target_root")
lsblk -s -n -o PATH "$target_device" | grep -Fxq -- "$target_disk" || die 'mounted target root is not on the confirmed candidate disk'
[[ $(lsblk -d -n -o TYPE "$target_disk") == disk ]] || die 'candidate must be a whole disk'
serial=$(lsblk -d -n -o SERIAL "$target_disk" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
wwn=$(lsblk -d -n -o WWN "$target_disk" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
[[ -z $expected_serial || $serial == "$expected_serial" ]] || die 'candidate disk serial does not match'
[[ -z $expected_wwn || $wwn == "$expected_wwn" ]] || die 'candidate disk WWN does not match'
[[ -f $capture/inventory.json && ! -L $capture/inventory.json ]] || die 'capture inventory is required'
jq -e --arg serial "$serial" --arg wwn "$wwn" '
  .schema_version == 1 and .capture_format == "haos-cold-capture-v1"
  and (.protected_disks|type == "array" and length > 0)
  and all(.protected_disks[];
    ((.serial // "") != "" or (.wwn // "") != "")
    and ((.serial // "") == "" or .serial != $serial)
    and ((.wwn // "") == "" or .wwn != $wwn))
  ' "$capture/inventory.json" >/dev/null || die 'candidate matches original media, or protected disk inventory is invalid'
[[ $(cat -- "$capture/CAPTURE_COMPLETE") == haos-cold-capture-v1 ]] || die 'cold capture is incomplete'
awk '
  {name=$2; sub(/^\.\//, "", name)}
  name !~ /^((config|media|share|ssl|matter|mqtt-addon|tailscale-addon|ssh-addon|mcp-addon|haos-backups|bluetooth)\.tar|running-containers|docker-inspect\.json|host\.txt|storage\.json|mounts\.txt|root-device|data-device|boot-device|data-disk|boot-disk|HA_VERSION|source-paths|supervisor-unit|active-services|CAPTURE_COMPLETE|inventory\.json)$/ {exit 1}
  seen[name]++ {exit 1}
  END {if (NR != 27) exit 1}
  ' "$capture/SHA256SUMS" || die 'unexpected capture checksum inventory'
(cd -- "$capture" && sha256sum --check --status SHA256SUMS) || die 'capture archive checksums do not match'
for file in secrets.yaml ha-mcp.env mosquitto-passwords restic-repository restic-password restic-environment; do
  [[ -f $private/$file && ! -L $private/$file ]] || die 'all six regular private credential files are required'
  [[ $file == restic-environment || -s $private/$file ]] || die 'a required runtime credential file is empty'
  [[ $(stat -c %a "$private/$file") == 600 || $(stat -c %a "$private/$file") == 400 ]] || die 'private credential files must have mode 0600 or 0400'
done
[[ -f $target_root/etc/passwd ]] || die 'run nixos-install before restoring state so native users exist'
hass_ids=$(awk -F: '$1 == "hass" {print $3 ":" $4}' "$target_root/etc/passwd")
mqtt_ids=$(awk -F: '$1 == "mosquitto" {print $3 ":" $4}' "$target_root/etc/passwd")
[[ $hass_ids =~ ^[0-9]+:[0-9]+$ && $mqtt_ids =~ ^[0-9]+:[0-9]+$ ]] || die 'installed hass/mosquitto user identities are unavailable'
for path in var var/lib etc etc/ssh etc/systemd; do
  [[ ! -L $target_root/$path ]] || die 'candidate state parents must not be symlinks'
done
for path in var/lib/hass var/lib/matter-server var/lib/mosquitto var/lib/tailscale var/lib/bluetooth var/lib/ha-mcp var/lib/private/home-assistant; do
  if [[ -e $target_root/$path || -L $target_root/$path ]]; then
    [[ -d $target_root/$path && ! -L $target_root/$path && -z $(find "$target_root/$path" -mindepth 1 -maxdepth 1 -print -quit) ]] || die 'candidate already has service state; refusing to overwrite it'
  fi
done
python3 - "$capture" "$target_root" <<'PY'
import os
import pathlib
import sys
import tarfile
capture = pathlib.Path(sys.argv[1])
roles = ("config", "matter", "mqtt-addon", "tailscale-addon", "ssh-addon", "mcp-addon", "bluetooth", "media", "share", "ssl")
payload = 0
try:
    for role in roles:
        with tarfile.open(capture / (role + ".tar"), "r:") as archive:
            payload += sum(member.size for member in archive if member.isfile())
except (OSError, tarfile.TarError):
    raise SystemExit("cannot inspect captured state archive sizes")
space = os.statvfs(sys.argv[2])
available = space.f_bavail * space.f_frsize
required = (payload * 6 + 4) // 5 + 1024 ** 3
if available < required:
    raise SystemExit("insufficient candidate free space: staged state requires its full payload plus 20 percent and 1 GiB headroom; no target state changed")
PY
if [[ -z $apply ]]; then
  printf 'Capture, credential permissions and distinct candidate disk validated. No target state changed.\n'
  exit 0
fi
[[ $(id -u) == 0 ]] || die 'apply requires root'
install -d -m 0755 -- "$target_root/var/lib"
stage=$(mktemp -d "$target_root/var/lib/.ha-migration-restore.XXXXXX")
promoted=$stage/promoted
: >"$promoted"
complete=false
cleanup() {
  status=$?
  trap - EXIT HUP INT TERM
  if [[ $complete != true ]]; then
    while IFS= read -r path; do rm -rf -- "${target_root:?}/${path:?}"; done <"$promoted"
    if [[ -d $stage/existing-ssh-host-keys ]]; then
      cp -a -- "$stage/existing-ssh-host-keys/." "$target_root/etc/ssh/"
    fi
    printf 'Restore failed; newly promoted state removed and any created service masks retained.\n' >&2
  fi
  rm -rf -- "$stage"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM
extract() {
  local archive=$1 destination=$2
  # Reject traversal, special files, hardlinks escaping the archive, and files
  # beneath symlink members before GNU tar sees any private source content.
  python3 - "$archive" <<'PY'
import pathlib
import sys
import tarfile
with tarfile.open(sys.argv[1], "r:") as archive:
    members = archive.getmembers()
    symlinks = {pathlib.PurePosixPath(m.name) for m in members if m.issym()}
    for member in members:
        name = pathlib.PurePosixPath(member.name)
        if name.is_absolute() or ".." in name.parts:
            raise SystemExit("archive contains an unsafe member path")
        if not (member.isfile() or member.isdir() or member.issym() or member.islnk()):
            raise SystemExit("archive contains a special file")
        if any(parent in symlinks for parent in name.parents):
            raise SystemExit("archive member traverses a symlink")
        if member.islnk():
            link = pathlib.PurePosixPath(member.linkname)
            if link.is_absolute() or ".." in link.parts:
                raise SystemExit("archive hardlink escapes its root")
PY
  mkdir -m 0700 -- "$destination"
  tar -xf "$archive" -C "$destination" --numeric-owner --same-owner --same-permissions
}
for role in config media share ssl matter mqtt-addon tailscale-addon ssh-addon mcp-addon bluetooth; do
  extract "$capture/$role.tar" "$stage/$role"
done
for mapping in media:media share:haos-share ssl:haos-ssl; do
  source=${mapping%%:*}
  destination=$stage/config/${mapping#*:}
  if [[ -e $destination || -L $destination ]]; then
    [[ -d $destination && ! -L $destination && -z $(find "$destination" -mindepth 1 -maxdepth 1 -print -quit) ]] || die 'captured Core media/share/ssl collides with a config directory; no files were overwritten'
    rmdir -- "$destination"
  fi
  mv -- "$stage/$source" "$destination"
done
python3 - "$stage/matter" <<'PY'
import json
import pathlib
import re
import sys
root = pathlib.Path(sys.argv[1])
def load(path):
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError):
        return None
# Pinned Matter.js uses dotted context/key JSON files. Both credentials and a
# fabric table are essential; a certificates/OTA cache is not controller state.
native = [p for p in root.iterdir() if p.is_dir() and re.fullmatch(r"server(?:-[0-9a-f]+-[0-9a-f]+)?", p.name)]
valid_native = False
for directory in native:
    credentials = load(directory / "credentials.fabric")
    fabrics = load(directory / "fabrics.fabrics")
    if isinstance(credentials, dict) and credentials and isinstance(fabrics, list) and fabrics:
        valid_native = True
chip = load(root / "chip.json")
legacy_nodes = [load(p) for p in root.glob("*.json") if re.fullmatch(r"[0-9]+\.json", p.name)]
valid_legacy = isinstance(chip, dict) and bool(chip) and any(
    isinstance(nodes, dict) and isinstance(nodes.get("nodes"), dict)
    for nodes in legacy_nodes
)
if not (valid_native or valid_legacy):
    raise SystemExit("Matter state is incomplete or unsupported: require native server credentials.fabric plus fabrics.fabrics, or chip.json plus a numeric node-data JSON file; refusing an empty replacement fabric")
PY
unique_parent() {
  local directory=$1 filename=$2
  local -a matches
  mapfile -d '' matches < <(find "$directory" -type f -name "$filename" -print0)
  ((${#matches[@]} == 1)) || die 'expected exactly one persistent database/state file in the captured add-on'
  dirname -- "${matches[0]}"
}
mqtt_state=$(unique_parent "$stage/mqtt-addon" mosquitto.db)
tailscale_state=$(unique_parent "$stage/tailscale-addon" tailscaled.state)
[[ -f $stage/config/home-assistant_v2.db && -d $stage/config/.storage ]] || die 'captured HA config/database is missing'
python3 - "$stage/config" <<'PY'
import pathlib
import sqlite3
import sys
root = pathlib.Path(sys.argv[1])
for name in ("home-assistant_v2.db", "zigbee.db"):
    path = root / name
    if not path.is_file():
        raise SystemExit("required HA SQLite state is missing")
    with sqlite3.connect(path.as_uri() + "?mode=ro", uri=True) as connection:
        if connection.execute("PRAGMA quick_check").fetchone() != ("ok",):
            raise SystemExit("captured HA SQLite state is inconsistent")
PY
mkdir -m 0700 -- "$stage/ssh-host-keys"
key_source=$stage/ssh-addon
if [[ -n $ssh_host_keys ]]; then
  [[ -d $ssh_host_keys && ! -L $ssh_host_keys ]] || die 'explicit SSH host key directory is unavailable'
  key_source=$ssh_host_keys
fi
key_count=0
while IFS= read -r -d '' key; do
  name=$(basename -- "$key")
  [[ $name =~ ^ssh_host_(ed25519|ecdsa|rsa)_key$ ]] || continue
  [[ ! -e $stage/ssh-host-keys/$name ]] || die 'duplicate SSH host key identity in add-on state'
  install -m 0600 -- "$key" "$stage/ssh-host-keys/$name"
  ssh-keygen -y -P '' -f "$stage/ssh-host-keys/$name" >"$stage/ssh-host-keys/$name.pub" 2>/dev/null || die 'captured SSH add-on key is not an unencrypted OpenSSH host key'
  key_count=$((key_count + 1))
done < <(find "$key_source" -type f -name 'ssh_host_*_key' -print0)
((key_count > 0)) || die 'no usable SSH add-on OpenSSH host identity; Dropbear host keys are not interchangeable'
for key in "$stage/ssh-host-keys/"*; do
  destination=$target_root/etc/ssh/$(basename -- "$key")
  if [[ -e $destination || -L $destination ]]; then
    [[ $replace_generated_keys == true && -f $destination && ! -L $destination ]] || die 'candidate has SSH host identity; use explicit replacement to preserve and replace generated keys'
    mkdir -p -- "$stage/existing-ssh-host-keys"
    cp -a -- "$destination" "$stage/existing-ssh-host-keys/"
  fi
done
chown -hR "$hass_ids" "$stage/config"
chown -hR "$mqtt_ids" "$mqtt_state"
chown -hR 1000:1000 "$stage/matter"
chown -hR 0:0 "$tailscale_state" "$stage/bluetooth" "$stage/mcp-addon" "$stage/ssh-host-keys"
mkdir -m 0700 -- "$stage/private"
for file in secrets.yaml ha-mcp.env mosquitto-passwords restic-repository restic-password restic-environment; do
  install -m 0600 -o root -g root -- "$private/$file" "$stage/private/$file"
done
install -m 0600 -- "$capture/inventory.json" "$stage/private/migration-source-inventory.json"
install -m 0600 -- "$capture/SHA256SUMS" "$stage/private/migration-source-sha256sums"
if [[ -d $stage/existing-ssh-host-keys ]]; then
  cp -a -- "$stage/existing-ssh-host-keys" "$stage/private/migration-generated-host-keys"
fi
# NixOS manages /etc/systemd/system as an immutable generated symlink. The
# persistent system.control directory has higher systemd load-path precedence:
# https://www.freedesktop.org/software/systemd/man/latest/systemd.unit.html
mask_root=$target_root/etc/systemd/system.control
[[ ! -L $mask_root ]] || die 'systemd control directory must not be a symlink'
install -d -m 0755 -- "$mask_root"
for unit in home-assistant.service ha-mcp.service podman-matter-server.service matter-server.service mosquitto.service tailscaled.service bluetooth.service restic-backups-home-assistant.timer restic-backups-home-assistant.service; do
  if [[ -e $mask_root/$unit || -L $mask_root/$unit ]]; then
    [[ -L $mask_root/$unit && $(readlink -- "$mask_root/$unit") == /dev/null ]] || die 'candidate has a different controller override; refusing to replace it'
  else
    ln -s /dev/null "$mask_root/$unit"
  fi
  printf '/etc/systemd/system.control/%s\n' "$unit" >>"$stage/private/migration-masks"
done
promote() {
  local source=$1 path=$2
  mkdir -p -- "$(dirname -- "$target_root/$path")"
  [[ ! -d $target_root/$path ]] || rmdir -- "$target_root/$path"
  mv -- "$source" "$target_root/$path"
  printf '%s\n' "$path" >>"$promoted"
}
promote "$stage/config" var/lib/hass
promote "$stage/matter" var/lib/matter-server
promote "$mqtt_state" var/lib/mosquitto
promote "$tailscale_state" var/lib/tailscale
promote "$stage/bluetooth" var/lib/bluetooth
promote "$stage/mcp-addon" var/lib/ha-mcp
promote "$stage/private" var/lib/private/home-assistant
for key in "$stage/ssh-host-keys/"*; do
  path=etc/ssh/$(basename -- "$key")
  install -m 0600 -o root -g root -- "$key" "$target_root/$path"
  printf '%s\n' "$path" >>"$promoted"
done
chmod 0700 "$target_root/var/lib/hass" "$target_root/var/lib/private/home-assistant"
printf 'haos-state-restored-v1\n' >"$target_root/var/lib/private/home-assistant/migration-restored"
complete=true
printf 'Native state restored. Controller services and backup timer remain persistently masked for the first boot.\n'
