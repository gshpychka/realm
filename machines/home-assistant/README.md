Home Assistant on a Raspberry Pi 5 with an Argon ONE V3 case and NVMe storage.

The intended outcome is a declarative OS and household configuration with
preserved HA runtime state. See [migration readiness and cutover](migration.md)
for the ownership boundary, private snapshot preflight, installer, credentials,
release gates and rollback. Git alone cannot recreate device pairings or accounts.

The machine root contains host and service declarations. `configuration/` uses
normal NixOS modules grouped by household domain. A domain owns its automations,
scripts, template contracts and authored Jinja programs together: weather's
conversation automation, output contracts and report programs live in
`configuration/weather/`; printer notifications, inspection script and programs
live in `configuration/printer/`. Shared constructors, entities, helpers, scenes
and integration configuration remain at the configuration root.

The source boundaries are:

```text
machines/home-assistant/
  configuration/
    climate/               AC script and programs, fan status program
    devices/               device availability, leak and appliance automations
    gpt/                   expert conversation script and programs
    lighting/              button and scheduled lighting automations
    media/                 playback and Assist automations, scripts and programs
    power/                 power notifications and button actions, programs
    printer/               printer automations, inspection script and programs
    shared/                safe provider-field macro
    system/                startup/shutdown automations and notification programs
    voice/                 assistant selection, volume and provider announcements
    weather/               weather automation and programs
  runtime/
    argonone/              case cooling component
    backup/                consistent backup component
    glances/               bounded network/filesystem probe compatibility
    yasno-address-guard/    Pyscript address transaction component
packages/home-assistant/
  core.nix                 Core package and its Python runtime scope
  mcp.nix                  MCP package and its separate Python runtime scope
  update.nix               explicit source-update commands
  migration/               guarded capture/install/restore/reconcile/runbook CLI
  core-dependencies/       Core runtime compatibility packages
    pymodbus/              native override and its test-isolation patch
    python-overseerr/      native client query fix and local HTTP regressions
    zigpy/                 native override and its semaphore-test patch
  mcp-dependencies/        MCP dependencies and build backend
  custom-components/      native component package expressions
    dyson_local/           component expression and vacuum API patch
  tests/
    default.nix            offline QA assembly
    configuration/         native schema, constructor and service behavior checks
    layout/                ownership guard and its regression tests
    mcp/                   package imports, dependency metadata and resource checks
    migration/             private preflight and executable migration regressions
    runtime/               cooling, backup and Yasno component contracts
    templates/             Nix/Python template checks and their fixtures
    updater/               source refresh, path selection and failure contracts
```

Leaf package expressions stay flat until a component needs supporting assets;
its `package.nix`, patches and tests then share the component directory. The
Core and MCP dependency directories describe distinct consuming runtimes.
Third-party component sources keep their upstream layout. Existing runtime
component boundaries remain cohesive.

The 45 automations, four scripts and two scenes describe the active household
behavior. Automations and scenes retain their original IDs so a restored registry
can reuse their identities. Automations omit `initial_state` so HA can restore
their last runtime enabled state. Definitions and features change through Nix.

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
condition and helper shapes; `lib.nix` exposes the household configuration API.
Automation fields follow id, alias, description, triggers, conditions, actions,
variables, then execution options, omitting absent fields. Bodies stay native
attrsets and lists. Dependent variables use `orderedVariables`, which emits one
action per binding in list order. `templates.nix` merges seven domain modules
at `<domain>/templates.nix`: system, printer, power, weather, media, GPT and climate.
These Nix modules declare native result types and semantic program references.
`template.nix` provides closed constructors for a variable or dotted attribute
path: `template.variable "end_ts"` and `template.ref [ "trigger" "id" ]`.
For example, `print_when = template.variable "end_ts" // { output = "integer"; };`
registers a generated reference with its native output contract. The constructors
accept nonempty ASCII identifiers and reject expression strings, filters, calls,
indexing, invalid paths and reserved root names. They generate only dotted lookup
syntax; more complex logic stays in semantic `.jinja` files.

The 74 programs comprise five generated references and 69 authored programs under
`configuration/<domain>/`, with one shared macro in `configuration/shared/` (70
production files). `merge-template-domains.nix` rejects duplicate exports, and
`template-files.nix` resolves file sources with `builtins.readFile` or emits a
validated reference. Every resolved contract records its file/helper or reference
path provenance. The complete file inventory rejects unregistered or missing
files, duplicate program files and unused or missing bindings. New programs need
metadata and behavior fixtures; authored programs also need a source file.

Constant placeholders have the form `@@JSON_NAME@@`, used as
`(@@JSON_NAME@@ | from_json)` in the `.jinja` file. The loader serializes each
binding twice as JSON, so quotes, escapes, Unicode, newlines and template-looking
text remain data. The authored Jinja expression decodes the embedded JSON with
HA's `from_json`. Generated source is limited to the validated reference constructor.
`configuration/shared/safe-fields.jinja` handles missing fields in provider
responses, including native HA event/state objects. Helpers are prepended in
their declared order without adding whitespace. Files retain their intentional
trailing-newline behavior; editing prompt whitespace can change spoken output.
Negative and serialization templates live separately in
`packages/home-assistant/tests/templates/fixtures/*.jinja`. Clearly marked
delimiter-looking input data remains in test declarations. The layout check
rejects inline Jinja programs throughout the first-party HA Nix and Python trees,
with one exact exception for the validated reference emitter. It also rejects
production files containing only a reference. Upstream patch context is outside
that scan.

The existing-solutions preflight reviewed the maintained
[nixpkgs HA module](https://github.com/NixOS/nixpkgs/blob/master/nixos/modules/services/home-automation/home-assistant.nix)
and [HA custom template support](https://www.home-assistant.io/docs/templating/custom-templates/).
The module provides native configuration serialization; HA provides the actual
schema and Jinja engines. The local constructors add narrow shape/provenance
checks around those existing tools, rather than another configuration language.

Original automation and scene IDs preserve the existing registry identities,
entity names and enabled-state restoration. Removing them can allocate suffixed
replacement entities when the old registry is restored. Trigger IDs are retained
where branch conditions reference them. Nix-managed definitions are edited in
Nix. Script/helper keys are functional entity names. The fan and Ollama sensors
retain semantic `unique_id` values for registry identity.

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

`packages/home-assistant` packages Core, MCP and 20 custom integrations. The
component expressions declare sources, dependencies and patches through nixpkgs'
`buildHomeAssistantComponent`. A shared adjustment selects each domain, removes
upstream bytecode and stamps its release manifest; the native builder installs
and validates it. Samsung TV reuses the matching nixpkgs package. HACS uses its
release zip to include its compiled frontend. The Dyson API patch and upstream
dependency test fixes are applied during builds.

The Core Python scope reuses nixpkgs packages. Its aio-libs and frontend overrides
match Core 2026.10.2; source-specific Cython adjustments retain aiohttp's compiled
parsers. The native Overseerr client forwards raw query values so the HTTP client
encodes them once; four local-server regressions cover spaces, percent signs,
reserved characters and Ukrainian titles. It retains the native package version.
`croniter` and original `passlib` satisfy exact component
requirements. `homeeasy`, `translitua` and `novaposhta-python-client` supply
packages absent from the locked nixpkgs. MCP has its own native Python scope:
its vendored FastMCP requires newer `python-dotenv` and `pydantic-monty`, and its
build requires the pinned `uv-build`. The latter two use upstream native wheels
for the two Linux architectures. Package imports and upstream dependency metadata
are validated in their actual Python environments.

These `.nix` files are executable package definitions, with build inputs, checks,
source fetchers and compatibility adjustments. Versions and hashes live beside
the code they build. `update.nix` provides the thin
`nix run .#update-home-assistant` entrypoint using the maintained
[nix-update](https://github.com/Mic92/nix-update) and
[Skopeo](https://github.com/containers/skopeo) tools from the locked nixpkgs.
The preflight also reviewed
[nvfetcher](https://github.com/berberman/nvfetcher), source-only flake inputs and
`nix-prefetch-docker`. Direct package updates fit these expressions; nvfetcher
would add a second source manifest and generated output, flake inputs cover Git
sources rather than the wheel/release-asset/OCI mix, and Skopeo reads the OCI
manifest digest directly for the native container option.

Run on x86_64 or ARM64 Linux from this checkout with its locked flake inputs available. Source refreshes
need public network access to GitHub, PyPI and GHCR; they require no API key or
API credentials. Every version is selected explicitly; `skip` recomputes the
hash at the current version. Commands mutate the checkout for review:

```sh
nix run .#update-home-assistant -- --help
nix run .#update-home-assistant -- core 2026.10.2
nix run .#update-home-assistant -- dependency aiohttp 3.14.5
nix run .#update-home-assistant -- component pyscript 2.1.0
nix run .#update-home-assistant -- mcp 8.7.0
nix run .#update-home-assistant -- mcp-dependency pydantic-monty 0.0.18
nix run .#update-home-assistant -- skills 7690c5ea14e5c842bb143dbe5725ed48fe5449db
nix run .#update-home-assistant -- matter 1.4.0
nix run .#update-home-assistant -- refresh
```

`refresh` recomputes every local source hash at its current pin, including Core's
Git source and translation sdist, 19 local components, nine Core compatibility
dependencies, MCP and its skill commit, both architecture wheels and the Matter
manifest digest. The universal dotenv wheel has one hash. Architecture source
hashes are fetched on the updater host; package execution still needs the target
architecture. Matter's version and digest live in `services.nix` beside the
container declaration. The tag documents the selected release; the digest fixes
the executed image. `matter skip` resolves that configured tag before querying
the registry; registry/digest failures leave the declaration untouched.

Updates and `refresh` are sequential, not transactional. A failed `nix-update`
target can leave its new version beside its previous hash; a failed refresh also
retains successful earlier target edits and stops before later targets. Preserve
any existing uncommitted changes before running updates. After a failure, inspect
`git diff -- packages/home-assistant machines/home-assistant/services.nix`.
Once network access is restored, retry the failed target with its selected
version or `skip` to recompute hashes. Alternatively, restore only that target's
version/hash edits from your pre-run copy, preserving unrelated work. Resume the
remaining targets or rerun `refresh`, then review the diff and run scoped QA
before building the target system. The `skills` command restores its complete
pre-command `mcp.nix` on failure, including local edits, so its revision and hash
remain paired.

For the commit-pinned `hassarr` and `homeeasy_local`, select the reviewed `rev`
and manifest `version` in their component expressions, then run
`nix run .#update-home-assistant -- component DOMAIN skip`. The other component
expressions derive their upstream tag or release URL from their version. To
force hash refresh after any source edit, use `skip`. Core updates refresh both
sources together; update its required frontend/aio-libs versions separately after
reviewing upstream requirements. For minor/major Core changes, also review
nixpkgs' component dependency mapping, inherited build adjustments and patches.
Patch application, component manifest requirements, Python import checks and the
scoped QA below are the compatibility gates; source refresh alone proves source
integrity.

`nix flake update nixpkgs` selects a new native package set, including Samsung TV,
the underlying HA recipe/component dependency mapping and ordinary Python tools.
`nix flake update nixos-raspberrypi` selects the Pi OS/kernel/firmware input.
`nix flake update` updates all flake inputs. Local version/hash literals in these
package expressions and the Matter service remain selected by the commands
above. Review both lock changes and local compatibility overrides together,
retiring an override when the locked native package meets its requirement.
HACS can inspect integrations; store-backed code changes go through Nix.

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
state and SSH host keys, preserves file ownership/metadata, validates SQLite,
and restores the active services even if copying fails. Systemd cleanup recovers
after cancellation, including a killed copy process. If a restart fails, inspect
the journal and run `sudo home-assistant-backup-recover` before retrying.
Incomplete `.next` copies require operator review. Retention is
7 daily, 4 weekly and 6 monthly snapshots.

The executable migration entrypoint is `nix run .#home-assistant-migrate -- --help`.
Follow [the complete runbook](migration.md) in order; it covers capture, verified
recovery, ARM installation, credentials, supported config flows, hardware
acceptance and rollback. `checks.<linux-system>.home-assistant-migration` runs the
shell safety and private-state fixture suites, including real local encrypted
restoration, without touching a live controller or block device. Both Linux
architectures expose the same CLI and migration checks.

[The live-change workbook](drift-workbook.md) compares a fresh cold capture with
the branch and records decisions for additions, edits and removals. Use
`home-assistant-migrate config-drift` for YAML differences and the workbook's
separate inventory for UI state, custom code and apps.

The offline config check is exposed as `checks.x86_64-linux.home-assistant-config`
and `checks.aarch64-linux.home-assistant-config`. Run it as a release gate on the
available Linux builder; it is not retained in the Pi's runtime closure. It validates native HA schemas, custom integration
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

`packages/home-assistant/tests/configuration/service_contracts.py` executes the current
media and power actions with HA's pinned native script engine and local recording
service stubs. The 39 media scenarios specify explicit and inferred movie/show
requests, rejected requests, unknown/malformed classifications, confirmation
fallbacks and service failures. They check service request data and order,
conversation replies, returned data and bound variables. HA's rejection of
non-mapping service responses is checked separately from template fallbacks.
Provider failures reach classification/confirmation fallback responses; media
queue mutations still abort on failure. Four weather scenarios verify that an
unavailable provider reaches the fallback conversation response. Each scenario
runs once. Six power runs cover success and each delivery failure
for outage and restoration notifications. Sensors change during speech;
Telegram must receive the message captured before speech, and failures must stop
subsequent calls.

Weather tests use readable sentence tables for 2,564 strict HA renders across
sensor value/type, precipitation, rain and temperature thresholds, including
negative temperatures and warming taking priority over cooling. Eighteen raw
confirmation-prompt renders check instructions and interpolation of quoted,
escaped, Unicode, multiline and Jinja-looking title data. Every template has an
explicit output-type and behavior fixture; new programs require extending that
coverage inventory. Nine generated-reference cases cover dotted lookup, native
scalar/mapping/list/null results, underscores, digits and keyword attributes,
with strict undefined checks. Nix negatives reject injection and raw-source or
mixed-file bypasses; generated sources still require registry membership.
Source-order checks cover every evaluated automation, and
Nix tests check the public API and reject duplicate domain exports. Migration
preflight regressions exercise missing state, identity continuity, target checks,
Supervisor endpoint detection, redaction and read-only operation. The QA
output includes a derived `template-scope-inventory.json` with the current
program names, file/reference provenance and use paths, plus `template-file-inventory.json`
covering every registered program and shared helper file.

Run this scoped check locally without remote builders:

```sh
nix build --no-write-lock-file --no-link --print-out-paths \
  --builders '' --max-jobs 1 --cores 1 -L .#checks.x86_64-linux.home-assistant-config
```

The first build needs public source/cache access. Add `--offline` after its
dependencies are present; otherwise Nix cannot use binary caches and may attempt
large dependency rebuilds. The pinned Pi system and installer still need an ARM
builder; running x86 configuration QA does not build those outputs.

The same check enforces ownership across the complete HA machine and package
trees. Seven guard regression tests accept colocated modules, programs, patches
and tests within their domain or component, and reject unowned global buckets,
orphan component assets, inline Jinja and simple-reference program files.
Updater fixtures exercise flat and directory component expressions, Core/MCP
dependency paths, current-tag Matter refresh, registry failures, skill rollback
and sequential partial failure. Runtime tests load component sources directly
from their declared locations.

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
