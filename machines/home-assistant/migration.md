# HAOS → declarative NixOS on the Raspberry Pi 5

This is the complete cutover and recovery procedure. Follow the sections in
order. **Workstation** is a Linux Nix machine; **installer** is the Pi booted
from a separate SD; **native** is the installed Pi. These commands are authored
for operator execution. No live controller, disk, pairing or credential was
changed while writing this runbook.

The Pi is **aarch64-linux**. Reaper executes ARM builds through its configured
QEMU binfmt. An x86 HA test or ARM derivation evaluation is not an ARM system
build. Keep the original HAOS media physically separate during installation.
Use a separate candidate NVMe smaller than 2 TiB and a separate installer SD.
Use a 64 GB or larger SD (at least 32 GiB usable); larger captures may require a
larger card. The transfer-space check below measures the actual requirement.
The disk script follows the pinned Pi image's DOS partition layout: 1 GiB FAT32
`HA_FIRMWARE`, followed by ext4 `HA_NIXOS`.

## Ownership and confidence

| Concern | Source of truth | Recovery |
| --- | --- | --- |
| OS, firmware, services, packages, custom integrations | Git + flake.lock | Build recorded revision |
| Automations, scripts, scenes, YAML helpers/templates | Git, retaining original IDs | Rebuild; retain runtime registries |
| Authentication, OAuth, pairings, entity/device/area registries, dashboards, Assist pipelines, history | HA writable state | Consistent private cold capture |
| Matter fabric/node keys | Complete Matter `/data` | Cold capture; original HAOS rollback copy |
| MQTT persistence and all client credentials | Broker state + private runtime files | Persistence archive + native users |
| Tailscale/Bluetooth identities, outbound/host SSH keys | Private service state | Validated state/key restore |

HA [requires config flows for most integrations](https://developers.home-assistant.io/docs/configuration_yaml_index/).
Do not regenerate `.storage`, pairing keys or OAuth tokens from Nix. Upstream
[ended support for native Core after 2025.12](https://www.home-assistant.io/blog/2025/05/22/deprecating-core-and-supervised-installation-methods-and-32-bit-systems/).
This repository owns community native packaging and replaces Supervisor services.
The app store, ingress, Supervisor integration and HAOS update/backup controls
are absent on the destination.

**Low confidence — current private inventory:** the historical inspection export
is not a recovery backup. Current credentials, extra components, dormant MQTT
clients, device capabilities and Core version have not been read from the live
controller. Sections 3–7 obtain and validate those exact inputs.

**Low confidence — physical behavior:** builds cannot establish Pi boot/cooling,
Thread routing, sleeping reports or pairing continuity. Section 12 defines
specific tests/pass conditions. Argon fan control is implemented. The case power
button's shutdown protocol is not implemented; use `systemctl poweroff`.

Scripts inspect by default where they change disks, source controllers, restored
state or integration entries. Mutations require explicit flags/tokens. Never
use shell tracing, commit private evidence, pass private files to Nix evaluation,
or disable SSH host-key verification. All evidence stays in mode-0700 directories.

## 1. Build the pinned ARM system, installer, tests and tools

**Workstation:** start inside a clean committed checkout of this PR. The build
phase refuses an uncommitted tree because the recorded revision must reproduce
its artifacts.
Run these commands in Bash (`bash --noprofile --norc`), including in each new
terminal. Bash arrays and shell variables do not carry into another terminal.
Enable the shell's failure checks in every session below. A failed command exits
that session; reopen it, restore the recorded paths, and correct that exact
failure before continuing. Explicit `|| status=$?` checks handle expected audit
or selection results without hiding other failures.

```sh
set -euo pipefail
CHECKOUT=$(pwd -P)
WORK=$(mktemp -d /var/tmp/ha-migration.XXXXXXXX)
chmod 700 "$WORK"
umask 077
m() { nix run "$CHECKOUT#home-assistant-migrate" -- "$@"; }
m build "$CHECKOUT" "$WORK"
m declarations "$WORK/declarations.json"
nix build "$CHECKOUT#packages.x86_64-linux.home-assistant-migrate" \
  --no-write-lock-file --out-link "$WORK/tools-workstation"
nix build "$CHECKOUT#checks.x86_64-linux.home-assistant-migration" --no-link
nix build "$CHECKOUT#checks.aarch64-linux.home-assistant-migration" --no-link
TOOLS="$WORK/tools-workstation/bin/home-assistant-migrate"
jq() { "$TOOLS" tool jq "$@"; }
SYSTEM=$(readlink -f "$WORK/system")
ARM_TOOLS=$(readlink -f "$WORK/tools-arm")
IMAGE="$WORK/installer/sd-image/nixos-installer-rpi5-kernel.img.zst"
test "$(cat "$SYSTEM/system")" = aarch64-linux
test -f "$IMAGE"
```

On an ARM workstation select `packages.aarch64-linux` for `tools-workstation`.
`build` performs all-systems evaluation, ARM HA QA, the complete ARM system,
installer and ARM migration-tool closure. It saves `revision`, lock hash,
`target.json`, closure inventory and GC-root out-links. If ARM execution is
unsupported, run on Reaper or configure a trusted ARM remote builder; never
substitute an x86 system. Retry network/build failures with the same command;
no controller is touched.

Reserve space for uncompressed capture, its restored comparison, native state
and the Nix closure. Capture checks source free space above 120% of selected
state plus 100 MiB, including existing backups, **before downtime**. If needed,
copy older HAOS backups to the protected workstation, compare checksums, then
remove only those separately verified older files through HA's Backups UI.

## 2. Enable HAOS host-debug SSH and verify its identity

The SSH app on port 22 cannot capture the complete host. Use the independent
[host-debug daemon on port 22222](https://developers.home-assistant.io/docs/operating-system/debugging/).

1. On the workstation run `ssh-add -l`. Load the fleet main private key into the
   agent with `ssh-add` if necessary. Its public key is the evaluated
   `my.sshKeys.main`; the installer authorizes this key.
2. Put that **public** key, with LF line endings, in `authorized_keys` at the root
   of an already formatted USB filesystem labelled exactly `CONFIG`. Do not
   create a `network/` directory: HAOS imports replace network settings.
3. Attach USB to Pi; in HA Terminal & SSH web UI run `ha os import`; remove USB
   after import. Alternatively enter `login` at the physical HA CLI console.
4. At the physical host console run `find /etc/dropbear -maxdepth 1 -type f
   -name '*host_key'`, then `dropbearkey -y -f` for each resulting key file.
   Record its SHA256 fingerprint through that physical channel.

**Workstation:** select the declared LAN address; capture stops Tailscale.

```sh
SOURCE=$(nix eval --raw "$CHECKOUT#nixosConfigurations.home-assistant.config.my.hosts.homeassistant.lanIp")
ssh-keyscan -p 22222 "$SOURCE" > "$WORK/source-scanned-keys"
ssh-keygen -lf "$WORK/source-scanned-keys"
```

Compare each key to the physical fingerprint. Copy only verified lines into
`$WORK/known_hosts`, mode 0600. A network scan alone does not establish trust.

```sh
SSH_SOURCE=(-F /dev/null -o BatchMode=yes -o StrictHostKeyChecking=yes \
  -o "UserKnownHostsFile=$WORK/known_hosts" -p 22222)
ssh "${SSH_SOURCE[@]}" "root@$SOURCE" \
  'cat /etc/os-release; docker ps -a --format "{{.Names}}\t{{.Image}}"' \
  > "$WORK/source-containers.txt"
```

Read that private file and enter its exact names. Do not guess a third-party app
hash. They must be distinct; capture inspects their actual mounts.

```sh
read -r -p 'Core container name: ' CORE
read -r -p 'Matter container name: ' MATTER
read -r -p 'MQTT container name: ' MQTT
read -r -p 'Tailscale container name: ' TAILSCALE
read -r -p 'SSH app container name: ' SSH_ADDON
read -r -p 'MCP app container name: ' MCP
jq -n --arg checkout "$CHECKOUT" --arg source "$SOURCE" --arg core "$CORE" --arg matter "$MATTER" \
  --arg mqtt "$MQTT" --arg tailscale "$TAILSCALE" --arg ssh "$SSH_ADDON" --arg mcp "$MCP" \
  '{checkout:$checkout,source:$source,core:$core,matter:$matter,mqtt:$mqtt,tailscale:$tailscale,ssh:$ssh,mcp:$mcp}' \
  > "$WORK/workstation-session.json"
```

If resuming a workstation shell, restore its exact context:

```sh
set -euo pipefail
read -r -p 'Existing protected workstation WORK path: ' WORK
TOOLS="$WORK/tools-workstation/bin/home-assistant-migrate"
jq() { "$TOOLS" tool jq "$@"; }
CHECKOUT=$(jq -er .checkout "$WORK/workstation-session.json")
SOURCE=$(jq -er .source "$WORK/workstation-session.json")
CORE=$(jq -er .core "$WORK/workstation-session.json")
MATTER=$(jq -er .matter "$WORK/workstation-session.json")
MQTT=$(jq -er .mqtt "$WORK/workstation-session.json")
TAILSCALE=$(jq -er .tailscale "$WORK/workstation-session.json")
SSH_ADDON=$(jq -er .ssh "$WORK/workstation-session.json")
MCP=$(jq -er .mcp "$WORK/workstation-session.json")
SYSTEM=$(jq -er .system "$WORK/artifacts.json")
ARM_TOOLS=$(jq -er .tools "$WORK/artifacts.json")
IMAGE="$WORK/installer/sd-image/nixos-installer-rpi5-kernel.img.zst"
SSH_SOURCE=(-F /dev/null -o BatchMode=yes -o StrictHostKeyChecking=yes \
  -o "UserKnownHostsFile=$WORK/known_hosts" -p 22222)
SNAPSHOT="$WORK/rehearsal-unpacked/homeassistant"
```

**Low confidence — debug key path:** if `/etc/dropbear` differs on this HAOS
release, inspect `ps | grep '[d]ropbear'` for `-r` arguments and
`systemctl cat dropbear` at the physical console; fingerprint the declared key
path. Do not replace this with automatic trust-on-first-use.

## 3. Record baseline and capture a rehearsal

```sh
mkdir -m700 "$WORK/haos-emergency-kit"
```

In HA Settings → System → Backups, create a full manual backup named
`pre-nixos`. Complete the emergency-kit/encryption-key download, saving every
downloaded file directly in `$WORK/haos-emergency-kit`, and wait for backup
completion. Then protect the downloaded files:

```sh
find "$WORK/haos-emergency-kit" -type f -exec chmod 600 {} +
test -n "$(find "$WORK/haos-emergency-kit" -type f -print -quit)"
```

Capture checks an existing backup archive, not the retained encryption key.
The raw cold capture is independent of HAOS backup encryption; both seal
commands below also encrypt and restore-compare this emergency-kit directory.

In the administrator profile → Security → Long-lived access tokens, create
`nixos-migration`; copy it once through a silent prompt:

```sh
IFS= read -rs -p 'HA migration token: ' HA_TOKEN; printf '\n'
printf '%s\n' "$HA_TOKEN" > "$WORK/ha-token"; unset HA_TOKEN
```

Start the tunnel in a separate Bash terminal. Supply the existing workstation
`WORK` directory; no variables or arrays from the first terminal are assumed:

```sh
read -r -p 'Existing protected workstation WORK path: ' WORK
TOOLS="$WORK/tools-workstation/bin/home-assistant-migrate"
SOURCE=$("$TOOLS" tool jq -er .source "$WORK/workstation-session.json")
ssh -F /dev/null -o BatchMode=yes -o StrictHostKeyChecking=yes \
  -o "UserKnownHostsFile=$WORK/known_hosts" -p 22222 \
  -N -L 18123:127.0.0.1:8123 "root@$SOURCE"
```

Keep that terminal running. In the original terminal:

```sh
"$TOOLS" api-snapshot http://127.0.0.1:18123 "$WORK/ha-token" "$WORK/baseline-api"
"$TOOLS" capture --host "$SOURCE" --known-hosts "$WORK/known_hosts" \
  --output "$WORK/inspection" --core "$CORE" --matter "$MATTER" --mqtt "$MQTT" \
  --tailscale "$TAILSCALE" --ssh-addon "$SSH_ADDON" --mcp "$MCP"
"$TOOLS" capture --host "$SOURCE" --known-hosts "$WORK/known_hosts" \
  --output "$WORK/rehearsal" --core "$CORE" --matter "$MATTER" --mqtt "$MQTT" \
  --tailscale "$TAILSCALE" --ssh-addon "$SSH_ADDON" --mcp "$MCP" \
  --apply "CAPTURE-HAOS-$SOURCE"
"$TOOLS" unpack "$WORK/rehearsal" "$WORK/rehearsal-unpacked"
SNAPSHOT="$WORK/rehearsal-unpacked/homeassistant"
preflight_status=0
"$TOOLS" preflight "$SNAPSHOT" > "$WORK/rehearsal-preflight.json" || preflight_status=$?
test "$preflight_status" -le 1
test "$(tr -d '\r\n' < "$SNAPSHOT/.HA_VERSION")" = \
  "$(jq -r .coreVersion "$WORK/target.json")"
```

Capture records all running containers, stops Supervisor first, then containers
and Bluetooth, and archives the complete actual mounts. Rehearsal restores
previously active source services even on failure. `inventory.json` records old
boot/data serials/WWNs; `SHA256SUMS` covers archives and metadata. HA config
includes auth/registries, SQLite/WAL, ZHA, dashboards, media and journals.
Separate archives retain Matter `/data`, broker/Tailscale/SSH/MCP app state,
Bluetooth, original backups and mounted media/share/ssl.
`docker-inspect.json` inventories every current container, including apps outside
those six roles; their additional data is not silently treated as migrated.

Now complete [the live-change workbook](drift-workbook.md). It compares this
fresh capture with the branch by automation ID, script key, scene ID and the
remaining YAML, and accounts separately for UI state, custom code and apps.
Reference preflight alone cannot detect an unported new automation or an edited
action. Resolve every difference before choosing the final build revision.

Preflight exit 1 produces concrete findings; exit 2 means invalid input and stops
this procedure. Read `jq '.findings' "$WORK/rehearsal-preflight.json"`. Resolve
missing, disabled and conflicting identities using sections 5–7 before final
capture. Record exact old Supervisor endpoint/Supervisor-entry findings that the
supported native flows will resolve, plus an outbound-key finding only when its
verified key is staged explicitly in section 5. These remain pending, rather
than a successful source audit: the native cold audit after reconciliation must
return 0. Do not change an HAOS endpoint to native loopback before its replacement
exists. Exit 0/`needs-acceptance` establishes only this scanner's scope; physical
capability tests remain in section 12.

If Core versions differ, use matching HAOS backup state or update/test the
repository's exact Core/dependency pins before importing state. Never open newer
state with older Core. The supported-flow helpers enforce the reviewed
2026.10.2 contract; another pin requires comparing that release's actual forms
before changing those helpers. Preserve old media throughout.

## 4. Assemble native private credentials and prove remote recovery

```sh
mkdir -m700 "$WORK/credentials-input"
cp "$SNAPSHOT/secrets.yaml" "$WORK/credentials-input/secrets-before-yasno.yaml"
```

Read the captured soundbar `media_player` configuration. If its `!secret` name
differs, copy the existing value into `soundbar_api_key` using a local editor.
Section 7's deterministic Yasno bootstrap writes the finished `secrets.yaml`,
preserving other keys. It needs the exact existing entry, numeric address IDs,
preferences and neutral entity bindings; a group does not identify a household.

Create MCP runtime authentication. Initially use the migration administrator
token, then replace it with a dedicated MCP administrator token in section 12.
The old Supervisor token does not authenticate to native HA.

```sh
MCP_PATH=$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')
{ printf 'HOMEASSISTANT_TOKEN=%s\n' "$(cat "$WORK/ha-token")";
  printf 'MCP_SECRET_PATH=/%s\n' "$MCP_PATH"; } > "$WORK/credentials-input/ha-mcp.env"
unset MCP_PATH
```

### Complete MQTT users

```sh
ssh "${SSH_SOURCE[@]}" "root@$SOURCE" "docker logs --since 168h $MQTT" \
  > "$WORK/mqtt-client-history.txt" 2>&1
```

Build `$WORK/mqtt-client-ledger.json` as a private JSON array, one object per
client, with `client_id`, `device_or_service`, `settings_location`, `source`,
`native`, `changed_at`, `reconnect_verified` and `rollback_restored_at`.
`settings_location` records the exact supported settings page or config file/key
used to change that client. Both `source` and `native` contain `host`, `port`,
`tls`, `username` and `password_source`; the latter identifies the exact private
file/key or retained client setting containing that password. Record the actual
source values before changing anything. Keep every original password recoverable
privately, including credentials that will change. Add every `New client
connected` record, user in Mosquitto app Configuration, HA MQTT entry and
gateway/device MQTT settings, including Victron bridges. **Low confidence:**
dormant clients may be absent from retained logs. Compare this list with MQTT's
Devices page and actual bridge/device settings; power every listed client on
for acceptance. Keep this ledger mode 0600 and update it after each verified
change; never put credentials or private endpoint values in Git.

Create `$WORK/mqtt-users.json` as a complete array of `{username,password}`
objects, including HA and every external client. Keep known passwords where
possible. Record any required replacement of Supervisor implicit credentials in
the ledger's `native` settings, but leave the original client settings active
until section 11 starts the native broker. Usernames use letters/numbers and
`_ . @ -`; passwords contain no CR/LF/NUL.

```sh
chmod 600 "$WORK/mqtt-users.json"
"$TOOLS" mqtt-passwords "$WORK/mqtt-users.json" "$WORK/credentials-input/mosquitto-passwords"
```

The helper pipes secrets to the real interactive Mosquitto hasher, never argv.
Create `$WORK/mqtt-ha.json` with HA's selected `{username,password}` and
`$WORK/glances.json` containing `{}` for the declared unauthenticated loopback
Glances server. Both are 0600. Authenticated broker users currently read/write
`#`; this does not make missing passwords work.

### Google Drive restic repository

Use a new Drive folder/repository, preserving old HAOS backups. Create your own
OAuth client; do not depend on rclone's retired shared client. In Google Cloud
Console create/select the backup project, enable **Google Drive API** in API
Library, then open Google Auth Platform. Configure Branding and Audience for
the intended account; use External/Production for this personal application
because Testing refresh credentials expire after seven days. Under Clients,
create a **Desktop app** client named `realm-ha-backups`. Download its client
JSON to the protected workstation directory and set mode 0600. Follow Google's
[installed-app OAuth flow](https://developers.google.com/identity/protocols/oauth2/native-app)
and rclone's [own-client instructions](https://rclone.org/drive/#making-your-own-client-id).

```sh
"$TOOLS" tool rclone --config "$WORK/rclone.conf" config
```

Choose New remote → name `ha-backups` → type `drive`; enter that client ID and
secret at rclone's prompts, select Drive scope, and complete browser consent for
the intended account. Keep client secrets out of argv. For headless auth, follow
rclone's printed browser-machine authorization command and paste its result
only at the private prompt. Choose My Drive or the intended shared-drive ID.
Save mode-0600 `$WORK/rclone.conf`; keep the downloaded client JSON privately.

```sh
printf '%s\n' 'rclone:ha-backups:realm-home-assistant-restic' \
  > "$WORK/credentials-input/restic-repository"
od -An -N48 -tx1 /dev/urandom | tr -d ' \n' > "$WORK/credentials-input/restic-password"
printf '\n' >> "$WORK/credentials-input/restic-password"
printf 'RCLONE_CONFIG=/var/lib/private/home-assistant/rclone.conf\n' \
  > "$WORK/credentials-input/restic-environment"
chmod 600 "$WORK/credentials-input/"* "$WORK/rclone.conf"
cp -a "$WORK/credentials-input" "$WORK/backup-workstation"
printf 'RCLONE_CONFIG=%s\n' "$WORK/rclone.conf" > "$WORK/backup-workstation/restic-environment"
"$TOOLS" restic-init "$WORK/backup-workstation" --execute
"$TOOLS" seal "$WORK/rehearsal" "$WORK/backup-workstation" "$WORK/rehearsal-encrypted-proof" \
  "$WORK/haos-emergency-kit"
```

Initialize once only. On retries of an existing repository omit init and choose
a new proof output directory. `seal` performs encrypted backup, full data check,
restores the exact snapshot and compares content/metadata using rsync. Section 8
also includes native credentials, rclone OAuth configuration and any outbound
SSH key outside the old HA config in that backup and restore comparison. Retain
the password in a password manager/emergency copy independent of Pi/workstation.
`restic-environment` is literal `KEY=VALUE`, without shell evaluation, quotes,
repository/password overrides or whitespace in rclone config paths. The native
rclone.conf must also be installed in section 10; backup captures that directory.

## 5. Inventory code, outbound SSH and absolute paths

```sh
find "$SNAPSHOT/custom_components" -mindepth 1 -maxdepth 1 -printf '%f\n' | sort \
  > "$WORK/captured-component-domains.txt"
```

`sanitize` refuses a component without a declared package; only `__pycache__` is
ignored. For an extra active component create
`packages/home-assistant/custom-components/<domain>.nix` from the adjacent
`buildHomeAssistantComponent` examples with exact domain/version/source hash and
native dependencies; repeat ARM build and HA QA. Do not start with missing active
integrations or copy unmanaged Python back. Add to `extraComponents` only for
built-ins. Frontend `www/` and Lovelace resources are retained; check each
`/local/` and `/hacsfiles/` request in browser Network after migration. Turn off
HACS integration-code updates and update reviewed Nix pins instead.

Read captured `shell_command` for `-i`/`UserKnownHostsFile`. If implicit, inspect
captured `.ssh/config` and the HA user's actual home over host-debug SSH:
`docker exec "$CORE" sh -c 'id; ls -la /config/.ssh /root/.ssh'`. Copy its existing
chosen outbound key to `$WORK/outbound_key` and pinned known hosts to
`$WORK/outbound_known_hosts`, both 0600, **before source downtime** if outside
`/config`. Preserve the corresponding authorized key on Reaper. Verify Reaper's
host fingerprint through a trusted Reaper connection/console, then
`ssh-keygen -F reaper.glib.sh -f "$WORK/outbound_known_hosts"` must find it.
Do not test shutdown/reboot while discovering credentials.

Preflight reports private entry field paths containing Supervisor DNS or old
absolute paths without printing values. `/media`, `/share`, `/ssl` mounts are
captured/restored as `media`, `haos-share`, `haos-ssl` below `/var/lib/hass`.
Update each affected integration's supported path option to that exact retained
location. For other mounts inspect Core's full Docker mounts in the private
`docker-inspect.json`; archive their actual host source through debug SSH before
cutover, retain checksum/permissions, and restore to a named private HA directory.
No missing mount is replaced with an empty directory. Include extra archives
in the same encrypted recovery repository and perform a restore comparison.

## 6. Export supported endpoint changes

```sh
"$TOOLS" reconcile --export-plan "$SNAPSHOT" --declarations "$WORK/declarations.json" \
  --mqtt-credentials-file "$WORK/mqtt-ha.json" \
  --glances-credentials-file "$WORK/glances.json" --output "$WORK/reconcile.json"
"$TOOLS" reconcile --plan "$WORK/reconcile.json" > "$WORK/reconcile-review.json"
```

With multiple Glances entries, inspect their exact IDs/hosts privately and pass
`--glances-entry-id` for the old app entry. Do not delete unrelated entries.
The helper records IDs/endpoints/Glances names and target-capability candidates.
It validates native version and `/var/lib/hass` before mutations, so old HAOS
cannot receive changes even through an accidental tunnel.

| Integration | Supported operation | Identity consequence |
| --- | --- | --- |
| MQTT | Existing entry Reconfigure → `127.0.0.1:1883` + native credentials | Same entry ID |
| Matter | Manual Add Integration → `ws://127.0.0.1:5580/ws` | Updates the sole existing entry; never delete it |
| Glances | Add `127.0.0.1:61208`; retain old entry until mapped | New entry/device/sensor unique IDs |

The pinned [MQTT](https://github.com/home-assistant/core/blob/2026.10.2/homeassistant/components/mqtt/config_flow.py),
[Matter](https://github.com/home-assistant/core/blob/2026.10.2/homeassistant/components/matter/config_flow.py)
and [Glances](https://github.com/home-assistant/core/blob/2026.10.2/homeassistant/components/glances/config_flow.py)
contracts are explicit in the script. Preserve its hash-bound receipt on retry.

## 7. Yasno bootstrap and exact registry remediation

The following detailed commands use aliases for the same protected paths:

```sh
migration_snapshot=$SNAPSHOT
migration_private_dir="$WORK/credentials-input"
migration_public_declarations="$WORK/declarations.json"
```

The address/rename and Glances mapping appendix below supplies every private
bootstrap command. Invoke helpers through `"$TOOLS" prepare-yasno` and
`"$TOOLS" reconcile`; no script path or new package environment is required.
Keep the finished secrets at `credentials-input/secrets.yaml`.

For each preflight entity finding, search the exact ID in Settings → Devices &
services → Entities, inspect its integration/disabled status/device, and restore
the required ID or update that constant in `configuration/entities.nix` and
rebuild. Re-enable only intentionally required entities. For device/area
findings, inspect the actual device's domains/capabilities/area before changing
`configuration/devices.nix`. Do not replace a UUID because it merely shares a MAC.

Restore renamed scenes to `scene.night` / `scene.tv_watching` or update every
caller, retaining unique IDs `1741877284270` / `1743964862836`. Keep all 45
original automation IDs and baseline enabled states. Never purge registries to
remove findings. Remove an obsolete inactive entity individually only after its
replacement and lack of remaining callers are confirmed.

For every other Supervisor endpoint finding, record its exact entry ID/domain,
reported field, current endpoint and intended native/fleet endpoint in private
`$WORK/endpoint-plan.json` as a JSON array, using `[]` when there are no additional
entries. Keep it mode 0600. Inspect that integration's Configure/Reconfigure
dialog without submitting changes. Record the supported flow, or mark that an
explicit replacement entry and entity-name/device map will be needed. Source
entries must keep working HAOS endpoints throughout rehearsal; section 11
applies the recorded changes after native replacements exist. Record any OAuth
callback URL/DNS/proxy/certificate requirement there too, without starting
replacement authentication on the source.

After source UI renames/config changes, recapture into a new rehearsal directory,
re-export declarations/plan, and rerun preflight. Keep old copies immutable.
Then stage the complete six-file bundle:

```sh
"$TOOLS" credentials "$WORK/credentials-input" "$WORK/credentials-native"
```

## 8. Write SD; take final capture; stop and retain original media

On the workstation inspect `lsblk -e7 -o
PATH,TYPE,SIZE,MODEL,SERIAL,WWN,FSTYPE,LABEL,MOUNTPOINTS`. Set `SD_DISK` to the
physical SD whole device, `SD_SERIAL` to its exact unique serial, and
`WORKSTATION_DISK` to the whole workstation disk to preserve (mounted descendants
include workstation root). Unmount each mounted SD partition explicitly.

```sh
sudo "$TOOLS" flash-sd "$IMAGE" "$SD_DISK" "$SD_SERIAL" "$WORKSTATION_DISK"
sudo "$TOOLS" flash-sd "$IMAGE" "$SD_DISK" "$SD_SERIAL" "$WORKSTATION_DISK" --execute
"$TOOLS" capture --host "$SOURCE" --known-hosts "$WORK/known_hosts" \
  --output "$WORK/final" --core "$CORE" --matter "$MATTER" --mqtt "$MQTT" \
  --tailscale "$TAILSCALE" --ssh-addon "$SSH_ADDON" --mcp "$MCP" \
  --apply "CAPTURE-HAOS-$SOURCE" --leave-stopped
"$TOOLS" unpack "$WORK/final" "$WORK/final-unpacked"
```

SD write checks identity, mounted/swap use, capacity, compressed integrity and
full byte readback. **Low confidence:** readers lacking unique serials must be
replaced by a direct slot/reader exposing identity; no bypass flag exists.

Validate final state and regenerate the entry plan and guard configuration from
that exact capture. The existing private Yasno query/selection files are only
used when its entry is still group-only; a captured address entry needs neither.

```sh
FINAL_SNAPSHOT="$WORK/final-unpacked/homeassistant"
preflight_status=0
"$TOOLS" preflight "$FINAL_SNAPSHOT" > "$WORK/final-preflight.json" || preflight_status=$?
test "$preflight_status" -le 1
test "$(tr -d '\r\n' < "$FINAL_SNAPSHOT/.HA_VERSION")" = "$(jq -r .coreVersion "$WORK/target.json")"
"$TOOLS" reconcile --export-plan "$FINAL_SNAPSHOT" --declarations "$WORK/declarations.json" \
  --mqtt-credentials-file "$WORK/mqtt-ha.json" --glances-credentials-file "$WORK/glances.json" \
  --glances-entry-id "$(jq -er .entries.glances "$WORK/reconcile.json")" \
  --output "$WORK/final-reconcile.json"
YASNO_ENTRY_ID=$("$TOOLS" tool yq -r '.yasno_address_guard.entry_id' "$WORK/credentials-native/secrets.yaml")
"$TOOLS" collect-yasno --snapshot "$FINAL_SNAPSHOT" --entry-id "$YASNO_ENTRY_ID" \
  --output "$WORK/final-yasno-evidence" \
  --query-file "$WORK/credentials-input/yasno-queries.json" \
  --selection-file "$WORK/credentials-input/yasno-selections.json"
"$TOOLS" prepare-yasno --snapshot "$FINAL_SNAPSHOT" --entry-id "$YASNO_ENTRY_ID" \
  --address-file "$WORK/final-yasno-evidence/yasno-address.json" \
  --regions-file "$WORK/final-yasno-evidence/yasno-regions.json" \
  --official-group-file "$WORK/final-yasno-evidence/yasno-official-group.json" \
  --existing-secrets "$WORK/credentials-native/secrets.yaml" \
  --output "$WORK/final-secrets.yaml" --plan "$WORK/final-yasno-name-plan.json"
install -m600 "$WORK/final-secrets.yaml" "$WORK/credentials-native/secrets.yaml"
"$TOOLS" credentials "$WORK/credentials-native" "$WORK/credentials-final"
drift_status=0
"$TOOLS" config-drift --snapshot "$FINAL_SNAPSHOT" --declarations "$WORK/declarations.json" \
  --output "$WORK/drift-final" || drift_status=$?
test "$drift_status" -le 1
```

Review every row in `drift-final/workbook.md` against the resolved rehearsal
workbook. Stage its exact decision template:

```sh
cp -a "$WORK/drift-final/decisions-template.json" "$WORK/drift-final-decisions.json"
```

Fill/verify its decisions and allowed inventory acknowledgements in a local
editor. Keep the runtime checklist at `$WORK/runtime-decisions.md`. Validate the
final ledger and prove recovery with:

```sh
"$TOOLS" config-drift --snapshot "$FINAL_SNAPSHOT" --declarations "$WORK/declarations.json" \
  --decisions "$WORK/drift-final-decisions.json" --output "$WORK/drift-final-accounted"
"$TOOLS" seal "$WORK/final" "$WORK/backup-workstation" "$WORK/final-encrypted-proof" \
  "$WORK/credentials-final" "$WORK/rclone.conf" "$WORK/outbound_key" \
  "$WORK/outbound_known_hosts" "$WORK/mqtt-ha.json" "$WORK/glances.json" \
  "$WORK/final-reconcile.json" "$WORK/ha-token" \
  "$WORK/mqtt-client-ledger.json" "$WORK/endpoint-plan.json" "$WORK/haos-emergency-kit" \
  "$WORK/drift-final-accounted" "$WORK/drift-final-decisions.json" "$WORK/runtime-decisions.md"
```

Require exit 0 and include the validated report in the encrypted recovery proof.
If an item changed after rehearsal, recover source using section 13, integrate
and verify that change with the workbook, then repeat capture into a new
directory. Do not edit fingerprints to accept stale decisions.

Compare `final-preflight.json` with the resolved rehearsal findings. Only the
exact already-planned native endpoint/Supervisor cleanup and staged outbound
key findings may remain pending until native reconciliation; a new or changed
identity finding stops cutover. If final Yasno evidence or names differ, restore
the source using its recorded services, repair through its supported UI, and
repeat capture into a new directory. Do not continue with stale secrets or IDs.

Successful final capture leaves controllers stopped. Capture failure attempts
source restart; never infer stop from a lost connection. Power off original with
`ssh "${SSH_SOURCE[@]}" "root@$SOURCE" 'systemctl poweroff'`.
Wait for activity to cease, unplug power, remove/label original NVMe and boot
media **HAOS rollback — do not write**. Fit candidate NVMe + installer SD, wired
Ethernet and power.

At installer console verify `uname -m` is `aarch64`, get its IP via `ip -4 addr`,
and fingerprint `/etc/ssh/ssh_host_ed25519_key.pub` with `ssh-keygen -lf`. Set
`INSTALLER_IP` to the displayed LAN IP. Workstation `ssh-keyscan` port 22 must
match that physical fingerprint; save verified lines in separate mode-0600
`$WORK/installer-known-hosts`.

```sh
SSH_INSTALLER=(-F /dev/null -o BatchMode=yes -o StrictHostKeyChecking=yes \
  -o "UserKnownHostsFile=$WORK/installer-known-hosts")
export NIX_SSHOPTS="-F /dev/null -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=$WORK/installer-known-hosts"
"$TOOLS" check-transfer "$SYSTEM" "$ARM_TOOLS" "$WORK/final" "$INSTALLER_IP" "$WORK/installer-known-hosts"
nix copy --no-check-sigs --to "ssh-ng://root@$INSTALLER_IP" "$SYSTEM" "$ARM_TOOLS"
ssh "${SSH_INSTALLER[@]}" "root@$INSTALLER_IP" 'install -d -m700 /root/ha-migration'
scp "${SSH_INSTALLER[@]}" -r "$WORK/final" "$WORK/credentials-final" \
  "$WORK/outbound_key" "$WORK/outbound_known_hosts" "$WORK/rclone.conf" \
  "$WORK/final-reconcile.json" "$WORK/mqtt-ha.json" "$WORK/glances.json" "$WORK/ha-token" "$WORK/artifacts.json" \
  "$WORK/mqtt-client-ledger.json" "$WORK/endpoint-plan.json" \
  "root@$INSTALLER_IP:/root/ha-migration/"
```

`--no-check-sigs` applies only to these locally built outputs of the recorded
checkout, carried over the fingerprint-verified transport. It does not change
binary-cache trust or permit using unreviewed closure paths. `stage-tools`
retains that exact tool closure on the installed NVMe before its first boot.
The pinned installer expands its SD root on first boot. If `check-transfer`
fails, read `journalctl -b -u expand-root-partition.service` at its console and
`df -B1 --output=size,avail /nix/store`. A failed expansion or undersized card
must be corrected before transfer: power off, reflash a sufficiently large card
through section 8's workstation safeguards, and boot it again. Do not resize a
guessed partition or use candidate/original NVMe as scratch space.

## 9. Install only the candidate NVMe

**Installer:** start Bash and read the copied public artifact manifest. Nix is
available in the installer and bootstraps the tool path without assuming jq is
installed in its shell. Select `CANDIDATE` and `CANDIDATE_SERIAL` from its actual
whole-disk inventory. The original is physically absent, identified by capture.

```sh
set -euo pipefail
WORK=/root/ha-migration
ARM_TOOLS=$(nix eval --impure --raw --expr '(builtins.fromJSON (builtins.readFile "/root/ha-migration/artifacts.json")).tools')
TOOLS="$ARM_TOOLS/bin/home-assistant-migrate"
jq() { "$TOOLS" tool jq "$@"; }
SYSTEM=$(jq -er .system "$WORK/artifacts.json")
lsblk -d -b -o PATH,TYPE,SIZE,MODEL,SERIAL,WWN
"$TOOLS" install --target-disk "$CANDIDATE" --target-identity "serial:$CANDIDATE_SERIAL" \
  --preserve-identity "$WORK/final/inventory.json" --system "$SYSTEM"
"$TOOLS" install --target-disk "$CANDIDATE" --target-identity "serial:$CANDIDATE_SERIAL" \
  --preserve-identity "$WORK/final/inventory.json" --system "$SYSTEM" --execute
```

For WWN-only drives use `--target-identity "wwn:$CANDIDATE_WWN"` and restore's
`--expected-wwn`, omitting serial. The script rejects original identities,
mounted/swap/RO/mapper/RAID targets, wrong architecture/host, incomplete closures
and ambiguous identifiers. It formats/mounts and installs the **built** system
at `/mnt/ha-candidate`; it never boots/starts controllers. Failure unmounts new
mounts. Inspect the error before any explicit retry/erase.

## 10. Restore and sanitize before first boot

```sh
"$TOOLS" restore --capture "$WORK/final" --private "$WORK/credentials-final" \
  --target-root /mnt/ha-candidate --target-disk "$CANDIDATE" --expected-serial "$CANDIDATE_SERIAL"
"$TOOLS" restore --capture "$WORK/final" --private "$WORK/credentials-final" \
  --target-root /mnt/ha-candidate --target-disk "$CANDIDATE" --expected-serial "$CANDIDATE_SERIAL" \
  --apply RESTORE-HOME-ASSISTANT
"$TOOLS" sanitize /mnt/ha-candidate "$WORK/outbound_key" "$WORK/outbound_known_hosts" --execute
"$TOOLS" stage-tools /mnt/ha-candidate "$ARM_TOOLS" --execute
install -m600 "$WORK/rclone.conf" /mnt/ha-candidate/var/lib/private/home-assistant/rclone.conf
install -d -m700 /mnt/ha-candidate/var/lib/ha-migration
install -m600 "$WORK/final-reconcile.json" \
  /mnt/ha-candidate/var/lib/ha-migration/reconcile.json
cp -a "$WORK/mqtt-ha.json" "$WORK/glances.json" "$WORK/ha-token" \
  "$WORK/mqtt-client-ledger.json" "$WORK/endpoint-plan.json" \
  /mnt/ha-candidate/var/lib/ha-migration/
sync
umount /mnt/ha-candidate/boot/firmware
umount /mnt/ha-candidate
systemctl poweroff
```

Restore checks all archive/metadata hashes, HA/ZHA SQLite integrity, the installed
native hass/Mosquitto IDs, Matter `1000:1000`, native credentials and source/candidate
identity. It maps unique broker/Tailscale persistence directories, imports
media/share/ssl, and restores only validated OpenSSH-format host keys. If no SSH
app host keys exist, supply a verified `--ssh-host-keys DIRECTORY` containing
OpenSSH key pairs. Dropbear keys are not interchangeable. If install activation
already generated candidate keys, use `--replace-generated-host-keys`; the script
backs them up and restores them on failure. Do not delete identities manually.

Sanitize moves old managed YAML/component/Yasno sources into the private
preserved-sources directory and installs explicitly selected outbound SSH files.
It retains `.storage`, other YAML, dashboards, history, media and journals. Native
preStart creates the Nix links and refuses conflicting unmanaged sources.

Restore masks HA/MCP/Matter/broker/Tailscale/Bluetooth and backup service/timer
in persistent `/etc/systemd/system.control` (higher priority than Nix's immutable
unit directory). First candidate boot leaves controllers stopped. Remove SD only
after poweroff, then power on the candidate NVMe. If boot fails use section 13.
Operator evidence lives in root-only `/var/lib/ha-migration`, outside the state
and credentials directories captured by nightly backup. Do not move restored
backup proofs beneath `/var/lib/hass`, `/var/lib/private/home-assistant` or
`/var/lib/home-assistant-backup`; the next backup would capture its own restored
copies recursively.

## 11. Start and use supported HA flows

Verify native hostname/architecture/SSH fingerprint at the console and pin its
port-22 identity separately as `native-known-hosts`. On the native root shell:

```sh
set -euo pipefail
TOOLS=/nix/var/nix/gcroots/ha-migration-tools/bin/home-assistant-migrate
OP=/var/lib/ha-migration
jq() { "$TOOLS" tool jq "$@"; }
"$TOOLS" pull-matter --execute
"$TOOLS" start-native --execute
jq --arg mqtt "$OP/mqtt-ha.json" --arg glances "$OP/glances.json" \
  '.credential_files={mqtt:$mqtt,glances:$glances}' "$OP/reconcile.json" > "$OP/native-plan.json"
"$TOOLS" reconcile --plan "$OP/native-plan.json" --url http://127.0.0.1:8123 \
  --token-file "$OP/ha-token" --apply --receipt "$OP/reconcile-receipt.json"
"$TOOLS" api-snapshot http://127.0.0.1:8123 "$OP/ha-token" "$OP/after-api"
```

`start-native` waits for HA HTTP readiness before returning. The
system closure does not fetch OCI runtime images: `pull-matter` caches the exact
digest and verifies ARM64 first. Matter imports complete old `/data`, as
[documented for Python-server storage](https://github.com/matter-js/matterjs-server/blob/v1.4.0/docs/cli.md#storage-format).
HA Bluetooth supplies BLE proxy. Do not commission replacement devices as a
shortcut for failed import.

**Low confidence — private Matter format:** if the native server has no old
fabric/nodes or reports conversion errors, stop native immediately, preserve its
failed data privately and return to untouched HAOS using section 13. Do not
replace the only working Python state or run both controllers. Retry from the
unchanged cold capture into fresh candidate state, never partial converted state.

A failed flow is canceled and its old entry is retained. Correct the exact
reported issue; retry with the same plan/receipt and optionally
`--integration mqtt|matter|glances`. UI fallback is existing MQTT → Reconfigure;
Matter → Add Integration → manual server URL. Use section 6 endpoints. Do not
delete/re-add MQTT or Matter. The appendix supplies exact Glances metric mapping:
verify the map first, remove only the selected old entry, then assign its freed
entity IDs to the replacement sensors. Renaming first would collide with names
still reserved by the old registry records.

Now apply each client change from `$OP/mqtt-client-ledger.json` at its recorded
`settings_location`, using only its recorded `native` host/port/TLS/username and
password source. Keep the source values intact. Use the workstation's original
`$WORK/mqtt-client-ledger.json` as the authoritative recovery record: enter
`changed_at` there immediately before submitting each client change, reconnect
the client, and verify its intended client ID/username in the native broker log
plus a fresh HA value before marking `reconnect_verified`. Keep that workstation
record available even if the candidate fails to boot; do not depend on its
native copy for rollback. A source-only app that was replaced by a native
service remains stopped on retained HAOS; configure its native replacement
instead.

For each additional entry in `$OP/endpoint-plan.json`, open its recorded
Configure/Reconfigure flow on native HA and change only the recorded endpoint
field. If no endpoint flow exists, retain its old entry until a replacement and
explicit entity-name/device map are verified using the Glances method. Complete
that replacement's OAuth prompts and verify its external callback URL,
certificate, proxy/DNS and mobile access. Every retained entry must show loaded.
Remove Supervisor integration through Settings → Devices & services only after
its native replacements work.
After these repairs and the Glances name changes, run
`"$TOOLS" cold-audit "$OP/after-reconciliation" --execute` and require exit 0.
Inspect its `preflight.json`; no pending source-reference or endpoint finding
is waived by the earlier plan. The command restores native services on exit.

## 12. Acceptance, backup restore, second boot and activation

```sh
"$TOOLS" health "$OP/health-first-boot"
"$TOOLS" cooling-test "$OP/cooling-proof" --execute
"$TOOLS" prove-backup "$OP/native-backup-proof"
```

Health records units, generation, disks, IPv6 routes, Bluetooth, NTP, cooling and
warning journal. It also requires Tailscale's backend to be `Running`. If its
protected `tailscale.json` reports `NeedsLogin`, run `tailscale login` from the
native console, open its private authentication URL in a trusted browser, and
approve the restored node in the existing tailnet. Do not commit that URL or
create a second node while the original controller runs. Repeat health into a
new directory and verify the expected peers and DNS. Backup proof runs the actual service, checks complete encrypted
data, restores the latest exact host snapshot, compares content/metadata and
verifies stopped services recovered. It stops/restarts the timer around proof.
Record timestamp/result/entity/device for every following test privately in
`$OP/physical-acceptance.md`. A low-confidence test is unexecuted until its pass
condition is observed; scripts alone do not establish hardware acceptance.

| Test | Exact action and required result |
| --- | --- |
| NVMe/boot | Root/firmware labels and candidate serial match; original disk absent. Kernel journal contains no NVMe I/O reset/error. |
| Cooling | Inspect `cooling-proof` from the bounded five-minute `cooling-test`: it stops CPU workers on signals, 80°C or fan failure. Observe startup full-speed fan and speed tracking the temperature curve. If a stopped test leaves temperature rising, power off through the OS; do not rely on the case button. |
| ZHA | Compare old device count/IEEE addresses. Press each declared room/kitchen/bed/table button once; inspect its existing automation trace and correct light result. Never reset/re-pair coordinator. |
| Matter | Compare old fabric/node/device identities. Operate one existing mains entity and observe fresh reports. Wake each sleeping device using its physical documented action, then observe an unattended report across its configured reporting interval; record interval/timestamps. |
| Thread | Confirm actual OMR prefix from route evidence and `ip -6 route get DEVICE_IPV6` selects expected border router/end0. Verify reports after >120 seconds idle and a complete sleeping reporting interval. UDP timeout 3600 does not replace route correctness. |
| MQTT | Power on every ledger client; verify intended username/client ID in broker logs plus fresh HA values. Compare retained/availability values. Every ledger row must pass. |
| Original IDs/states | Compare baseline automation entity IDs and enabled states, including disabled automations. Verify `scene.night`/`scene.tv_watching`, no accidental `_2`. Run each scene during a safe media/light test; restore prior state. |
| Voice device targets | For each target in plan inspect actual entities and area. Developer Tools → Actions: `media_player.volume_set` for each device affects only its intended speakers; `assist_satellite.announce` on room target plays “migration test” on intended fan-out. Restore volumes. Missing domains require selecting the evidenced correct UUID in Nix, rebuild and repeat. |
| Wake target | Inspect switch integration and target MAC. With Reaper safely off, `switch.turn_on` for that exact target boots Reaper. Router duplicate IDs are insufficient evidence. |
| Assist pipelines (historical count: five) | Compare every captured pipeline name/STT/TTS/conversation/language in `.storage/assist_pipeline.pipelines`; if the current capture has a different count, retain and test all of them. Select each on its intended Voice PE, ask “What time is it?”, observe STT→conversation→TTS trace and audible response. Restore normal selections. Stop only the chosen Reaper STT/TTS service during a controlled fallback test, observe Remote selection; restart and observe Reaper selection. |
| Alerts/water/media | Send explicit short migration-test announcement and verify both intended speakers/restore volumes. Record the current on/off states of `switch.hot_water_valve` and `switch.cold_water_valve`; with water-using appliances idle, use Developer Tools → Actions → `switch.turn_off` targeting those two exact entities, observe both physical valves close, then restore each original on/off state with `switch.turn_on`/`switch.turn_off`. Test speech separately with an explicit migration-test message; do not simulate a leak by overwriting sensor state. Test TV/soundbar/source/volume and weather fallback using noncritical content. Do not trigger a real emergency event. |
| SSH | Run the exact read-only command below; confirm exit 0. Inspect `sudo -l -U hass` on Reaper for intended bootctl/shutdown permissions. Save work before testing actual one-shot Windows reboot/shutdown; verify resulting OS/power state. |
| Yasno | Developer Tools → Actions → `pyscript.yasno_address_check` with `dry_run:true, force_check:true`; inspect guard entity for official group and no bootstrap/binding error. Then normal check; verify protected journal and nine neutral IDs. |
| UI/OAuth/mobile/MCP | Every migrated entry loaded; OAuth prompts completed. Open all dashboards and inspect failed `/local/`/`hacsfiles/` requests; external HTTPS/mobile notifications work. Connect MCP using private env path and perform read-only entity query; never log its private URL. |
| Backup | Proof differences empty; full repository check succeeded; restored auth/DB/fabric/native credentials/SSH identities exist; all controllers recovered. Password retained separately. |

```sh
sudo -u hass ssh -o BatchMode=yes -o StrictHostKeyChecking=yes \
  -o UserKnownHostsFile=/var/lib/hass/.ssh/known_hosts -o IdentitiesOnly=yes \
  -i /var/lib/hass/.ssh/outbound_key hass@reaper.glib.sh true
```

**Low confidence — Thread filtering:** stateful filtering remains enabled and
UDP lifetime follows [Matter.js requirements](https://github.com/matter-js/matterjs-server/blob/v1.4.0/docs/os_requirements.md#stateful-firewalls-host-vm-hypervisor).
If measured reports fail, capture actual prefix/ports and drop counters on
`end0`; commit any needed rule using that verified OMR prefix/interface, rebuild,
switch and repeat idle/sleep tests. Do not globally disable IPv6 filtering.

Record accepted system and reboot through the OS:

```sh
readlink -f /run/current-system > "$OP/accepted-system"
systemctl reboot
```

Reconnect with the pinned native host key and start a new Bash session:

```sh
set -euo pipefail
TOOLS=/nix/var/nix/gcroots/ha-migration-tools/bin/home-assistant-migrate
OP=/var/lib/ha-migration
"$TOOLS" health "$OP/health-second-boot"
systemctl list-timers restic-backups-home-assistant.timer
```

The timer must show the next 03:30 backup (up to 15 minutes jitter). Repeat one
ZHA action, one Matter report, MQTT freshness and a Voice PE request; record all
four results in `physical-acceptance.md` before continuing. Activate the accepted
generation and check the resulting services:

```sh
accepted_system=$(cat "$OP/accepted-system")
test "$accepted_system" = "$(readlink -f /run/current-system)"
"$accepted_system/bin/switch-to-configuration" switch
"$TOOLS" health "$OP/health-after-activation"
```

This tests activation of the accepted code and its retained state.

1. In native HA open the administrator profile → Security → Long-lived access
   tokens → Create token, name it `native-ha-mcp`, and copy its one-time value.
2. In the native root shell run the following block. The silent prompt does not
   put that token in command arguments or history. The existing secret path is
   preserved, and the complete staged bundle is validated before installation:

```sh
set +x
umask 077
"$TOOLS" credentials /var/lib/private/home-assistant "$OP/credentials-token-rotation-input"
mcp_secret_path=''
while IFS='=' read -r mcp_key mcp_value; do
  if [[ $mcp_key == MCP_SECRET_PATH ]]; then mcp_secret_path=$mcp_value; fi
done < "$OP/credentials-token-rotation-input/ha-mcp.env"
[[ $mcp_secret_path =~ ^/[A-Za-z0-9_-]{32,}$ ]]
IFS= read -rs -p 'Dedicated native-ha-mcp token: ' mcp_token; printf '\n'
[[ $mcp_token =~ ^[A-Za-z0-9._-]+$ ]]
{ printf 'HOMEASSISTANT_TOKEN=%s\n' "$mcp_token";
  printf 'MCP_SECRET_PATH=%s\n' "$mcp_secret_path"; } \
  > "$OP/credentials-token-rotation-input/ha-mcp.env"
unset mcp_token mcp_secret_path mcp_key mcp_value
"$TOOLS" credentials "$OP/credentials-token-rotation-input" "$OP/credentials-after-token-rotation"
install -o root -g root -m600 "$OP/credentials-after-token-rotation/ha-mcp.env" \
  /var/lib/private/home-assistant/ha-mcp.env
systemctl restart ha-mcp.service
systemctl is-active --quiet ha-mcp.service
```

3. Through the existing MCP client at its retained private path, perform a
   read-only query for `sensor.yasno_power` and compare its result with native
   HA. Require success before revoking the migration token.
4. Confirm every client has stopped using `nixos-migration`. In the native
   administrator profile → Security → Long-lived access tokens, delete only
   the token named `nixos-migration`.

The earlier backup predates this auth and credential change; prove the final
state again:

```sh
"$TOOLS" prove-backup "$OP/native-backup-proof-after-token-rotation"
```

Require empty proof differences, a successful full repository check and restored
services again. Remove temporary token/credential copies only after this final
recovery proof and independent password retention.
Keep original media + matching cold capture together for rollback.

## 13. Rollback and interrupted-operation recovery

**Acceptance failure on a running native host:** preserve private health/API/
failed-service evidence, then:

```sh
"$TOOLS" stop-native --execute
systemctl poweroff
```

Stop-native stops timer/backup before cleanup can restart controllers, then
HA/MCP/Matter/broker/Tailscale/Bluetooth, masks them persistently and verifies
inactivity. After poweroff unplug power, remove/label candidate, reinstall original
HAOS NVMe/boot media, remove SD and power on. Never run original while native
controllers remain running. Using the workstation's retained
`mqtt-client-ledger.json`, restore each changed external client's exact `source`
host/port/TLS/username/password through its recorded `settings_location` after
the candidate is powered off. Reconnect each client to HAOS and record
`rollback_restored_at` only after its intended client ID/username and fresh HA
value are verified. Do not change a client that kept its original settings.
Check login, ZHA, Matter, MQTT and voice against baseline. A provider may have
invalidated the source OAuth refresh token when native HA refreshed it: for
each affected original entry, open its existing Settings → Devices & services
repair/reauthentication prompt, sign in to the same provider account, approve
its original callback URL and verify that entry loads. Retain its entry/entity/
device IDs; do not delete/re-add or re-pair it. Do not copy converted native data
back to original HAOS.

If HAOS does not automatically restart containers left stopped by final capture,
use the workstation's recorded capture and verified host-debug identity:

```sh
set -euo pipefail
read -r -p 'Existing protected workstation WORK path: ' WORK
TOOLS="$WORK/tools-workstation/bin/home-assistant-migrate"
SOURCE=$("$TOOLS" tool jq -er .source "$WORK/workstation-session.json")
"$TOOLS" recover-source --capture "$WORK/final" --host "$SOURCE" \
  --known-hosts "$WORK/known_hosts"
"$TOOLS" recover-source --capture "$WORK/final" --host "$SOURCE" \
  --known-hosts "$WORK/known_hosts" --apply "RECOVER-HAOS-$SOURCE"
```

This validates HAOS and the complete checksummed metadata, restores Bluetooth
only if previously active, starts recorded containers in reverse stop order,
and restores the recorded Supervisor unit only if previously active. It tries
all recorded recovery actions before reporting failure. Check `docker ps` and
loaded integrations. Never run this until the candidate is powered off.

**Candidate cannot boot/reach SSH:** power off after disk activity ceases; boot
installer SD with only candidate attached. At console identify its serial, mount
`HA_NIXOS` read-only and copy logs/private evidence to protected workstation. For
immediate recovery power off and physically restore original media as above.
Never format any serial matching captured original inventory.

**Restore failed:** script removes newly promoted candidate state, retains
controller masks and restores preexisting candidate SSH identities. Read its
error. Preserve any remaining candidate state privately, explicitly reinstall
candidate through section 9, then restore unchanged verified capture. Do not
repair missing auth by deleting `.storage`.

**Native backup interrupted:** inspect service journal and
`/run/home-assistant-backup/active-services.json`, run
`home-assistant-backup-recover`, verify every recorded service active. Preserve
incomplete `.next` copy and journal before removing/retrying. **HAOS capture
interrupted:** failed remote recovery retains/prints its exact protected journal
path. Use its running-containers/active-services/Supervisor-unit to restore
source with the same guarded helper, supplying that exact retained path:

```sh
read -r -p 'Exact retained /mnt/data/.ha-migration-capture.XXXXXX path: ' SOURCE_JOURNAL
"$TOOLS" recover-source --remote-journal "$SOURCE_JOURNAL" --host "$SOURCE" \
  --known-hosts "$WORK/known_hosts"
"$TOOLS" recover-source --remote-journal "$SOURCE_JOURNAL" --host "$SOURCE" \
  --known-hosts "$WORK/known_hosts" --apply "RECOVER-HAOS-$SOURCE"
```

Remote journal mode requires the generated path, root ownership/mode 0700 and
validated plain recovery metadata; it does not bless an incomplete backup.
A partial capture without complete marker and verified full
manifest is not a recovery copy.

A Nix rollback changes code, not migrated databases/registries/fabrics. Any code
downgrade requires its matching cold state. Untouched original HAOS media is
this migration's immediate rollback mechanism.

## Appendix: executable Yasno collection and Glances name mapping

### Workstation, before final capture: Yasno

Use section 7's aliases in the existing workstation Bash session:

```sh
migration_snapshot=$SNAPSHOT
migration_private_dir="$WORK/credentials-input"
YASNO_EVIDENCE="$migration_private_dir/yasno-evidence"
jq -r '.data.entries[] | select(.domain == "yasno_outages") | .entry_id' \
  "$migration_snapshot/.storage/core.config_entries"
read -r -p 'Exact captured Yasno entry ID: ' YASNO_ENTRY_ID
```

`collect-yasno` resolves the captured effective region/provider names against
Yasno's official `/addresses/v2/regions` response. Existing numeric street/house
IDs are checked through `/addresses/v2/group`. A group-only entry has no
recoverable household address; the operator must choose the actual street and
house privately. The script uses only fixed official HTTPS GET endpoints and
never changes HA. Query text is passed from private files rather than argv.

First determine which branch applies without displaying private entry data:

```sh
if jq -e --arg id "$YASNO_ENTRY_ID" '
  [.data.entries[] | select(.domain == "yasno_outages" and .entry_id == $id)] |
  if length == 1 then (.[0].data + (.[0].options // {}) |
    [.street_id,.house_id] | all(type == "number" and . > 0 and floor == .))
  else false end' "$migration_snapshot/.storage/core.config_entries" >/dev/null; then
  "$TOOLS" collect-yasno --snapshot "$migration_snapshot" --entry-id "$YASNO_ENTRY_ID" \
    --output "$YASNO_EVIDENCE"
else
  printf 'This entry needs explicit private address selection; run the next block.\n'
fi
```

For that group-only branch, enter the exact street search and house number in
silent prompts. Select IDs only from the actual returned candidates:

```sh
IFS= read -rs -p 'Street search text: ' yasno_street_query; printf '\n'
printf '%s' "$yasno_street_query" > "$migration_private_dir/yasno-street-query"
unset yasno_street_query
IFS= read -rs -p 'House number/search text: ' yasno_house_query; printf '\n'
printf '%s' "$yasno_house_query" > "$migration_private_dir/yasno-house-query"
unset yasno_house_query
jq -n --rawfile street "$migration_private_dir/yasno-street-query" \
  --rawfile house "$migration_private_dir/yasno-house-query" \
  '{street_query:$street,house_query:$house}' > "$migration_private_dir/yasno-queries.json"
selection_status=0
"$TOOLS" collect-yasno --snapshot "$migration_snapshot" --entry-id "$YASNO_ENTRY_ID" \
  --output "$YASNO_EVIDENCE" --query-file "$migration_private_dir/yasno-queries.json" \
  || selection_status=$?
test "$selection_status" -eq 3
jq '[.[] | {id,value}]' "$YASNO_EVIDENCE/yasno-streets.json"
read -r -p 'Exact street ID from the correct result: ' street_id
jq -n --arg street "$street_id" '{street_id:($street|tonumber)}' \
  > "$migration_private_dir/yasno-selections.json"
selection_status=0
"$TOOLS" collect-yasno --snapshot "$migration_snapshot" --entry-id "$YASNO_ENTRY_ID" \
  --output "$YASNO_EVIDENCE" --query-file "$migration_private_dir/yasno-queries.json" \
  --selection-file "$migration_private_dir/yasno-selections.json" --resume \
  || selection_status=$?
test "$selection_status" -eq 3
jq '[.[] | {id,value}]' "$YASNO_EVIDENCE/yasno-houses.json"
read -r -p 'Exact house ID from the correct result: ' house_id
jq --arg house "$house_id" '. + {house_id:($house|tonumber)}' \
  "$migration_private_dir/yasno-selections.json" > "$migration_private_dir/yasno-selections.next"
mv "$migration_private_dir/yasno-selections.next" "$migration_private_dir/yasno-selections.json"
"$TOOLS" collect-yasno --snapshot "$migration_snapshot" --entry-id "$YASNO_ENTRY_ID" \
  --output "$YASNO_EVIDENCE" --query-file "$migration_private_dir/yasno-queries.json" \
  --selection-file "$migration_private_dir/yasno-selections.json" --resume
```

Exit 3 means the explicitly named selection is pending. Any other failure stops
this branch; inspect the fixed diagnostic and saved candidate file. The script
refuses IDs absent from the exact official street/house response. Never guess
an address from an outage group or pick the first candidate automatically.

Both branches now produce the same validated inputs for bootstrap:

```sh
"$TOOLS" prepare-yasno --snapshot "$migration_snapshot" --entry-id "$YASNO_ENTRY_ID" \
  --address-file "$YASNO_EVIDENCE/yasno-address.json" \
  --regions-file "$YASNO_EVIDENCE/yasno-regions.json" \
  --official-group-file "$YASNO_EVIDENCE/yasno-official-group.json" \
  --existing-secrets "$migration_private_dir/secrets-before-yasno.yaml" \
  --output "$migration_private_dir/secrets.yaml" \
  --plan "$migration_private_dir/yasno-name-plan.json"
```

The helper requires the official group to match the captured integration and
all nine unique-ID suffixes, with neutral names, enabled bindings and no name
conflicts. It preserves unrelated secret keys and existing preferences,
including `false`. If it emits a rename plan instead of a secret, inspect:

```sh
jq '.entity_name_map[] | select(.old_entity_id != .new_entity_id or .name_conflict or .disabled_by != null)' \
  "$migration_private_dir/yasno-name-plan.json"
```

For each differing row, open the exact `old_entity_id` in HA Settings → Devices
& services → Entities → Settings, change Entity ID to the exact `new_entity_id`,
then Save. Resolve an occupied target by inspecting its actual owning entry;
never delete an unrelated entity. Re-enable a required binding only after
confirming its ownership. Do this on the original controller before final
capture, verify affected dashboards/callers, then recapture and rerun with fresh
output paths. Preserve the failed plan privately; do not overwrite evidence.

If the official group differs, open the existing Yasno integration's
Reconfigure flow: retain region/provider, choose group method, select the exact
saved official `group.subgroup`, and preserve scan interval/filter/all-day
preferences. Wait for all nine entities to load, verify their names, and
recapture. A missing/changed suffix is a pinned-component schema mismatch;
inspect that component before mapping anything. The helper performs no rename.

The journal is `/var/lib/hass/yasno-address-guard/journal.json`; retain an
existing transaction journal at that path before enabling the app. Numeric IDs
and every saved response remain private. Re-run the guard's section 12 dry run
after startup: saved API responses establish bootstrap evidence, not a promise
that groups or schedules never change.

### Native, after endpoint flows: Glances

Start a new Bash session if necessary and reconstruct only persistent paths:

```sh
set -euo pipefail
TOOLS=/nix/var/nix/gcroots/ha-migration-tools/bin/home-assistant-migrate
OP=/var/lib/ha-migration
jq() { "$TOOLS" tool jq "$@"; }
cold_status=0
"$TOOLS" cold-audit "$OP/glances-cold" --execute || cold_status=$?
test "$cold_status" -le 1
map_status=0
"$TOOLS" glances-map --plan "$OP/native-plan.json" --receipt "$OP/reconcile-receipt.json" \
  --snapshot "$OP/glances-cold/homeassistant" --output "$OP/glances-name-map.json" \
  || map_status=$?
test "$map_status" -eq 0 -o "$map_status" -eq 3
jq '.[] | {old_entity_id,replacement_entity_id,target_entity_id,status}' "$OP/glances-name-map.json"
```

`cold-audit` installs a restart trap, stops controllers, copies HA, audits, and
restores services on exit. Its first exit 1 can include the deliberately retained
old Glances endpoint or not-yet-removed Supervisor entry; inspect the report for
other findings. Exit 2 means invalid input or failed service recovery and must
be corrected before proceeding. It is not the required clean final audit. Do not read or modify
`.storage` behind a running controller for this copy.

The mapping helper checks the receipt against the exact native plan hash. It
matches old/new Glances unique-ID suffixes; it does not guess from display
names. Exit 3 lists exact missing/ambiguous metrics as
`requires_metric_decision`. This is a low-confidence hardware boundary: native
Glances can expose different filesystems, interfaces, containers and processes
from HAOS. For each flagged old entity, record a verified equivalent replacement
metric or retire that exact metric and update each dashboard/automation caller.
Do not rename an unrelated metric merely to clear the list.

Once every retained old metric has a verified map, open Settings → Devices &
services → Glances, identify the old entry by its captured ID/server, and remove
**that old entry only**. Its names are now free. For each exact match, open
Settings → Devices & services → Entities, search `replacement_entity_id`, open
Settings, change Entity ID to the exact `target_entity_id`, and Save. Restore
intentional disabled states, areas, labels and display overrides from the
captured registry. Assign the replacement device to its old area; replace
callers of the old device UUID because sensor renames do not preserve device
identity. Verify retained history and long-term statistics in the preserved
recorder; a matching display name is not proof.

Remove the obsolete Supervisor integration after replacements work, then return
to section 11's clean `after-reconciliation` cold audit. Every required reference
and endpoint finding must be resolved before physical acceptance.
