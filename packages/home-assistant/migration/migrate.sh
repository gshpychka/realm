#!/usr/bin/env bash
# Executable phases of machines/home-assistant/migration.md. Never run with -x.
set +x
set -euo pipefail
umask 077
scripts=${HA_MIGRATION_SCRIPTS:-$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)}
die() {
  printf 'migration: %s\n' "$*" >&2
  exit 1
}
need() { command -v "$1" >/dev/null || die "required executable missing: $1"; }
root() { [[ $(id -u) == 0 ]] || die 'this phase must run as root'; }
private_file() {
  [[ -f $1 && ! -L $1 ]] || die "not a regular private file: $1"
  local mode owner
  mode=$(stat -c %a -- "$1")
  owner=$(stat -c %u -- "$1")
  (((8#$mode & 077) == 0)) || die "remove group/other permissions from $1"
  [[ $owner == "$EUID" || $owner == 0 ]] || die "unexpected owner: $1"
}
private_dir() {
  [[ $1 = /* && $1 != / && ! -L $1 ]] || die 'use an absolute, non-symlink private directory'
  if [[ -e $1 ]]; then
    [[ -d $1 && $(stat -c %a -- "$1") == 700 ]] || die 'existing private directories must already have mode 0700'
  else
    mkdir -p -- "$1" # umask 077 applies to every newly created parent.
  fi
  [[ $(stat -c %u -- "$1") == "$EUID" ]] || die "directory is not owned by current user: $1"
  [[ $(stat -c %a -- "$1") == 700 ]] || die 'private directory must have mode 0700'
}
outside() {
  local output source
  output=$(realpath -m -- "$1")
  source=$(realpath -m -- "$2")
  [[ $output != "$source" && $output != "$source/"* ]] || die 'output must be outside the captured/backed-up source tree'
}
restic_env() {
  # Literal KEY=VALUE only. Never source a credential file as shell code.
  local file=$1 line key value
  private_file "$file"
  while IFS= read -r line || [[ -n $line ]]; do
    [[ -z $line || $line == \#* ]] && continue
    [[ $line =~ ^([A-Z][A-Z0-9_]*)=(.*)$ ]] || die 'restic-environment must contain literal KEY=VALUE lines'
    key=${BASH_REMATCH[1]}
    value=${BASH_REMATCH[2]}
    case $key in
    AWS_* | B2_* | AZURE_* | GOOGLE_* | OS_* | RESTIC_* | RCLONE_*) ;;
    *) die "unsupported backup environment variable: $key" ;;
    esac
    [[ $key != RESTIC_REPOSITORY* && $key != RESTIC_PASSWORD* ]] || die 'use repository/password files, not environment overrides'
    [[ $value != *[[:space:]]* && $value != *\\* && $value != *\"* && $value != *\'* ]] || die 'backup environment values must be literal without whitespace, quotes or backslashes'
    export "$key=$value"
  done <"$file"
}
restic_run() {
  local credentials=$1
  shift
  private_file "$credentials/restic-repository"
  private_file "$credentials/restic-password"
  (
    restic_env "$credentials/restic-environment"
    restic --repository-file "$credentials/restic-repository" --password-file "$credentials/restic-password" "$@"
  )
}
capture_check() {
  local capture=$1 name
  private_file "$capture/SHA256SUMS"
  [[ -f $capture/CAPTURE_COMPLETE && -f $capture/inventory.json ]] || die 'capture is incomplete'
  # Only the capture producer's flat files may appear in its checksum manifest.
  while read -r _ name; do
    name=${name#\*}
    name=${name#./}
    [[ $name =~ ^[A-Za-z0-9._-]+$ ]] || die 'unsafe capture manifest filename'
  done <"$capture/SHA256SUMS"
  (cd -- "$capture" && sha256sum --check --strict SHA256SUMS >/dev/null)
}
native() {
  root
  [[ $(uname -m) == aarch64 && -f /etc/NIXOS && $(hostname -s) == homeassistant ]] || die 'run this phase on the installed aarch64 homeassistant host'
}
lan_transport() {
  local server
  read -r _ _ server _ <<<"${SSH_CONNECTION:-}"
  case $server in
  100.* | fd7a:115c:a1e0:*) die 'use physical console or direct LAN SSH for a phase that stops Tailscale' ;;
  esac
}
usage() {
  cat <<'HELP'
Usage: home-assistant-migrate PHASE ARGUMENTS
  build CHECKOUT WORK                     Build ARM system, installer, QA, tools; save pins
  declarations FILE                      Export public declarations for offline helpers
  flash-sd IMAGE.zst DISK SERIAL PRESERVE_DISK [--execute]
                                         Identity-checked installer SD write (whole disk)
  check-transfer SYSTEM ARM_TOOLS CAPTURE HOST KNOWN_HOSTS
                                         Verify expanded installer space for actual inputs
  capture [ARGS...]                       HAOS host-debug capture; --help for contract
  recover-source [ARGS...]                Restore recorded HAOS services; --help
  unpack CAPTURE OUTPUT                  Verify/extract private config.tar for audit
  preflight SNAPSHOT                     Read-only declared-reference audit
  mqtt-passwords USERS.json OUTPUT        Hash complete [{username,password}] client set
  credentials INPUT_DIR OUTPUT_DIR       Validate and stage all six native runtime files
  prepare-yasno [ARGS...]                 Derive private guard configuration; --help
  collect-yasno [ARGS...]                 Fetch/validate exact official address evidence; --help
  glances-map [ARGS...]                   Match old/new metrics using pinned identities; --help
  restic-init CREDENTIALS --execute       Initialize the explicitly chosen backup repository
  seal CAPTURE CREDENTIALS OUTPUT [PRIVATE_PATH...]
                                         Encrypt all recovery inputs; restore/compare immediately
  install [ARGS...]                       Guarded replacement-disk install; --help
  restore [ARGS...]                       Cold-state staging and masks; --help
  sanitize ROOT OUTBOUND_KEY KNOWN_HOSTS --execute
                                         Preserve/move old code; install explicit SSH identity
  stage-tools ROOT ARM_TOOLS --execute    Retain the migration tool closure on installed root
  reconcile [ARGS...]                     Supported HA integration flows; --help
  pull-matter [--execute]                 Check/cache exact ARM64 Matter OCI image on target
  start-native --execute                 Unmask/start native services, enable backup timer last
  stop-native --execute                  Stop/mask all controllers before physical rollback
  api-snapshot URL TOKEN_FILE OUTPUT      Read config/states/services without exposing token
  cold-audit OUTPUT --execute             Stop, copy, audit, restart target; save complete report
  health OUTPUT                          Target OS/radio/network/unit evidence; no actuation
  cooling-test OUTPUT --execute           Bounded CPU load; stop at 80C or fan failure
  prove-backup OUTPUT                     Run backup unit, restic check, restore, metadata diff
  tool PROGRAM [ARGS...]                  Run a pinned operator tool (see runbook)
Read machines/home-assistant/migration.md in order. No phase reboots automatically.
HELP
}
phase=${1:-help}
[[ $# == 0 ]] || shift
case $phase in
help | --help | -h) usage ;;
build)
  [[ $# == 2 ]] || die 'build CHECKOUT WORK'
  repo=$(realpath -- "$1")
  work=$2
  private_dir "$work"
  [[ -f $repo/flake.lock ]] || die 'checkout does not contain flake.lock'
  [[ -z $(git -C "$repo" status --porcelain) ]] || die 'build a clean committed checkout so the recorded revision is reproducible'
  git -C "$repo" rev-parse HEAD >"$work/revision"
  sha256sum "$repo/flake.lock" >"$work/flake-lock.sha256"
  nix flake check "$repo" --all-systems --no-build --no-write-lock-file
  nix build "$repo#checks.aarch64-linux.home-assistant-config" --no-write-lock-file --out-link "$work/qa-arm"
  nix build "$repo#nixosConfigurations.home-assistant.config.system.build.toplevel" --no-write-lock-file --out-link "$work/system"
  nix build "$repo#packages.aarch64-linux.home-assistant-installer" --no-write-lock-file --out-link "$work/installer"
  nix build "$repo#packages.aarch64-linux.home-assistant-migrate" --no-write-lock-file --out-link "$work/tools-arm"
  nix eval --json "$repo#nixosConfigurations.home-assistant.config" --apply 'c: {
    system = c.nixpkgs.hostPlatform.system;
    coreVersion = c.services.home-assistant.package.version;
    hassUid = c.users.users.hass.uid; hassGid = c.users.groups.hass.gid;
    mqttUid = c.users.users.mosquitto.uid; mqttGid = c.users.groups.mosquitto.gid;
    matterImage = c.virtualisation.oci-containers.containers.matter-server.image;
  }' >"$work/target.json"
  jq -e '.system == "aarch64-linux" and (.hassUid|type)=="number" and (.mqttUid|type)=="number"' "$work/target.json" >/dev/null
  nix path-info --recursive --json "$(readlink -f "$work/system")" "$(readlink -f "$work/tools-arm")" >"$work/closure.json"
  jq -n --arg system "$(readlink -f "$work/system")" --arg tools "$(readlink -f "$work/tools-arm")" '{system:$system,tools:$tools}' >"$work/artifacts.json"
  printf 'Build complete; pinned artifacts and target.json are in %s\n' "$work"
  ;;
declarations)
  [[ $# == 1 && -n ${HA_MIGRATION_DECLARATIONS:-} ]] || die 'use packaged app: declarations OUTPUT_FILE'
  [[ ! -e $1 ]] || die 'output already exists'
  cp -- "$HA_MIGRATION_DECLARATIONS" "$1"
  ;;
flash-sd)
  [[ $# == 4 || ($# == 5 && $5 == --execute) ]] || die 'flash-sd IMAGE.zst DISK SERIAL PRESERVE_DISK [--execute]'
  root
  image=$(realpath -- "$1")
  disk=$(readlink -f -- "$2")
  serial=$3
  preserve=$(readlink -f -- "$4")
  [[ -f $image && -b $disk && -b $preserve && $disk != "$preserve" && -n $serial ]] || die 'image/disk/preserved-disk inputs invalid'
  [[ $(lsblk -dnro TYPE "$disk") == disk && $(lsblk -dnro TYPE "$preserve") == disk ]] || die 'both arguments must be whole physical disks'
  [[ $(lsblk -dnro SERIAL "$disk" | xargs) == "$serial" ]] || die 'installer SD serial mismatch; use a reader exposing a unique serial'
  [[ $(lsblk -dnro SERIAL "$preserve" | xargs) != "$serial" ]] || die 'serial is not unique'
  lsblk --json --nodeps --output TYPE,SERIAL | jq -e --arg serial "$serial" '[.blockdevices[]|select(.type=="disk" and .serial==$serial)]|length==1' >/dev/null || die 'installer SD serial is not unique among connected disks'
  [[ $(lsblk -dnro RO "$disk") == 0 ]] || die 'installer SD is read-only'
  (($(blockdev --getsize64 "$disk") >= 32 * 1024 * 1024 * 1024)) || die 'installer SD requires at least 32 GiB usable capacity; use a 64 GB or larger card'
  while read -r holder_type; do
    [[ $holder_type == disk || $holder_type == part ]] || die 'installer SD has an active device-mapper/RAID holder'
  done <<<"$(lsblk --noheadings --raw --output TYPE "$disk")"
  [[ -z $(lsblk -nrpo MOUNTPOINTS "$disk" | tr -d '[:space:]') ]] || die 'target SD has mounted filesystems; unmount explicitly'
  while read -r swap; do
    [[ -z $swap ]] || ! lsblk -snrpo NAME "$swap" | rg -Fx "$disk" >/dev/null || die 'target SD contains active swap'
  done < <(swapon --show --noheadings --raw --output NAME)
  zstd --test -- "$image"
  bytes=$(zstd --decompress --stdout -- "$image" | wc -c)
  ((bytes > 0 && bytes <= $(blockdev --getsize64 "$disk"))) || die 'decompressed installer does not fit selected SD'
  printf 'Selected installer SD verified. Original media remains separate.\n'
  if [[ $# == 5 ]]; then
    zstd --decompress --stdout -- "$image" | dd of="$disk" bs=4M conv=fsync status=progress
    sync
    # Full readback compares exactly the decompressed image bytes (cmp stops at its EOF).
    zstd --decompress --stdout -- "$image" | cmp --bytes="$bytes" - "$disk"
    printf 'Installer SD written and read back successfully.\n'
  fi
  ;;
check-transfer)
  [[ $# == 5 ]] || die 'check-transfer SYSTEM ARM_TOOLS CAPTURE HOST KNOWN_HOSTS'
  system=$1
  tools=$2
  capture=$(realpath -- "$3")
  host=$4
  known_hosts=$5
  [[ $system == /nix/store/* && $tools == /nix/store/* && $host =~ ^[A-Za-z0-9][A-Za-z0-9_.:-]*$ ]] || die 'explicit store paths and a safe installer LAN host are required'
  capture_check "$capture"
  private_file "$known_hosts"
  closure_bytes=$(nix path-info --recursive --json "$system" "$tools" | jq -er '[.[]|.narSize]|add|select(type=="number" and .>0)')
  capture_bytes=$(du --summarize --bytes "$capture" | cut -f1)
  required=$(((closure_bytes + capture_bytes) * 6 / 5 + 1024 * 1024 * 1024))
  # The remote program is fixed. No captured path/credential becomes shell code.
  available=$(ssh -F /dev/null -o BatchMode=yes -o StrictHostKeyChecking=yes -o "UserKnownHostsFile=$known_hosts" "root@$host" \
    'set -eu; test "$(uname -m)" = aarch64; if systemctl is-failed --quiet expand-root-partition.service; then exit 1; fi; df -B1 --output=avail /nix/store | tail -n1')
  available=$(tr -d '[:space:]' <<<"$available")
  [[ $available =~ ^[0-9]+$ ]] || die 'installer did not report numeric available space'
  ((available >= required)) || die 'installer free space is insufficient for closure+capture+20%+1GiB; inspect expansion service or use a larger SD'
  printf 'Installer capacity verified for measured closures and private capture.\n'
  ;;
capture) exec bash "$scripts/capture-haos.sh" "$@" ;;
recover-source) exec bash "$scripts/recover-haos.sh" "$@" ;;
unpack)
  [[ $# == 2 ]] || die 'unpack CAPTURE OUTPUT'
  capture=$(realpath -- "$1")
  output=$2
  capture_check "$capture"
  outside "$output" "$capture"
  [[ ! -e $output ]] || die 'unpack output must not exist'
  private_dir "$output"
  tar --list --file "$capture/config.tar" >"$output/archive-members.txt"
  ! rg '(^/|(^|/)\.\.(/|$))' "$output/archive-members.txt" >/dev/null || die 'unsafe archive paths'
  mkdir "$output/homeassistant"
  tar --extract --file "$capture/config.tar" --directory "$output/homeassistant" --no-same-owner --delay-directory-restore
  [[ -f $output/homeassistant/.storage/auth ]] || die 'config archive is not a complete HA config directory'
  printf 'Snapshot extracted to %s/homeassistant\n' "$output"
  ;;
preflight)
  [[ $# == 1 && -n ${HA_MIGRATION_PREFLIGHT:-} ]] || die 'use packaged app: preflight SNAPSHOT'
  exec "$HA_MIGRATION_PREFLIGHT" "$1"
  ;;
mqtt-passwords)
  [[ $# == 2 ]] || die 'mqtt-passwords USERS.json OUTPUT'
  private_file "$1"
  [[ ! -e $2 ]] || die 'password output already exists'
  jq -e 'type=="array" and length>0 and (all(.[];
    (.username|type)=="string" and (.username|test("^[A-Za-z0-9_.@-]+$")) and
    (.password|type)=="string" and (.password|length)>0 and
    (.password|test("[\\r\\n\\u0000]")|not))) and
    ([.[].username]|unique|length)==length' "$1" >/dev/null || die 'invalid/duplicate MQTT client credentials'
  output=$(realpath -m -- "$2")
  temporary=$(mktemp "${output}.XXXXXX")
  trap 'rm -f -- "$temporary"' EXIT
  while IFS= read -r row; do
    user=$(jq -r '.username' <<<"$row")
    password=$(jq -r '.password' <<<"$row")
    printf '%s\n%s\n' "$password" "$password" | mosquitto_passwd "$temporary" "$user" >/dev/null
    unset password
  done < <(jq -c '.[]' "$1")
  chmod 600 "$temporary"
  mv -- "$temporary" "$output"
  trap - EXIT
  ;;
credentials)
  [[ $# == 2 ]] || die 'credentials INPUT_DIR OUTPUT_DIR'
  input=$(realpath -- "$1")
  output=$2
  [[ ! -e $output ]] || die 'credential output must not exist'
  for name in secrets.yaml ha-mcp.env mosquitto-passwords restic-repository restic-password restic-environment; do private_file "$input/$name"; done
  yq -o=json '.' "$input/secrets.yaml" | jq -e '
    (.soundbar_api_key|type)=="string" and (.soundbar_api_key|length)>0 and
    (.yasno_address_guard|type)=="object" and
    (.yasno_address_guard | has("entry_id") and has("region_id") and has("provider_id") and has("street_id") and has("house_id") and
      (.bindings|type)=="object" and (.bindings|length)>0 and
      .journal_path=="/var/lib/hass/yasno-address-guard/journal.json" and
      .app_path=="/var/lib/hass/pyscript/apps/yasno_address_guard" and
      (.settings | has("region") and has("provider") and has("scan_interval") and has("filter_probable") and has("status_all_day_events")))' >/dev/null || die 'secrets.yaml missing required native Yasno/soundbar configuration'
  [[ $(wc -l <"$input/ha-mcp.env") == 2 ]] || die 'ha-mcp.env must have exactly two newline-terminated assignments'
  rg '^HOMEASSISTANT_TOKEN=[A-Za-z0-9._-]+$' "$input/ha-mcp.env" >/dev/null || die 'invalid MCP token assignment'
  rg '^MCP_SECRET_PATH=/[A-Za-z0-9_-]{32,}$' "$input/ha-mcp.env" >/dev/null || die 'MCP secret path must contain at least 32 random URL-safe characters'
  [[ -s $input/restic-repository && -s $input/restic-password && -s $input/mosquitto-passwords ]] || die 'empty credential file'
  (restic_env "$input/restic-environment")
  private_dir "$output"
  for name in secrets.yaml ha-mcp.env mosquitto-passwords restic-repository restic-password restic-environment; do install -m600 -- "$input/$name" "$output/$name"; done
  printf 'Native credential bundle validated; values were not printed.\n'
  ;;
prepare-yasno) exec bash "$scripts/prepare-yasno.sh" "$@" ;;
collect-yasno) exec bash "$scripts/collect-yasno.sh" "$@" ;;
glances-map) exec bash "$scripts/glances-map.sh" "$@" ;;
restic-init)
  [[ $# == 2 && $2 == --execute ]] || die 'restic-init CREDENTIALS --execute'
  restic_run "$1" init
  ;;
seal)
  [[ $# -ge 3 ]] || die 'seal CAPTURE CREDENTIALS OUTPUT [PRIVATE_PATH...]'
  capture=$(realpath -- "$1")
  credentials=$(realpath -- "$2")
  output=$3
  shift 3
  capture_check "$capture"
  sources=("$capture" "$credentials")
  for source in "$@"; do
    source=$(realpath -- "$source")
    if [[ -d $source ]]; then private_dir "$source"; else private_file "$source"; fi
    sources+=("$source")
  done
  for source in "${sources[@]}"; do outside "$output" "$source"; done
  [[ ! -e $output ]] || die 'seal output must not exist'
  private_dir "$output"
  # Absolute path recorded so restored location is unambiguous.
  restic_run "$credentials" backup --json --tag haos-pre-nixos -- "${sources[@]}" >"$output/backup.jsonl"
  snapshot=$(jq -rs '[.[]|select(.message_type=="summary")][-1].snapshot_id // empty' "$output/backup.jsonl")
  [[ $snapshot =~ ^[a-f0-9]{64}$ ]] || die 'restic did not report a complete snapshot'
  restic_run "$credentials" check --read-data >"$output/check.log" 2>&1
  restic_run "$credentials" restore "$snapshot" --target "$output/restored" >"$output/restore.log" 2>&1
  : >"$output/differences"
  for source in "${sources[@]}"; do
    if [[ -d $source ]]; then
      rsync -aHAXnci --numeric-ids --delete "$source/" "$output/restored$source/" >>"$output/differences"
    else
      rsync -aHAXnci --numeric-ids "$source" "$output/restored$(dirname "$source")/" >>"$output/differences"
    fi
  done
  [[ ! -s $output/differences ]] || die 'encrypted restore differs from capture; see protected differences file'
  printf '%s\n' "$snapshot" >"$output/snapshot-id"
  printf 'Encrypted recovery copy passed complete data check and restore comparison.\n'
  ;;
install) exec bash "$scripts/install-target.sh" "$@" ;;
restore) exec bash "$scripts/restore-target.sh" "$@" ;;
sanitize)
  [[ $# == 4 && $4 == --execute ]] || die 'sanitize ROOT OUTBOUND_KEY KNOWN_HOSTS --execute'
  root
  target=$(realpath -- "$1")
  key=$(realpath -- "$2")
  hosts=$(realpath -- "$3")
  [[ $target != / && -f $target/var/lib/private/home-assistant/migration-restored ]] || die 'sanitize requires the offline candidate root after restore'
  findmnt --mountpoint "$target" >/dev/null || die 'candidate root is not mounted'
  private_file "$key"
  private_file "$hosts"
  ssh-keygen -y -P '' -f "$key" >/dev/null 2>&1 || die 'outbound key must be an unencrypted SSH private key'
  ssh-keygen -F reaper.glib.sh -f "$hosts" >/dev/null || die 'outbound known_hosts lacks pinned reaper.glib.sh'
  [[ -n ${HA_MIGRATION_COMPONENTS:-} ]] || die 'use the packaged migration app'
  config=$target/var/lib/hass
  preserved=$target/var/lib/private/home-assistant/migration-preserved-sources
  [[ ! -e $preserved ]] || die 'sanitation has already run; inspect preserved-sources and do not repeat blindly'
  [[ ! -L $config/custom_components ]] || die 'copied custom_components root is a symlink; preserve and resolve its complete contents in the capture first'
  for component in "$config"/custom_components/*; do
    [[ -e $component || -L $component ]] || continue
    name=${component##*/}
    [[ $name == __pycache__ ]] && continue
    jq -e --arg name "$name" 'index($name) != null' "$HA_MIGRATION_COMPONENTS" >/dev/null || die "captured custom component is not packaged: $name; see runbook source inventory procedure"
  done
  mkdir -m700 -- "$preserved"
  for path in configuration.yaml secrets.yaml custom_components pyscript/apps/yasno_address_guard; do
    if [[ -e $config/$path || -L $config/$path ]]; then
      mkdir -p -- "$preserved/$(dirname "$path")"
      mv -- "$config/$path" "$preserved/$path"
    fi
  done
  ids=$(awk -F: '$1=="hass" {print $3 ":" $4}' "$target/etc/passwd")
  [[ $ids =~ ^[0-9]+:[0-9]+$ ]] || die 'native hass owner unavailable'
  [[ ! -L $config/.ssh ]] || die 'copied SSH directory may not be a symlink'
  install -d -m700 -o "${ids%:*}" -g "${ids#*:}" "$config/.ssh"
  for name in outbound_key known_hosts; do
    if [[ -e $config/.ssh/$name || -L $config/.ssh/$name ]]; then
      mkdir -p -- "$preserved/ssh"
      mv -- "$config/.ssh/$name" "$preserved/ssh/$name"
    fi
  done
  install -m600 -o "${ids%:*}" -g "${ids#*:}" "$key" "$config/.ssh/outbound_key"
  install -m600 -o "${ids%:*}" -g "${ids#*:}" "$hosts" "$config/.ssh/known_hosts"
  printf 'Old managed sources preserved privately; native code may now be installed by HA preStart.\n'
  ;;
stage-tools)
  [[ $# == 3 && $3 == --execute ]] || die 'stage-tools ROOT ARM_TOOLS --execute'
  root
  target=$(realpath -- "$1")
  tools=$(realpath -- "$2")
  [[ $target != / && -f $target/var/lib/private/home-assistant/migration-restored && -x $tools/bin/home-assistant-migrate ]] || die 'require offline restored root and built migration package'
  findmnt --mountpoint "$target" >/dev/null || die 'candidate root is not mounted'
  # These are our locally built unsigned outputs, authenticated by the recorded
  # checkout and strict SSH transport, not a third-party binary cache signature.
  nix copy --no-check-sigs --to "local?root=$target" "$tools"
  [[ ! -e $target/nix/var/nix/gcroots/ha-migration-tools && ! -L $target/nix/var/nix/gcroots/ha-migration-tools ]] || die 'migration GC root already exists'
  ln -s "$tools" "$target/nix/var/nix/gcroots/ha-migration-tools"
  printf 'Migration tools retained across installed-host reboot and GC.\n'
  ;;
reconcile) exec bash "$scripts/reconcile-ha.sh" "$@" ;;
pull-matter)
  native
  [[ $# == 0 || ($# == 1 && $1 == --execute) ]] || die 'pull-matter [--execute]'
  image=ghcr.io/matter-js/matterjs-server:1.4.0@sha256:54232d0d3e7dff5a54759469d2753399270412b4c30c55b31750a4595e4cb236
  if [[ $# == 1 ]]; then podman pull --arch arm64 "$image"; fi
  [[ $(podman image inspect --format '{{.Architecture}}' "$image") == arm64 ]] || die 'pinned ARM64 image is not cached'
  printf 'Pinned Matter ARM64 image is cached.\n'
  ;;
start-native | stop-native)
  native
  lan_transport
  [[ $# == 1 && $1 == --execute ]] || die "$phase --execute"
  units=(bluetooth.service tailscaled.service mosquitto.service podman-matter-server.service home-assistant.service ha-mcp.service)
  if [[ $phase == stop-native ]]; then
    systemctl stop restic-backups-home-assistant.timer
    # Do not race a running backup's cleanup/restart hook.
    systemctl stop restic-backups-home-assistant.service
    for ((i = ${#units[@]} - 1; i >= 0; i--)); do systemctl stop "${units[i]}"; done
    mkdir -p /etc/systemd/system.control
    for unit in "${units[@]}" matter-server.service restic-backups-home-assistant.timer restic-backups-home-assistant.service; do
      mask=/etc/systemd/system.control/$unit
      [[ ! -e $mask && ! -L $mask || (-L $mask && $(readlink "$mask") == /dev/null) ]] || die "unexpected existing unit override: $mask"
      ln -sfnT /dev/null "$mask"
    done
    systemctl daemon-reload
    for unit in "${units[@]}"; do ! systemctl is-active --quiet "$unit" || die "$unit still active"; done
    printf 'Native controllers stopped and masked. Power off before reconnecting original HAOS media.\n'
  else
    for name in secrets.yaml ha-mcp.env mosquitto-passwords restic-repository restic-password restic-environment; do private_file "/var/lib/private/home-assistant/$name"; done
    bash "$0" pull-matter
    # Clear alias mask before canonical unit to avoid depending on alias resolution.
    for unit in "${units[@]}" matter-server.service restic-backups-home-assistant.timer restic-backups-home-assistant.service; do
      mask=/etc/systemd/system.control/$unit
      if [[ -e $mask || -L $mask ]]; then
        [[ -L $mask && $(readlink "$mask") == /dev/null ]] || die "unexpected existing unit override: $mask"
        rm -- "$mask"
      fi
    done
    systemctl daemon-reload
    for unit in "${units[@]}"; do
      systemctl start "$unit"
      systemctl is-active --quiet "$unit"
      if [[ $unit == home-assistant.service ]]; then
        ready=false
        for ((attempt = 0; attempt < 150; attempt++)); do
          if curl --disable --noproxy '*' --proto '=http' --silent --fail --max-time 2 http://127.0.0.1:8123/ >/dev/null; then
            ready=true
            break
          fi
          sleep 2
        done
        $ready || die 'HA HTTP did not become ready; inspect its journal before applying flows'
      fi
    done
    systemctl start restic-backups-home-assistant.timer
    printf 'Native services active. Continue with endpoint reconciliation and acceptance.\n'
  fi
  ;;
tool)
  [[ $# -gt 0 ]] || die 'tool PROGRAM [ARGS...]'
  case $1 in
  rclone | restic | ssh | scp | ssh-keygen | ssh-keyscan | jq | yq | curl | mosquitto_passwd | mosquitto_pub | mosquitto_sub | lsblk | ip | bluetoothctl | nix | nix-store | sqlite3 | rsync | tar | zstd | sha256sum | systemctl | od | podman) exec "$@" ;;
  *) die 'tool is not on the pinned migration-tool list' ;;
  esac
  ;;
api-snapshot)
  [[ $# == 3 ]] || die 'api-snapshot URL TOKEN_FILE OUTPUT'
  url=${1%/}
  token=$2
  output=$3
  [[ $url =~ ^http://127\.0\.0\.1:[0-9]+$ ]] || die 'use loopback or an SSH tunnel, with an explicit port'
  private_file "$token"
  [[ ! -e $output ]] || die 'API snapshot output already exists'
  private_dir "$output"
  header=$(mktemp "$output/header.XXXXXX")
  trap 'rm -f -- "$header"' EXIT
  token_value=$(tr -d '\r\n' <"$token")
  [[ $token_value =~ ^[A-Za-z0-9._-]+$ ]] || die 'invalid HA token format'
  printf 'Authorization: Bearer %s\n' "$token_value" >"$header"
  unset token_value
  for endpoint in config states services; do
    curl --disable --noproxy '*' --proto '=http' --max-redirs 0 --fail --silent --show-error --connect-timeout 10 --max-time 120 --header "@$header" "$url/api/$endpoint" >"$output/$endpoint.json"
    jq -e . "$output/$endpoint.json" >/dev/null
  done
  rm -- "$header"
  trap - EXIT
  printf 'Read-only API evidence saved privately.\n'
  ;;
cold-audit)
  native
  lan_transport
  [[ $# == 2 && $2 == --execute && -n ${HA_MIGRATION_PREFLIGHT:-} ]] || die 'use packaged app: cold-audit OUTPUT --execute'
  output=$1
  [[ ! -e $output ]] || die 'cold-audit output already exists'
  private_dir "$output"
  for unit in home-assistant ha-mcp mosquitto podman-matter-server tailscaled bluetooth; do
    systemctl is-active --quiet "$unit.service" || die "cold audit expects operational services; $unit is inactive"
    printf '%s.service\n' "$unit" >>"$output/active-units"
  done
  systemctl is-active --quiet restic-backups-home-assistant.timer || die 'cold audit expects the operational backup timer active'
  # Install recovery before stopping: a partial stop still requires a restart.
  recover_audit() {
    local status=$?
    trap - EXIT HUP INT TERM
    if ! bash "$0" start-native --execute; then
      printf 'Cold audit service recovery failed; active-units evidence retained in %s\n' "$output" >&2
      status=2
    fi
    exit "$status"
  }
  trap recover_audit EXIT
  trap 'exit 130' HUP INT TERM
  bash "$0" stop-native --execute
  mkdir "$output/homeassistant"
  cp -a --reflink=auto /var/lib/hass/. "$output/homeassistant/"
  "$HA_MIGRATION_PREFLIGHT" "$output/homeassistant" >"$output/preflight.json"
  printf 'Cold native audit passed; services will now restart.\n'
  ;;
health)
  native
  [[ $# == 1 ]] || die 'health OUTPUT'
  output=$1
  [[ ! -e $output ]] || die 'health output must not exist'
  private_dir "$output"
  failed=0
  for unit in home-assistant ha-mcp mosquitto podman-matter-server argonone-v3 tailscaled bluetooth glances systemd-networkd; do
    systemctl show "$unit.service" -p Id -p ActiveState -p SubState -p Result >>"$output/units.txt"
    systemctl is-active --quiet "$unit.service" || failed=1
  done
  uname -a >"$output/kernel.txt"
  readlink -f /run/current-system >"$output/system"
  lsblk --json -b -o NAME,PATH,TYPE,SIZE,MODEL,SERIAL,WWN,FSTYPE,LABEL,MOUNTPOINTS >"$output/storage.json"
  ip --json address show dev end0 >"$output/addresses.json"
  ip --json -6 route show table all >"$output/ipv6-routes.json"
  bluetoothctl list >"$output/bluetooth.txt"
  timedatectl show >"$output/clock.txt"
  tailscale status --json >"$output/tailscale.json"
  cat /sys/class/thermal/thermal_zone0/temp >"$output/temperature-millidegrees"
  cat /run/argonone/fan-status >"$output/fan.txt"
  sysctl net.netfilter.nf_conntrack_udp_timeout_stream >"$output/udp-timeout.txt"
  journalctl -b -p warning --no-pager >"$output/warnings.txt"
  jq -e '[.[].addr_info[]|select(.family=="inet6" and .scope=="global")]|length>0' "$output/addresses.json" >/dev/null || failed=1
  [[ -s $output/bluetooth.txt && $(timedatectl show -p NTPSynchronized --value) == yes ]] || failed=1
  jq -e '.BackendState=="Running"' "$output/tailscale.json" >/dev/null || failed=1
  [[ $(sysctl -n net.netfilter.nf_conntrack_udp_timeout_stream) == 3600 ]] || failed=1
  ((failed == 0)) || die 'health checks failed; inspect protected evidence before continuing'
  printf 'Automated host checks passed; physical acceptance is specified in the runbook.\n'
  ;;
cooling-test)
  native
  [[ $# == 2 && $2 == --execute ]] || die 'cooling-test OUTPUT --execute'
  output=$1
  [[ ! -e $output ]] || die 'cooling evidence already exists'
  private_dir "$output"
  declare -a load_pids=()
  cleanup_load() {
    local pid
    for pid in "${load_pids[@]}"; do kill "$pid" 2>/dev/null || true; done
    wait "${load_pids[@]}" 2>/dev/null || true
  }
  trap cleanup_load EXIT
  trap 'exit 130' INT TERM
  for ((cpu = 0; cpu < $(nproc); cpu++)); do
    yes >/dev/null &
    load_pids+=("$!")
  done
  printf 'seconds,temperature_millidegrees,fan_status\n' >"$output/samples.csv"
  for ((seconds = 0; seconds <= 300; seconds += 5)); do
    temperature=$(cat /sys/class/thermal/thermal_zone0/temp)
    systemctl is-active --quiet argonone-v3.service && [[ -s /run/argonone/fan-status ]] || die 'fan controller failed; CPU load stopped'
    if [[ ! $temperature =~ ^[0-9]+$ ]] || ((temperature >= 80000)); then
      die '80C limit/invalid sensor; CPU load stopped; inspect fan'
    fi
    printf '%s,%s,%s\n' "$seconds" "$temperature" "$(cat /run/argonone/fan-status)" >>"$output/samples.csv"
    ((seconds == 300)) || sleep 5
  done
  printf 'Bounded cooling test complete; physically verify fan against recorded speed.\n'
  ;;
prove-backup)
  native
  lan_transport
  [[ $# == 1 ]] || die 'prove-backup OUTPUT'
  output=$1
  [[ ! -e $output ]] || die 'backup proof output must not exist'
  for source in /var/lib/home-assistant-backup /var/lib/hass /var/lib/matter-server /var/lib/mosquitto /var/lib/private/home-assistant /var/lib/ha-mcp /var/lib/tailscale /var/lib/bluetooth /etc/ssh; do
    outside "$output" "$source"
  done
  private_dir "$output"
  credentials=/var/lib/private/home-assistant
  timer_active=false
  if systemctl is-active --quiet restic-backups-home-assistant.timer; then timer_active=true; fi
  recover_timer() {
    local status=$?
    trap - EXIT HUP INT TERM
    if $timer_active && ! systemctl start restic-backups-home-assistant.timer; then
      printf 'Backup timer recovery failed; inspect systemd unit status.\n' >&2
      status=1
    fi
    exit "$status"
  }
  trap recover_timer EXIT
  trap 'exit 130' HUP INT TERM
  systemctl stop restic-backups-home-assistant.timer
  systemctl start restic-backups-home-assistant.service
  [[ $(systemctl show restic-backups-home-assistant.service -p Result --value) == success ]] || die 'native backup service failed'
  restic_run "$credentials" check --read-data >"$output/check.log" 2>&1
  restic_run "$credentials" snapshots --json --latest 1 --host "$(hostname)" --path /var/lib/home-assistant-backup >"$output/snapshots.json"
  snapshot=$(jq -er 'if length==1 then .[0].id else error("snapshot count") end' "$output/snapshots.json")
  restic_run "$credentials" restore "$snapshot" --target "$output/restored" >"$output/restore.log" 2>&1
  rsync -aHAXnci --numeric-ids --delete /var/lib/home-assistant-backup/ "$output/restored/var/lib/home-assistant-backup/" >"$output/differences"
  [[ ! -s $output/differences ]] || die 'backup restore differs; inspect protected differences'
  for unit in home-assistant ha-mcp mosquitto podman-matter-server tailscaled bluetooth; do systemctl is-active --quiet "$unit" || die "backup did not recover $unit"; done
  printf 'Native encrypted backup checked and restored with matching data and metadata.\n'
  ;;
*)
  usage >&2
  die "unknown phase: $phase"
  ;;
esac
