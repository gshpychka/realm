# Home Assistant on the Raspberry Pi 5

This is a proposed, branch-only migration. **The implementation task authorizes
local code and offline validation only. Installation, reflash, HA changes,
restarts, cutover and deployment require a separate operation.** The installation,
restore and backup sections below describe that future owner-authorized work.
Do not run the backup script on the current host: it deliberately stops services
on a future native NixOS installation.

## What is declared

`nixosConfigurations.home-assistant` defines the existing 4GB Pi 5 with its Samsung
SSD 980 NVMe, Ethernet DHCP/IPv6, Bluetooth, SSH and firmware-generation bootloader.
The OS timezone matches the existing HA timezone, `Europe/Kyiv`, including the
native backup timer's local 03:30 schedule.
The Pi project's pinned NixOS 26.05/kernel/firmware set is kept together. The fleet
nixpkgs supplies HA 2026.10.2 with its matching frontend and aiohttp patch, custom
integration dependencies, HA MCP 8.7.0. Matter.js 1.4.0 runs in its upstream digest-pinned ARM64 container,
matching the current HAOS Matter app 9.2.0. No other machine's
package set or runtime configuration is changed.

MCP runs in a separate Python environment. Its 8.7 vendored server dependencies
are declared explicitly, including exact dotenv/Monty versions and uv_build
0.12.17. Official upstream wheels have hashes for x86-64 and ARM64 in
`packages/home-assistant/sources.json`; the Monty wheel matches Python 3.14.
The complete upstream requirements are recorded in `mcp-requirements.json`,
and native metadata checks keep their constraints enabled.

The declaration contains 51 automations, all eight script definitions (four active
and four registry-disabled), two scenes, one input boolean, one input button and
two persistent timers. UI-created template/min-max/filter/switch helpers remain
config-entry state so their unique IDs and consumers survive. The complete
92-entry classification is in `machines/home-assistant/integration-coverage.json`.

All 20 installed custom component source trees are pinned as a reproducible source
archive. `components.json` records upstream repositories, installed revisions,
manifests and individual file hashes. Its Python requirements are provided through
the HA package, including the three packages absent from nixpkgs. The archive is
code, not a copy of `.storage` or the HA configuration directory. HACS and
FontAwesome code are retained; dashboards/themes/resources are optional and are
not restored by the offline preparation helper. Store-backed component updates
must be made through Git/Nix, rather than an HACS UI update that tries to replace
an immutable directory.

The archived Dyson vacuum module needs a narrow compatibility patch for HA's
`VacuumActivity` API and two references to a state absent from its bundled vendor
enum. `packages/home-assistant/component-patches.json` records the original and
patched file hashes. Installation and offline validation consume the same patched
source derivation; the inspection archive and its provenance hashes stay intact.
There are no Dyson vacuum entities in the baseline, and the active fan code is
unchanged. The offline check also exercises the patched activity/state contract
with inert values. Asusrouter, Dyson and Victron emit future deprecation notices;
their current imports pass, but a future Core upgrade needs renewed validation.

Automation aliases have consistent category prefixes. Numeric automation IDs,
script keys, scene IDs and existing device/entity identities remain stable.
Null script-selector configurations use equivalent empty mappings so the NixOS
YAML renderer preserves their date/time/text selector types.
`automation-map.json` maps aliases; `entity-map.json` covers all 1,864 registry
entities, including 1,058 disabled entries. Supervisor/HAOS management entities
have a null target and an explicit reason. The guard source is preserved verbatim;
its residential configuration and recovery journal remain private runtime state.

## Access verification and build checks

On 2026-10-19 this worker itself completed strict pinned-known-hosts SSH through
the existing TPM agent, and performed MCP initialize, tools/list and
`ha_get_system_health` against the existing admin route. No HA action tool was
called. Native Codex MCP tools were not registered; direct read-only protocol
access used the existing inherited private path in memory. The minimal native
integration fix is for the ACP client to forward the existing OpenClaw
`home-assistant-admin` server through `session/new.params.mcpServers`, using an
HTTP entry (`type`, `name`, resolved `url`, existing `headers`) when the agent
advertises HTTP MCP support. Resolve the existing route's environment values
privately; do not invent a URL suffix or a new credential. Confirm attached tools
and a successful read in a fresh worker before claiming native registration.
The [ACP session setup specification](https://github.com/agentclientprotocol/agent-client-protocol/blob/main/docs/protocol/v1/session-setup.mdx)
defines that field; it is distinct from a Codex TOML `mcp_servers` table. This is
a worker/client setup change. Main Telegram remains OpenClaw.

Safe local commands, with all new files first added to Git:

```console
nix develop .#home-assistant-migration --max-jobs 1 --cores 1 --builders ''
nix eval .#nixosConfigurations.home-assistant.config.system.build.toplevel.drvPath --raw --max-jobs 1 --cores 1 --builders ''
nix build .#checks.x86_64-linux.home-assistant-config --no-link --max-jobs 1 --cores 1 --builders ''
nix build .#nixosConfigurations.home-assistant.config.system.build.toplevel --no-link --max-jobs 1 --cores 1 --builders ''
```

The named shell supplies Python/PyYAML, Mosquitto's offline utility and age.
It has no activation hook. Run the offline helpers from this checkout; private
inputs/outputs must be outside every Git worktree and the Nix store. Existing
private output directories must be mode 0700; the exporter never changes their
permissions or replaces existing credential files.

Run `verify.py` with the protected inventory and private generated secrets for
semantic/reference/state checks. `validate-ha.py` uses the actual HA schemas,
imports every custom component, checks every manifest requirement and blocks
network connections. It never calls integration setup or executes automations.
It constructs an unstarted HA object to supply the real schema context and honors
each component's import-executor setting; HA remains in its `not_running` state.
The same check runs MCP's early `--version` entrypoint with a clean environment and
`validate-mqtt.py` with synthetic HA/external-client records: official password
hashing, owner-only output, overwrite/conflict rejection and Mosquitto's
`--test-config`. It never starts a broker listener.
MCP packaging also imports its HTTP/server/settings modules, checks every
applicable upstream dependency constraint and verifies that its strict
best-practices gate is effective with synthetic settings and blocked networking.
The guides are fetched at the exact skills submodule revision in the 8.7 tag;
the release source archive alone omits them. No acknowledgement key is requested.
See [the recorded validation results](../../machines/home-assistant/validation-results.json)
for actual results and limits; a successful build
does not prove physical boot, radio connectivity, pairing, provider login or
cooling behavior. Do not run a global flake check on hoard.

The local offline Nix check passed with HA 2026.10.2, 116 imported custom modules
and 21 custom manifest requirements. The Pi target evaluates, but the attempted
full local build failed with `platform mismatch`: it requires `aarch64-linux`,
while hoard provides `x86_64-linux` without ARM emulation. No remote builder was
used. Complete that build on an authorized ARM64 builder or separately authorized
local emulation before installation. The Matter image was checked through
registry metadata only; it was neither pulled nor run.

## Protected handover, before any future installation

The inventory in `/var/lib/openclaw/workspace/ha-migration-private-inventory` is
an inspection snapshot, not an atomic recovery backup. It lacks HA auth state,
recorder/Zigbee databases, Matter fabrics, private outbound SSH authority and the
guard journal. Its presence does not satisfy the handover checklist.

An owner-authorized future operation must first make and test an encrypted,
consistent HAOS/Supervisor backup on independent media. Stop/quiesce the relevant
services as part of that future backup, or use their documented consistent backup
APIs; include SQLite WAL content in the database snapshot. Retain the original
NVMe untouched until a restore has been demonstrated on separate media. Archive
the existing versions, boot/EEPROM settings, address/MAC/DNS, radio details and SSH
server host keys privately. Never copy TPM private keys or generate replacement
client keys as a shortcut.

The backup must cover:

| State | Requirement |
| --- | --- |
| HA identity/auth | `.storage/core.uuid`, `auth*`, HTTP/users/token state, application credentials and the entire reviewed integration/registry state. Existing tokens depend on these. |
| Integrations/helpers | All config entries, disabled/ignored flags, device/entity/area/category registries, storage helpers, voice pipelines, Assist exposure, mobile/cloud/Google/SmartThings/ESPHome/HomeKit/Thread state and shopping-list/energy state. Preserve unknown integration storage from the consistent backup, not just the inspection allowlist. |
| ZHA | Consistent `zigbee.db` and coordinator backup; same Ethernet ZNP endpoint `socket://192.168.1.149:6638`. Never let two HA instances control this coordinator concurrently. |
| Matter/Thread | Stopped Matter server fabric/data directory, PAA/OTA requirements and Thread datasets. Restore at `/var/lib/matter-server` with numeric ownership `1000:1000`, matching the pinned unprivileged image; it is mounted at `/data`. Keep IPv6, mDNS and the external border router working. |
| MQTT | Persistent `/var/lib/mosquitto` data and credentials for **all** clients. The old app has zero explicit logins and delegates authentication to Supervisor/HA; its authentication backend cannot simply be copied into native Mosquitto. Provision a compatible hashed password file for every actual client. The persisted HA client username/password can be reused privately. |
| Yasno | Existing config entry and nine entity bindings, private address/options, full app source, transaction journal including pending rollback. Journal goes to writable `/var/lib/hass/yasno-address-guard/journal.json`; source stays immutable. |
| Outbound SSH | Existing authorized HA private key and trusted reaper host keys, provisioned as `/var/lib/hass/.ssh/outbound_key` and `known_hosts` with hass-only access. Strict host checking is now required. The inspection export intentionally did not contain this key. |
| SSH server identity | Original server host keys from the SSH app's protected backup; restore at `/etc/ssh/ssh_host_*_key` before SSH starts and verify against independent known-hosts fingerprints. Native backups store these under `ssh-host-keys/` with mode 0600. |
| Bluetooth | Review the old host's `/var/lib/bluetooth` adapter/bond state and restore it with root-only access while Bluetooth is stopped, or confirm there are no bonds to transfer. BLE sensor bind keys in HA config entries are separate state. Native backups include this directory. |
| Tailscale | Transfer its existing native-compatible daemon state while the old node is stopped, or explicitly approve reauthentication. No auth key or duplicate node is created by this branch. |
| HA admin MCP | Standalone HA admin long-lived token, existing private URL path and equivalent tool/security options. Supervisor tokens are not portable. Issue/provision a suitable token only in the separately authorized restore operation. Keep its path and settings out of logs. |
| Backups | Owner-controlled restic password/repository, independent recovery copy of that password, optional rclone Google Drive OAuth config and a verified restore. Existing Google Drive app data/credentials are not automatically a native rclone configuration. |

Keep all secret-bearing files outside Git and `/nix/store`. Encrypt backup and
handover artifacts in transit and at rest, and protect native runtime files with
the permissions below. The generated private `secrets.yaml` is an owner-only
handover artifact outside Git, not a deployable recovery backup. Provision its
final contents at `/var/lib/private/home-assistant/secrets.yaml` (0700 directory,
0600 file). Systemd passes it as a credential; HA gets a runtime symlink. An
external SOPS-encrypted file may be decrypted directly into that protected path
by the future operator; never make the plaintext a Nix input or `writeText` value.
The app dictionary remains a dictionary under the `yasno_address_guard` secret.

`prepare-state.py` is an offline tool for a **new** destination tree outside Git.
It refuses changed entry inventories, source symlinks, existing destinations,
store paths and SQLite sidecars requiring consistency review. It preserves
credentials/identities/inactive states, removes the two Supervisor/HAOS entries,
rewrites MQTT and Matter endpoints, clears Matter's Supervisor add-on flags and
removes storage duplicates of YAML helpers. An unset/random DLNA DMR event port
is pinned offline to TCP 32100 (an existing explicit port is retained). The
firewall reads that port and HomeKit's existing TCP 21064 from the coverage rows.
SSDP advertisements on UDP 1900 and unicast replies from that source port on
`end0` are allowed for IPv4 and IPv6; mDNS remains on UDP 5353.
It deliberately never creates
`.migration-ready`, even with `--consistent-stopped-backup`. Review its private
readiness report and separately provision all missing items before acceptance.
It is not a backup extractor or an installation/deployment program.
It copies reviewed `.storage` files and the two consistent databases only.
Audit and transfer other persistent integration files, cloud state, certificates
and any referenced local media from the full protected backup separately. Do not
restore the old `deps` Python environment over the declared packages.

Native Mosquitto loads `/var/lib/private/home-assistant/mosquitto-passwords`, a
complete Mosquitto-format hashed password file, through systemd credentials. Do
not use `mosquitto_passwd -b` with a real password on a command line; construct a
0600 temporary input privately and use its offline `-U` conversion, or the
documented interactive tool during the future provisioning operation. Preserve
all client identities/ACL intent, verify external clients and fail closed until
this is complete.

`prepare-mqtt.py` can produce this file offline from the imported HA broker login
and an additional protected JSON list of client username/password records. It
uses the official utility with a private temporary file and puts no password on
its command line. Its report distinguishes an owner-acknowledged complete client
inventory from an HA-client-only export. It never changes a running broker or
marks a host ready.

Native HA MCP loads `/var/lib/private/home-assistant/ha-mcp.env`. It must contain
`HOMEASSISTANT_TOKEN`, `MCP_SECRET_PATH` (including its leading slash) and the
equivalent upper-case settings from the installed app's options, including
`READ_ONLY_MODE`, `REDACT_SECRETS`, the tool policy/search flags, backup options
and mandatory best-practices flags. Use the pinned upstream `config_settings.py`
aliases to validate the mapping. The future service runs `ha-mcp-web` on port
9583 and points to local HA. Its application output is suppressed because
upstream startup/access logs may contain the credential-bearing URL. No token
or private path is encoded in Nix or passed on its command line.

The protected exporter also writes `ha-mcp-settings.env` outside Git with the
existing path and app options mapped to those aliases. It intentionally has no
admin HA token. Review it and add the appropriate token privately during the
future restore, then provision it at the native environment-file path.
`verify_ssl` maps to `HA_VERIFY_SSL`. The legacy custom-instructions option is
currently empty and is not a native 8.7 setting; the exporter refuses a nonempty
value pending explicit porting review. Original options are also retained in a
protected JSON sidecar.

## Future installation and acceptance (not executed)

After separate authorization, prepare **separate replacement media**, verify its
identity/capacity, and use the maintained Pi5 installer compatible with the pinned
input. A future layout uses a suitably sized FAT firmware partition labelled
`HA_FIRMWARE` (allow space for multiple generations; 1–2 GiB) mounted at
`/boot/firmware`, and an ext4 root labelled `HA_NIXOS` using the remaining space.
There is no USB Zigbee stick, SATA root or assumed reusable HAOS root partition.
No partitioning/formatting command is provided as part of this task.

Install the built target only during that future operation. Keep the current
EEPROM/boot-order information and recovery media; do not update EEPROM just to
try the branch. The chosen upstream `kernel` bootloader retains NixOS generations.
Check kernel, initrd, firmware and generation-specific DTBs/overlays on the future
firmware partition. Restore the protected handover into the installed root while
HA/Matter/MQTT are stopped, restore ownership, and validate its consistency report.
Restore the original SSH server host keys privately at the native OpenSSH paths
(`/etc/ssh/ssh_host_ed25519_key` and, if retained, `/etc/ssh/ssh_host_rsa_key`)
with root ownership and mode 0600 before starting SSH. Compare their public
fingerprints with the independent existing known-hosts record; do not accept a
replacement host identity as a shortcut.
Keep hostname `homeassistant`, DNS and the MAC-based lease at `192.168.1.212` so
existing clients/OpenClaw need no URL changes. The verified wired MAC is pinned to `end0` by a link declaration. The matching
harbor DHCP reservation is part of this branch and must be applied only in the
separately authorized network cutover. Verify the resulting name/address before
enabling HA. Wi-Fi stays disabled; IPv6/RA and multicast stay enabled.

Only the future operator can create `/var/lib/hass/.migration-ready` after state
review and approval for the first controlled startup. Confirm no old HA instance
can reach the radios/broker. Test boot/generation rollback, wired DNS/address,
Bluetooth and BLE, ZHA identity/devices, Matter fabrics/Thread/IPv6, MQTT retained
messages and **every external client**, HomeKit/mobile/cloud/Google callbacks,
all active integrations and five voice pipelines, all helpers, four active
scripts, scenes and automation enabled states. Exercise automations only under
separate owner authorization, with real actuators/provider side effects accounted
for. Do not use an unrestricted config-check startup as a test shortcut.

Validate the Argon V3 controller on `/dev/i2c-1`, address `0x1a`, its full-speed
startup/failure behavior and the 55–75 C curve, then confirm
`sensor.argon_one_addon_fan_speed`. This native implementation does not assert
the stock Pi4 `bcm2711` overlay works on Pi5. The case power-button protocol is a
separate unimplemented feature without current evidence that the old cooling
app provided it. Do not leave the board unattended until cooling is proven.

Plex's current `setup_error` and the integration-disabled
`conversation.voice_broker_home` referenced by a voice pipeline are baseline
issues, not newly introduced successes or regressions. Preserve them for explicit
owner review; a successful schema build does not repair those integrations.

Google Drive app/Supervisor UI backup management is replaced with native restic
and optional rclone transport. Provision the three `restic-*` files under the
protected private directory and any rclone config there, then prove a restore to
a new offline directory. The backup script briefly stops HA, MCP, Matter, MQTT
and Tailscale plus Bluetooth, snapshots their protected state and SSH server
host keys, checks the SQLite copies and
restores only services previously active. Review incomplete `.next` snapshots;
it will not overwrite them. The daily timer is gated by the owner-created
`/var/lib/private/home-assistant/.backup-enabled` marker. Creating that marker,
arming backups and test outages are outside this implementation task.

Read-only state lookups also confirmed four pre-existing missing references:
`media_player.home_assistant_voice_media_player` in the active moment-of-silence
announcement and `media_player.all_hearing_god` in the active water-leak alert,
plus `input_button.hoard_power` and `conversation.chatgpt_search` in disabled
definitions. Review the intended current speakers before future acceptance.
No destination was guessed and no live alert was exercised. All literal device
references resolve when 2026.10 composite IDs are included; `device-map.json`
records their identities alongside the entity map.

Do not automatically restore `.migration-ready` or `.backup-enabled` markers from
a backup. Create them again only after reviewing the restored state and acceptance.

## Future rollback

Before cutover, keep the original HAOS NVMe and a tested encrypted consistent
backup on independent media. For OS/boot failure, power down the new instance,
prevent duplicate HA/radio access, restore the original media and documented
boot order, and verify the old address and known SSH host identity. Never run
both installations with the same ZHA coordinator or Matter fabrics.

For a NixOS-only regression, choose a retained firmware generation and restore
the matching stopped-service **state snapshot** if HA/Matter/schema versions
changed. A NixOS generation rollback does not roll back databases, config-entry
migrations, radio state, OAuth/pairing changes or remote actions. Never open
2026.10.2 state with the original 2026.10.1 package. If target tests altered device
or provider state, follow the separately reviewed radio/provider rollback plan;
restoring files cannot undo an external action. Preserve failed target state
privately for diagnosis before replacing it.

## Sources

The [Pi project's maintained usage and bootloader documentation](https://github.com/nvmd/nixos-raspberrypi)
defines the selected Pi5 modules and generation-aware kernel boot method. The
[HA 2026.10.2 release](https://github.com/home-assistant/core/releases/tag/2026.10.2)
and its pinned manifests/requirements supply the matching Core/frontend update.
The [HA MCP source](https://github.com/homeassistant-ai/ha-mcp/tree/v8.7.0)
documents its native external-Core deployment and environment settings. Local
component and state evidence is recorded per integration; private snapshots are
never substituted for a consistent disaster-recovery backup.

The [DLNA DMR options](https://www.home-assistant.io/integrations/dlna_dmr/#options)
document a fixed event-listener port for firewalls; otherwise it is random.
The pinned Core's DLNA implementation consumes the preserved entry's
`options.listen_port` without requiring a new device identity.

The [installed V3 add-on's upstream control code](https://github.com/adamoutler/HassOSArgonOneAddon/blob/fb3c5c94724989cd8d1dd9edb563a872f8a34fbc/argonOneV3Linear/run.sh)
provides the V3 register `0x80`, integer Celsius curve and transient fan sensor
contract. Physical bus routing is still an acceptance requirement.

[Raspberry Pi's PCIe documentation](https://www.raspberrypi.com/documentation/computers/raspberry-pi.html#pcie)
supports explicitly enabling the external PCIe interface for a board without
HAT+ auto-detection; this target declares `dtparam=pciex1` for its NVMe disk.

Matter.js uses the same upstream 1.4.0 runtime as HAOS app 9.2.0; the old
nixpkgs Python Matter 8.1.2 service is deliberately not enabled. The image index,
ARM64 digest, UID and entrypoint were verified without running it. Host networking,
IPv6 and ping sockets support Thread operation; the WebSocket binds only to
loopback. BLE commissioning goes through HA's supported BLE proxy endpoint,
avoiding raw HCI privileges in the container. Validate this route during physical
acceptance. `time_sync=auto` is preserved by checking host NTP synchronization
at each start. The native service alias remains `matter-server.service` for
backup and ordering. Public pin evidence is in `packages/home-assistant/matter-image.json`.

[The add-on 9.2.0 build](https://github.com/home-assistant/addons/blob/master/matter_server/build.yaml)
pins Matter.js 1.4.0. [Upstream container instructions](https://github.com/matter-js/matterjs-server/blob/main/docs/docker.md)
define its storage/UID/environment options. No container, pairing or fabric
migration was run by this task; pulling the pinned image is deferred to the
separately authorized first start.
