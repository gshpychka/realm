# Migration readiness and cutover

The migration is feasible as a NixOS-managed system with persistent Home Assistant
state. It is not a reproducible reconstruction of the home from Git alone. A
successful schema check is not permission to replace the running controller.

## Ownership

| Concern | Source of truth | Recovery/update mechanism |
| --- | --- | --- |
| OS, kernel, firmware, services | Nix and flake.lock | Build and switch a generation |
| HA, integrations, Python dependencies, Matter image | Nix package definitions | Reviewed source updates and builds |
| Automations, scripts, scenes, YAML helpers/templates | Nix configuration | Edit Nix; keep original automation/scene IDs |
| Integration config entries, OAuth tokens, pairing/fabric keys | HA and Matter writable state | Preserve a consistent private snapshot; use HA config/reconfigure/options flows |
| Entity/device/area registries, dashboards, Assist pipelines | HA writable state | Restore together and verify references |
| Service credentials and outbound SSH identity | Privately provisioned runtime files | Protected recovery copy; never Git or the Nix store |
| Enabled states and history | HA restore state and recorder database | Preserve and verify after cutover |

HA's [configuration policy](https://developers.home-assistant.io/docs/configuration_yaml_index/)
requires config flows for most device/service integrations. Adding more Nix
options does not remove that boundary. Do not generate `.storage` registries or
replay setup flows on every boot. Device discovery, interactive authentication,
and pairing are stateful operations; use the supported UI when changing them.

This PR uses the community-maintained native NixOS/Core installation. Upstream
HA [ended support for the Core installation method after 2025.12](https://www.home-assistant.io/blog/2025/05/22/deprecating-core-and-supervised-installation-methods-and-32-bit-systems/).
Its supported choices are HAOS and Container. Native packaging remains possible,
but this repository owns Python compatibility and integration packaging. A future
switch to HA Container could reduce that packaging work; it would still need
the same private state and replacement services for Supervisor apps. There is no
Supervisor on this NixOS host, and HAOS app/ingress/update controls do not migrate.

## Current release gates

- Build the complete aarch64 system and installer. Evaluating a derivation is not
  a complete build. Linux config QA runs on either x86 or ARM and does not force
  an x86 closure into the Pi installation.
- Boot separate media and prove Pi firmware, NVMe, networking, Bluetooth and
  Argon cooling. The case power-button/shutdown protocol is not implemented.
- Obtain a stopped, consistent private recovery copy with authentication,
  databases, Matter fabrics, MQTT state and outbound SSH keys. The inspection
  export used to author this PR lacks these and cannot reconstruct the home.
- Run the private snapshot preflight below; reconcile missing references and
  Supervisor endpoints through HA. Review known pre-existing Plex and disabled
  conversation-integration failures separately from migration regressions.
- Prove a restore and physical acceptance. No build or offline test establishes
  radio pairing continuity or the capabilities of a device target.

## Build and offline checks

```sh
nix build .#checks.x86_64-linux.home-assistant-config --no-link
# Or use checks.aarch64-linux.home-assistant-config on an ARM builder.
nix build .#nixosConfigurations.home-assistant.config.system.build.toplevel --no-link
nix build .#packages.aarch64-linux.home-assistant-installer
```

The last command produces an SD installer image from the pinned Pi module set.
The image is `result/sd-image/nixos-installer-rpi5-kernel.img.zst`; decompress it
and write it to the selected separate SD card. Its root SSH access uses the
fleet main key and disables password authentication.
Boot that image from separate media. Identify the replacement NVMe by its actual
device identity before partitioning it. The host expects ext4 label `HA_NIXOS`
and FAT label `HA_FIRMWARE`, mounted at `/` and `/boot/firmware`. Keep the original
HAOS/NVMe untouched for rollback. Once the new filesystems are mounted at `/mnt`
and `/mnt/boot/firmware`, install with:

```sh
sudo nixos-install --flake .#home-assistant --no-root-passwd
```

Use an ARM builder or configured remote ARM builder for ARM outputs. The image
build and installation do not establish the physical acceptance gates above.

## Private snapshot preflight

Run against an unpacked private copy of HA's configuration directory, never the
live controller directory. The app bundles the current public declarations and
only reads the copy; it neither connects to HA nor rewrites state.

```sh
nix run .#home-assistant-preflight -- /private/recovery/homeassistant
```

The JSON report identifies absent/invalid registries and authentication, missing
recorder/SSH state, disabled/missing entity references, absent device/area targets,
old Supervisor/add-on DNS names and automation/scene identity review. It excludes
raw config-entry values and credential-bearing URLs. Exit 1 means known blockers;
exit 0 means no checked blockers and **still requires acceptance**. Invalid input
exits 2. Reports contain public entity references, but private snapshots remain
sensitive and must not be committed or supplied to Nix evaluation.

Non-registry entities can be evidenced by `.storage/core.restore_state`; a record
does not prove current availability. The audit checks literal entity references
and entity constants used by declarations, not arbitrary dynamically constructed
Jinja references. It cannot validate device capabilities, nondefault recorder
databases, MQTT client credentials, Matter fabrics, or completeness/consistency of
the snapshot. Those are operator acceptance work. An intentionally omitted
history/key file will need an explicit recovery decision; the checker does not
silently waive it.

## Preserve and adapt state once

1. Before collecting the final copy, record HA/Core and Matter versions. Stop
   HA and the relevant app controllers for consistent capture. Keep a tested,
   encrypted recovery backup, and preserve the original media. Never run two
   controllers against the same Zigbee/Matter devices.
2. Copy the complete HA directory to `/var/lib/hass`, preserving hidden files,
   authentication, registries, integration entries, dashboards, Assist pipelines,
   recorder DB/WAL files and writable Pyscript journal. Assign its files to the
   evaluated native `hass` user/group; HAOS numeric owners may differ. Preserve
   service-specific ownership for the other native state directories.
3. Keep restored runtime registries intact. Original IDs are declared for all 45
   active automations and both scenes so HA can reuse their existing identities.
   Removed inactive definitions may leave obsolete registry records; review them
   through HA. Verify `scene.night`, `scene.tv_watching`, automation enabled states,
   dashboard links and external callers. Renames in the private registry still
   require reconciliation; IDs alone do not undo user entity-name changes.
4. Remove copied executable/configuration sources from the **new staging copy**
   after preserving recovery: old `configuration.yaml` and `secrets.yaml`, the
   copied `custom_components` tree, and the old
   `pyscript/apps/yasno_address_guard` code. The startup guard refuses these
   conflicting files before the native module can overwrite them.
   Nix installs the declared sources. Do not delete `.storage`, YAML files used
   only by dashboards, private credentials, history, media or the Yasno journal.
   Review additional custom integrations/frontend resources absent from the PR
   rather than silently discarding them or continuing with unmanaged code.
5. Restore compatible Matter server state to `/var/lib/matter-server` with owner
   `1000:1000`, MQTT state to the evaluated broker directory/user, and compatible
   Tailscale/Bluetooth state or explicitly reauthenticate. Do not confuse an HA
   config entry with Matter's fabric state. Server implementation/version changes
   need an upstream-supported state migration and a tested recovery path.
   Matter.js [documents its Python-server import format](https://github.com/matter-js/matterjs-server/blob/v1.4.0/docs/cli.md#storage-format);
   importing requires the complete old `/data`, not just an HA integration entry.
6. Replace Supervisor-only config-flow connections through HA's reconfiguration
   or options UI, preserving entry/device IDs. The declared endpoints are MQTT
   `127.0.0.1:1883`, Matter `ws://127.0.0.1:5580/ws`, and Glances
   `127.0.0.1:61208`; check the fields expected by each integration. Remove the
   obsolete Supervisor integration. HA's Bluetooth stack provides the configured
   Matter BLE proxy. Review native callback URLs and OAuth reauthentication.

The host extends UDP connection tracking to 3,600 seconds, as
[recommended by the pinned Matter server](https://github.com/matter-js/matterjs-server/blob/v1.4.0/docs/os_requirements.md#stateful-firewalls-host-vm-hypervisor).
Matter uses ephemeral UDP ports; opening only UDP/5540 is insufficient. Verify
Thread border-router route advertisements/OMR routes and reports from sleeping
devices across a complete reporting interval. The host keeps stateful filtering;
any additional prefix rule needs the actual private Thread prefix.

The unresolved `roomVoiceTarget`, `kitchenVoiceTarget` and `reaperWakeTarget` must
exist in the copied registry **and support the intended actions**. Check the
voice device fan-out, room/kitchen area assignments and wake target in HA. The
preflight does not select replacement devices or exercise alert actions.

## Provision native credentials

Provision `/var/lib/private/home-assistant` as root-only; never pass these files
as Nix inputs. The service units intentionally fail if required files are absent.

| Runtime file | Required content |
| --- | --- |
| `secrets.yaml` | `soundbar_api_key` and complete private `yasno_address_guard` app configuration, including its journal path/entity bindings |
| `ha-mcp.env` | Standalone HA admin token, secret MCP path and settings expected by the packaged server; Supervisor authority cannot substitute for a native HA token |
| `mosquitto-passwords` | Mosquitto-compatible hashes for HA **and every MQTT client**; replace Supervisor-authenticated clients |
| `restic-repository`, `restic-password`, `restic-environment` | Repository/destination authentication; initialize the repository separately and test a restore |

Also preserve `/var/lib/hass/.ssh/outbound_key` and pinned `known_hosts`, with
access restricted to HA. Native HA receives `secrets.yaml` through systemd
credentials. Replacing the Google Drive backup app requires a separately
provisioned restic destination; its app credentials/UI are not portable.

## Acceptance and rollback

Before retaining the new controller, verify the Pi boots a second time and can
switch generations; NVMe, IPv6/multicast, cooling and Bluetooth work; ZHA and
Matter retain devices; all MQTT clients reconnect; native integrations and OAuth
callbacks work; five Assist pipelines and both Voice PEs have their intended
behavior; retained automations preserve enabled states; and alerts/media/SSH
actions work with the intended targets. Test restic capture and restoration,
including ownership and the private credentials. Nightly backups briefly stop
controllers to capture consistent state; service interruption is expected.
Copies preserve ownership/metadata and systemd cleanup retries service recovery
after cancellation. If recovery cannot restart a service, its journal remains
under `/run/home-assistant-backup`; inspect the failure and run
`sudo home-assistant-backup-recover`. An incomplete `.next` staging copy requires
review before retrying the backup.

On failed acceptance, stop the native controller and its radio/network services
before rebooting the retained HAOS media. Restore its matching consistent state
if necessary. A Nix generation rollback does not downgrade HA's migrated config
entries/database or Matter fabric format; use the pre-upgrade state with the
matching application versions.
