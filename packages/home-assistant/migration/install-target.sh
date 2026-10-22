#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: install-target.sh --target-disk DEVICE --target-identity serial:VALUE|wwn:VALUE
       (--preserve-disk DEVICE | --preserve-identity INVENTORY.json)
       --system NIXOS_SYSTEM [--mount DIRECTORY] [--execute]

Inspect and print the installation plan by default. --execute erases only the
identified candidate disk and installs the already-built ARM64 system. Run it
from the separate Pi installer. The original HAOS disk is never written.
The candidate remains mounted for the separate state-restore step.
USAGE
}
die() {
  printf 'install-target: %s\n' "$*" >&2
  exit 1
}
target_arg=''
target_identity=''
preserve_arg=''
preserve_inventory=''
system_arg=''
mountpoint=/mnt/ha-candidate
execute=false
while (($#)); do
  case "$1" in
  --target-disk | --target-identity | --preserve-disk | --preserve-identity | --system | --mount)
    (($# >= 2)) || die "$1 requires a value"
    case "$1" in
    --target-disk) target_arg=$2 ;;
    --target-identity) target_identity=$2 ;;
    --preserve-disk) preserve_arg=$2 ;;
    --preserve-identity) preserve_inventory=$2 ;;
    --system) system_arg=$2 ;;
    --mount) mountpoint=$2 ;;
    esac
    shift 2
    ;;
  --execute)
    execute=true
    shift
    ;;
  --help | -h)
    usage
    exit 0
    ;;
  *) die "unknown argument: $1" ;;
  esac
done
[[ -n $target_arg && -n $target_identity && -n $system_arg ]] || {
  usage >&2
  exit 2
}
[[ -n $preserve_arg && -z $preserve_inventory || -z $preserve_arg && -n $preserve_inventory ]] || die 'provide exactly one original-media identity source'
for command in readlink realpath lsblk jq stat find nix-store; do
  command -v "$command" >/dev/null || die "required command is unavailable: $command"
done

disk_info() {
  lsblk --bytes --json --nodeps --output PATH,TYPE,MAJ:MIN,SIZE,MODEL,SERIAL,WWN,TRAN,RO "$1" |
    jq -ce --arg expected "$1" '.blockdevices | select(length == 1) | .[0] | select(.type == "disk" and .path == $expected)'
}
target=$(readlink -e -- "$target_arg") || die 'target disk does not exist'
[[ $target == /dev/* ]] || die 'target must resolve to a whole block device under /dev'
target_info=$(disk_info "$target") || die 'target is not an independently identifiable whole disk'
target_serial=$(jq -r '.serial // empty' <<<"$target_info")
target_wwn=$(jq -r '.wwn // empty' <<<"$target_info")
[[ -n $target_serial || -n $target_wwn ]] || die 'target exposes neither SERIAL nor WWN; attach it directly or use an adapter that forwards the drive identifier, then inspect lsblk -d -o PATH,MODEL,SERIAL,WWN'
case "$target_identity" in
serial:*) [[ -n ${target_identity#serial:} && ${target_identity#serial:} == "$target_serial" ]] || die 'target SERIAL differs from the explicitly selected candidate' ;;
wwn:*) [[ -n ${target_identity#wwn:} && ${target_identity#wwn:} == "$target_wwn" ]] || die 'target WWN differs from the explicitly selected candidate' ;;
*) die 'target identity must be serial:VALUE or wwn:VALUE copied from the candidate inventory' ;;
esac

if [[ -n $preserve_arg ]]; then
  preserved_disk=$(readlink -e -- "$preserve_arg") || die 'original disk does not exist'
  preserved_info=$(disk_info "$preserved_disk") || die 'original must identify a whole disk'
  [[ $(jq -r '."maj:min"' <<<"$preserved_info") != "$(jq -r '."maj:min"' <<<"$target_info")" ]] || die 'target and original refer to the same block device'
  protected=$(jq -c '[{path, serial, wwn, model, size_bytes: .size, maj_min: ."maj:min"}]' <<<"$preserved_info")
else
  [[ -f $preserve_inventory && ! -L $preserve_inventory ]] || die 'original-media inventory must be a regular protected capture file'
  exec {inventory_fd}<"$preserve_inventory"
  inventory_stat=/proc/$$/fd/$inventory_fd
  [[ $(stat -Lc '%u' "$inventory_stat") == 0 ]] || die 'original-media inventory must be root-owned; copy the verified capture into a root-owned private directory'
  inventory_mode=$(stat -Lc '%a' "$inventory_stat")
  (((8#$inventory_mode & 077) == 0)) || die 'original-media inventory must deny group/other access (chmod 600)'
  protected=$(jq -ce '
    select(.schema_version == 1) |
    ([.disk] + (.protected_disks // [])) |
    select(length > 0 and all(.[]; type == "object" and
      ((.serial == null) or (.serial | type == "string")) and
      ((.wwn == null) or (.wwn | type == "string")))) |
    map({path, serial, wwn, model, size_bytes, maj_min})
  ' <&"$inventory_fd") || die 'original-media inventory has an unsupported schema'
  exec {inventory_fd}<&-
fi
while IFS= read -r original; do
  old_serial=$(jq -r '.serial // empty' <<<"$original")
  old_wwn=$(jq -r '.wwn // empty' <<<"$original")
  [[ -n $old_serial || -n $old_wwn ]] || die 'original media lacks a stable SERIAL/WWN; capture its identity through a direct connection or a transparent adapter'
  if [[ -n $old_serial && $old_serial == "$target_serial" || -n $old_wwn && $old_wwn == "$target_wwn" ]]; then
    die 'candidate identity matches protected original media; original media may never be an installation target'
  fi
  [[ -n $old_serial && -n $target_serial || -n $old_wwn && -n $target_wwn ]] || die 'candidate and original lack a common SERIAL/WWN field; reconnect through adapters exposing the same drive identifier type'
done < <(jq -c '.[]' <<<"$protected")

size_bytes=$(jq -r '.size' <<<"$target_info")
[[ $size_bytes =~ ^[0-9]+$ ]] || die 'target capacity is unavailable'
((size_bytes >= 16 * 1024 * 1024 * 1024)) || die 'candidate must have at least 16 GiB; size it for the captured state plus the complete Nix closure'
((size_bytes < 2 * 1024 * 1024 * 1024 * 1024)) || die 'this Pi installer uses the pinned image DOS layout; select a candidate smaller than 2 TiB'
[[ $(jq -r '.ro' <<<"$target_info") == false ]] || die 'candidate is read-only'
target_mounts=$(lsblk --noheadings --raw --output MOUNTPOINTS "$target") || die 'cannot inspect candidate mount/swap usage'
if [[ $target_mounts =~ [^[:space:]] ]]; then
  die 'candidate or a descendant is mounted or used as swap; unmount/disable its uses before installation'
fi
target_types=$(lsblk --noheadings --raw --output TYPE "$target") || die 'cannot inspect candidate device holders'
while IFS= read -r child_type; do
  [[ $child_type == disk || $child_type == part ]] || die 'candidate has an active device-mapper/RAID holder; remove only the candidate mapping before installation'
done <<<"$target_types"
system=$(readlink -e -- "$system_arg") || die 'built system path does not exist'
[[ -r $system/system && -x $system/bin/switch-to-configuration ]] || die 'system is not a complete NixOS toplevel'
[[ $(cat "$system/system") == aarch64-linux ]] || die 'system must be the built aarch64-linux Home Assistant closure'
[[ ${system##*/} == *nixos-system-homeassistant-* ]] || die 'system must identify the Home Assistant host'
nix-store --verify-path "$system" >/dev/null || die 'system is not a valid immutable store path'
nix-store --query --requisites "$system" >/dev/null || die 'system closure is incomplete; copy its complete closure to the installer first'
[[ $mountpoint == /mnt/* && $mountpoint != /mnt/ && $mountpoint != *'/../'* && $mountpoint != */.. ]] || die 'candidate mount must be a dedicated directory under /mnt'
[[ $(realpath --canonicalize-missing "$mountpoint") == "$mountpoint" ]] || die 'candidate mountpoint must have no symlink or relative-path ancestors'
[[ ! -L $mountpoint ]] || die 'candidate mountpoint may not be a symlink'
if [[ -e $mountpoint ]]; then
  [[ -d $mountpoint && -z $(find "$mountpoint" -mindepth 1 -maxdepth 1 -print -quit) ]] || die 'candidate mount directory must be empty'
fi

partition_path() {
  if [[ $target =~ [0-9]$ ]]; then printf '%sp%s' "$target" "$1"; else printf '%s%s' "$target" "$1"; fi
}
firmware_partition=$(partition_path 1)
root_partition=$(partition_path 2)
printf 'Candidate: %s\n' "$target_info"
printf 'Protected original media: %s\n' "$protected"
printf 'System: %s\nMount: %s\n' "$system" "$mountpoint"
run() {
  printf '  '
  printf '%q ' "$@"
  printf '\n'
  if $execute; then "$@"; fi
}
if $execute; then
  [[ $(id -u) == 0 ]] || die '--execute requires root in the separate Pi installer'
  [[ $(uname -m) == aarch64 ]] || die '--execute must run in the ARM64 Pi installer'
  for command in wipefs parted partprobe udevadm mkfs.vfat mkfs.ext4 mount umount nixos-install sync; do
    command -v "$command" >/dev/null || die "required installer command is unavailable: $command"
  done
fi
root_mounted=false
firmware_mounted=false
cleanup_failure() {
  status=$?
  if ((status != 0)); then
    if $firmware_mounted; then umount "$mountpoint/boot/firmware" || true; fi
    if $root_mounted; then umount "$mountpoint" || true; fi
  fi
}
trap cleanup_failure EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP
# Match the built pinned Pi image: 8 MiB gap, 1024 MiB FAT32, bootable ext4.
run wipefs --all --force "$target"
run parted --script --align optimal "$target" mklabel msdos mkpart primary fat32 8MiB 1032MiB set 1 lba off mkpart primary ext4 1032MiB 100% set 2 boot on
run partprobe "$target"
run udevadm settle
if $execute; then
  for partition in "$firmware_partition" "$root_partition"; do
    parent=$(lsblk --noheadings --raw --nodeps --output PKNAME "$partition") || die 'candidate partition device is unavailable'
    [[ $parent == "${target##*/}" ]] || die 'partition device does not belong to the selected candidate'
  done
fi
run mkfs.vfat -F 32 -n HA_FIRMWARE "$firmware_partition"
run mkfs.ext4 -F -L HA_NIXOS "$root_partition"
run mkdir -p "$mountpoint"
run mount "$root_partition" "$mountpoint"
if $execute; then root_mounted=true; fi
run mkdir -p "$mountpoint/boot/firmware"
run mount -o umask=0077 "$firmware_partition" "$mountpoint/boot/firmware"
if $execute; then firmware_mounted=true; fi
run nixos-install --root "$mountpoint" --system "$system" --no-root-passwd --no-channel-copy
if $execute; then
  [[ -s $mountpoint/boot/firmware/config.txt ]] || die 'Pi firmware config.txt was not generated'
  [[ $(cat "$mountpoint/nix/var/nix/profiles/system/system") == aarch64-linux ]] || die 'installed system profile does not identify ARM64'
fi
run sync
if $execute; then
  printf 'Candidate installed and mounted. Restore captured state and credentials before its first boot.\n'
else
  printf 'Inspection only; no disk writes occurred. Re-run the exact command with --execute after reviewing the candidate identity.\n'
fi
