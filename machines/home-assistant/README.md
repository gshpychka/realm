Home Assistant on a Raspberry Pi 5 with an Argon ONE V3 case and NVMe storage.

The machine root contains host and service declarations. Runtime code lives in
`runtime/argonone/`, `runtime/backup/` and `runtime/yasno-address-guard/`, each owned
by its service or Pyscript component. The package root at
`packages/home-assistant/` contains package declarations and source pins;
`patches/<integration>/` holds the integration and dependency patches.
`packages/home-assistant/tests/default.nix` assembles offline QA, with constructor
checks in `tests/nix/`, validators and behavior checks in `tests/python/`, and
compact baseline data in `tests/fixtures/`. No third-party component source is
reorganized by this layout.

`configuration/` contains normal NixOS modules: automations grouped by purpose,
voice/media/device scripts, helpers, scenes, and YAML-capable integrations. The
45 automations, four scripts and two scenes describe the active household
behavior. Automations omit `initial_state` so HA can restore their last runtime
enabled state. Definitions and features change through Nix.

`entities.nix` names the entity references used by the declarations. `devices.nix`
contains only ZHA event sources, the soundbar's cloud device identity, and three
unresolved service targets. `lib.nix` shares service calls, state conditions,
announcements, semantic button triggers, ZHA offline triggers and the printer
snapshot sequence.

Button automations use `ha.singlePress ha.devices.roomLightswitch`,
`ha.doublePress ha.devices.bedShelfButton`, `ha.triplePress ha.devices.bedButton`
or `ha.longPress ha.devices.roomTableButton`. `quadruplePress` and
`quintuplePress` cover the existing higher press counts. `button-profiles.nix`
registers each device's evidenced gesture mappings once: most press-count events
repeat the event type as subtype, shelf-button events use `button_1`, and the
three existing long-press sources use `button`. Unknown devices and unsupported
gestures fail Nix evaluation. Add new mappings only with evidence for that
device; long, held and release events are not interchangeable. Helpers return
native trigger attrsets, so a functional trigger ID can be added with
`(ha.singlePress ha.devices.bedButton) // { id = "bed"; }` when needed.

`constructors.nix` holds the internal checks for automation, script, action,
condition and helper shapes; `lib.nix` retains its 22 public exports. Automation
fields follow alias, description, triggers, conditions, actions, variables, then
execution options, omitting absent fields. Bodies stay native attrsets and lists. Dependent
variables use `orderedVariables`, which emits one action per binding in list
order. `templates.nix` merges seven domain modules under `templates/`: system,
printer, power, weather, media, GPT and climate. The flat registry retains all 74
names and rejects duplicate exports through `merge-template-domains.nix`.
Declarations use named references. `template-literal.nix` serializes embedded values as JSON inside
a Jinja string and decodes them with HA's `from_json`.
`configuration/template-macros/safe-fields.jinja` handles
missing fields in provider responses, including native HA event/state objects.

The existing-solutions preflight reviewed the maintained
[nixpkgs HA module](https://github.com/NixOS/nixpkgs/blob/master/nixos/modules/services/home-automation/home-assistant.nix)
and [HA custom template support](https://www.home-assistant.io/docs/templating/custom-templates/).
The module provides native configuration serialization; HA provides the actual
schema and Jinja engines. The local constructors add narrow shape/provenance
checks around those existing tools, rather than another configuration language.

Automations omit optional top-level IDs and keep descriptive aliases. Trigger
IDs are retained where branch conditions reference them. Nix-managed definitions
are edited in Nix.
Scenes have no explicit IDs: their names provide the entity names used by callers,
and the [scene schema](https://github.com/home-assistant/core/blob/2026.10.2/homeassistant/components/homeassistant/scene.py)
accepts this. Script/helper keys are functional entity names. The fan and Ollama
sensors retain semantic `unique_id` values for registry identity.

Entity state triggers and service targets avoid device/entity registry UUIDs.
ZHA button and device-offline events still use named device constants because
they have no equivalent entity state ([ZHA trigger implementation](https://github.com/home-assistant/core/blob/2026.10.2/homeassistant/components/zha/device_trigger.py)).
The soundbar schema permits omitting its vendor UUID, but its
[API client](https://github.com/PiotrMachowski/Home-Assistant-custom-components-SmartThings-Soundbar/blob/v1.0.6/custom_components/smartthings_soundbar/api.py)
concatenates that value into the device URL without discovery or a default;
the UUID is therefore needed for operation. `roomVoiceTarget`,
`kitchenVoiceTarget` and `reaperWakeTarget` are
unresolved device targets in the private inventory; they retain their existing
fan-out rather than selecting replacement entities without sufficient evidence.

`packages/home-assistant` pins Core, MCP, Python dependencies and 20 custom
integrations. Sources use fixed hashes and upstream versions; HACS uses its
release zip to include its compiled frontend. The Dyson API patch and upstream
dependency test fixes are applied during builds. HACS can inspect integrations;
changes to store-backed integration code are made through Nix.

HA owns its writable `/var/lib/hass` state, including config entries, credentials,
pairings, registries, dashboards, disabled entities, and history. Config-flow
integrations are configured through HA. No runtime registry is generated by Nix.
The Yasno Pyscript app is immutable code with a writable transaction journal.
Printer snapshots use `/var/lib/hass/media`, declared as HA's local media source.

Runtime credentials live under `/var/lib/private/home-assistant` with root-only
access. `secrets.yaml` supplies `soundbar_api_key` and `yasno_address_guard` (the
app configuration, including its journal path and entity bindings). Systemd
passes the file to HA using `LoadCredential`. `ha-mcp.env` provides the MCP
server's HA token, secret path and settings; `mosquitto-passwords` contains
broker password hashes. HA and every MQTT client use ordinary broker credentials.
Outbound SSH uses HA's private `.ssh/outbound_key` and pinned `.ssh/known_hosts`.
These files are provisioned privately and are never Nix inputs.

Matter.js runs from a digest-pinned upstream image with host networking,
`/var/lib/matter-server` state, and HA's BLE proxy. MQTT persists broker state.
Tailscale, Bluetooth, SSH, Glances, and Argon cooling run as native OS services.
The fan reports speed percent and temperature Celsius as two whitespace-separated
numbers in `/run/argonone/fan-status`; HA's command-line sensor reads the speed. The case's
separate power-button protocol is not implemented.

Nightly encrypted restic backups use `restic-repository`, `restic-password`, and
`restic-environment` in the private credentials directory. The backup job briefly
stops active HA, MCP, Matter, MQTT, Tailscale and Bluetooth services, copies their
state and SSH host keys, validates SQLite, and restores the active services even
if copying fails. Incomplete `.next` copies require operator review. Retention is
7 daily, 4 weekly and 6 monthly snapshots.

The x86 offline config check is a required dependency of the Pi system build as
well as `checks.x86_64-linux.home-assistant-config`. It needs an x86 builder, even
when building the Pi closure separately. It validates native HA schemas, custom integration
imports and dependency versions, MCP resources, and cooling/backup/Yasno
contracts. It also exercises ordered variable templates, quoted GPT prompts,
movie timer gating, printer snapshots, alert thresholds and native state triggers
using in-memory fixtures. Every template use must match a registered program and
an audited scope. Every program compiles with the pinned HA 2026.10.2/Jinja engine
and renders with strict undefined handling under representative value/type,
missing-entity, unknown/unavailable and malformed-response fixtures. Negative
fixtures reject malformed templates, invalid bodies, broken quoting, undeclared
variables, forward references, sorted-map dependency errors and wrong output
types. Nix tests check all six button helpers against every device profile,
including unsupported gestures, malformed/unknown devices and checked-body
boundaries. AC and expert-query scripts guard their inputs before calling services;
unavailable weather and provider responses produce explicit fallback text.

`packages/home-assistant/tests/python/readability.py` executes the media flow with HA's pinned
native script engine and local recording service stubs. It compares the flattened
`if`/guard-stop flow with the pre-refactor control flow for explicit and inferred
movie/show requests, rejected requests, unknown/malformed classifications,
confirmation fallbacks and service failures. Calls, their order, returned data,
bound variables and conversation messages must match; trace structure may differ.
The 39 media scenarios include HA rejecting non-mapping service responses before
fallback templates run. Six power runs cover successful and failed delivery.
Power tests change sensors during speech and assert Telegram receives the message
captured before speech, including service-failure ordering.

The compact `tests/fixtures/readability.json` records the `ed89082` baseline using source
fingerprints and named template references, without duplicating the whole config.
It pins all 73 other template sources exactly, including the confirmation prompt.
Only weather source whitespace and voice control-flow structure are allowed to
differ. Weather AST and scope must match, and 2,564 paired strict HA renders cover
the original 2,560 branch/boundary/unknown cases plus negative temperatures;
18 raw prompt renders retain their baseline fingerprints. All configuration
outside those two allowances must match its baseline fingerprint. Review any
intentional behavior change before updating these fixtures. Source-order checks
cover all 45 automations, and Nix tests retain constructor/button negatives and
pin the public exports and duplicate rejection. The QA output includes a derived
`template-scope-inventory.json` with the actual program names and use paths.

Run this scoped check locally without remote builders:

```sh
nix build --offline --no-write-lock-file --no-link --print-out-paths \
  --builders '' --max-jobs 1 --cores 1 -L .#checks.x86_64-linux.home-assistant-config
```

The same check enforces the responsibility boundaries across the complete HA
machine and package trees and rejects references to removed source paths,
including in repository entrypoints and documentation. Python runtime tests
load the component sources directly from their declared locations.

These are schema, conservative scope and representative behavior checks. They
are not static typing or formal verification of arbitrary Jinja, device
conditions, service data, private registry targets or integration behavior.
HA's native parser can turn numeric/boolean text into scalars; text contracts
allow those scalar results, while boolean/numeric/mapping/list contracts check
their actual native types. Unrecognized template scopes fail the audit and need
an explicit extension. Private inventories and physical behavior still require
runtime acceptance.

The check never starts HA or talks to hardware or network integrations. Script
execution uses only local recording service handlers. A complete
Pi OS build and physical acceptance require an aarch64 builder and the target
hardware.
