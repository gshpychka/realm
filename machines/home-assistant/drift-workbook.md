# Integrate changes made in Home Assistant since this branch

Use this workbook during section 3 of [the migration runbook](migration.md),
before final capture, and again against section 8's exact final capture. Its
input is the current controller's complete cold configuration, not the old
inspection export. The executable comparison is read-only; it never uploads
private configuration to Git, edits HA registries, or selects a winner for a
conflict.

**Low confidence until a fresh capture is reviewed:** a successful build cannot
establish that this branch contains the latest household changes. A two-way
comparison cannot distinguish a newly added item from an item deliberately
deleted on the other side. Every difference needs an explicit decision.

## Generate the private workbook

In the existing workstation Bash session from the runbook, after the rehearsal
capture has been unpacked:

```sh
set -euo pipefail
"$TOOLS" declarations "$WORK/drift-declarations.json"
drift_status=0
"$TOOLS" config-drift --snapshot "$SNAPSHOT" \
  --declarations "$WORK/drift-declarations.json" \
  --output "$WORK/drift-rehearsal" || drift_status=$?
test "$drift_status" -le 1
```

Open `$WORK/drift-rehearsal/workbook.md` and its `drift.json` in a local editor.
Keep the entire directory private. `source-normalized.json` and
`declared-normalized.json` contain actual configuration values, potentially
including inline credentials; they are never safe Git inputs. The Markdown
workbook lists identities and changed paths without copying those values.

The comparison resolves supported HA includes under the captured configuration
directory, preserves `!secret` references, and compares automation IDs, script
keys, scene IDs, and the remaining top-level YAML configuration. Sequence order
is significant. It normalizes known HA syntax aliases; a difference in a
template, action order, target, trigger, condition, helper or integration option
still produces a row. Unknown tags, inaccessible includes, cycles and ambiguous
identities are findings to resolve, never a clean result.

Copy `decisions-template.json` to a private `decisions.json`; fill every row's
`decision`, `reason`, `target_file` and `validation`. `target_file` is the relative
owning `.nix` file, including for an intentional removal. Do not change the
fingerprint or row IDs. Unreferenced YAML and UI code-storage findings have
separate hash-bound acknowledgement slots: inspect the exact file and record
`preserve-runtime` or `retire-unused`, its reason and verification. Parser,
include and ambiguous-identity failures cannot be acknowledged away.

```sh
cp -a "$WORK/drift-rehearsal/decisions-template.json" "$WORK/drift-decisions.json"
```

After implementing and verifying the decisions in the following sections, run:

```sh
"$TOOLS" config-drift --snapshot "$SNAPSHOT" \
  --declarations "$WORK/drift-declarations.json" \
  --decisions "$WORK/drift-decisions.json" --output "$WORK/drift-accounted"
```

This must exit 0. It records complete decisions for those exact inputs; it does
not prove that the code edits implement them. Rebuild and compare again below.
Exit 1 means unresolved rows/findings; exit 2 means invalid input or a stale
ledger. On any changed input generate a new workbook and review its new
fingerprint; never edit an old fingerprint to force acceptance.

`runtime-inventory.json` inventories the captured writable state and integration
code. It supports the review below; the declared YAML alone cannot establish
which UI configuration was changed recently.

## Resolve every YAML row

For each `live_only`, `declared_only` or `changed` row, inspect that item's full
source and declared values in the two private normalized files. Inspect the
same item in HA's editor and automation traces when intent is unclear. Record
one decision, a concrete reason, the changed repository file where applicable,
and the verification performed. Do not approve a whole category because another
item in it passed.

| Decision | Required work and evidence |
| --- | --- |
| `accept-live` | Port the captured behavior into the appropriate Nix module below. Preserve its ID/key. Rebuild declarations and verify that item's difference disappears. |
| `keep-declared` | Record the precise intended branch behavior and why the live value is obsolete. Record a native script/schema test or the exact acceptance action that verifies the intended behavior. A blanket “migration change” is insufficient. |
| `merge` | Write the combined intended behavior in Nix; record the source fields retained and deliberately replaced. Rebuild declarations; inspect the resulting item against both versions. Verify each changed trigger/action/fallback. |

For an item present only on the declared side, establish whether the live item
was intentionally deleted or the branch introduces it. Accepting a live
deletion means removing that declaration and its callers. Keeping it means
recording the intended new behavior and testing its introduction. For an item
present only on the live side, accepting it means adding its declaration;
keeping the declared absence means recording why it is deliberately retired and
checking its callers. An alias match does not establish identity.

| Captured concern | Repository destination and exact review |
| --- | --- |
| Automation | `configuration/<domain>/automations.nix`; retain the captured string `id` with `ha.automation`. Compare triggers, conditions, actions, mode, variables and error behavior. Preserve runtime enabled/disabled state in restored registries; do not use `initial_state` to conceal a discrepancy. |
| Script | `configuration/<domain>/scripts.nix`; retain its mapping key/entity ID and fields, selector/default behavior, sequence and mode. Use existing checked constructors. Update every caller if retirement is deliberate. |
| Scene | `configuration/scenes.nix`; retain the captured `id`, entity states and attributes. Check every scene caller and restored entity ID; do not generate a replacement ID. |
| YAML helper/template | `configuration/helpers.nix` or the owning domain module; retain `unique_id`, helper key, units, availability and state semantics. Template contracts belong in `configuration/templates.nix`. |
| Integration options, REST/shell commands or YAML platforms | `configuration/integrations.nix` or the owning module. Retain the behavior; make native paths/endpoints explicit. Replace literal credentials with private `!secret` references. Never put a private value in a Nix expression or public JSON. |
| Entity/device/area constant | `configuration/entities.nix`, `configuration/devices.nix` and owning target module. Verify the actual registry identity, domains and area; keep restored registries. Run preflight after each change. |
| New domain module | Add its path to `configuration/default.nix` imports. A file that is not imported changes nothing. Rebuild declarations and confirm the new item appears. |
| Custom integration/Pyscript source | Package the exact reviewed version/source/dependencies under `packages/home-assistant/custom-components/` or the existing runtime source. Compare the captured source, not only its displayed version. Add schema/import/behavior coverage through the existing HA QA. Keep writable journals in state. |

All paths in this table are relative to `machines/home-assistant/`, except
`packages/…`, which is relative to the checkout root. Use existing neighboring
modules for the Nix constructor shape. Converting a private item into public
code requires inspecting every literal for credentials, account/address data
and private URLs before staging it.

## Account for UI state and code separately

Create the private `$WORK/runtime-decisions.md` in a local editor. Record
the captured storage key, exact entry/entity/device identity, disposition,
reason and verification for each category below. `state-only` means the full
cold state is retained; it cannot resolve a YAML code difference.

| Current HA change | Required disposition |
| --- | --- |
| UI integration added, reconfigured, disabled or removed | Retain captured `.storage/core.config_entries`. Record every entry's domain/ID/state, its available native dependency, and any Supervisor hostname/path requiring the runbook's supported native flow. Do not reconstruct OAuth or pairing entries in Nix. |
| Entity/device/area/label rename, disable or reassignment | Retain current registries. Compare every referenced constant through preflight; decide whether to preserve the current name or change the code. Record intentional disabled entities and verify no required automation targets them. |
| Dashboard/resource edit | Retain UI dashboard/resource storage and `www/` files. Inventory YAML dashboard includes as configuration. Open each dashboard and inspect all `/local/` and `/hacsfiles/` requests after migration. |
| Assist pipeline/provider edit | Retain all current pipeline storage and integration entries. Record actual names, providers, languages and Voice PE selections; test each current pipeline using section 12. Do not rely on the historical count. |
| HACS/component update or new custom source | Compare captured domains, manifests and source files with the pinned packages. An unreviewed active domain must be packaged before cutover; `sanitize` refuses undeclared domains. Disabling HACS code updates does not port an update that already happened. |
| App added or its configuration changed | Review captured `docker-inspect.json`, the current apps list and each app's Configuration page. Record its function, exact image/version, mounts, credentials and native replacement/retirement. The six named role archives are not proof that another app's data was migrated. |
| New external mount, shell dependency or credential | Record exact source/container path, owner/mode, checksum and native destination. Extend capture/restore for it before final capture, include it in encrypted restore proof, and test the exact caller. An empty replacement directory does not preserve the data. |
| New Matter/ZHA/MQTT device | Retain controller state; compare exact fabric/node/IEEE/client identities and native capabilities. Extend the MQTT ledger for every client. Never commission a second fabric or re-pair to silence a missing reference. |
| History/auth/users/mobile/OAuth changes | Retain complete captured writable state. Verify login, history and current clients; rotate only the temporary migration token according to the runbook. Never export these objects into declarative code. |

For each captured custom component, compare its actual files with the packaged
candidate. In the workstation session, enter the exact manifest domain:

```sh
read -r -p 'Captured custom component domain: ' DOMAIN
[[ $DOMAIN =~ ^[a-z][a-z0-9_]*$ ]]
test -f "$SNAPSHOT/custom_components/$DOMAIN/manifest.json"
nix build "$CHECKOUT#legacyPackages.x86_64-linux.homeAssistant.componentPackages.$DOMAIN" \
  --no-write-lock-file --out-link "$WORK/component-$DOMAIN"
component_status=0
diff -ru --exclude=__pycache__ --exclude='*.pyc' --exclude=.git \
  "$SNAPSHOT/custom_components/$DOMAIN" \
  "$WORK/component-$DOMAIN/custom_components/$DOMAIN" \
  > "$WORK/component-$DOMAIN.diff" || component_status=$?
test "$component_status" -le 1
```

Select `aarch64-linux` on an ARM workstation. Review each private diff: packaged
manifest formatting/version stamping may differ, while a changed Python source
needs an explicit retained/replaced behavior decision and test. A missing
package attribute is an unported domain; do not suppress that failure or copy
the live component back after `sanitize`. Record its package/version/source and
the diff review in the runtime checklist. Repeat the comparison for each domain
listed in `runtime-inventory.json`.

**Low confidence — external or dormant clients:** no file scanner can establish
that an offline device exists or that a physical target is correct. Record it
in the private ledger and perform the exact section 12 acceptance action. A
missing observation is not a successful check.

## Rebuild and repeat against the final capture

After editing Nix, commit the reviewed public change. The original `$TOOLS`
package embeds the old declarations, so build a new tool and export its
declarations explicitly. Use a new output filename/directory on every pass.

```sh
set -euo pipefail
test -z "$(git -C "$CHECKOUT" status --porcelain)"
nix build "$CHECKOUT#packages.x86_64-linux.home-assistant-migrate" \
  --no-write-lock-file --out-link "$WORK/tools-reviewed"
REVIEWED_TOOLS="$WORK/tools-reviewed/bin/home-assistant-migrate"
"$REVIEWED_TOOLS" declarations "$WORK/drift-reviewed-declarations.json"
drift_status=0
"$REVIEWED_TOOLS" config-drift --snapshot "$SNAPSHOT" \
  --declarations "$WORK/drift-reviewed-declarations.json" \
  --output "$WORK/drift-reviewed" || drift_status=$?
test "$drift_status" -le 1
nix flake check "$CHECKOUT" --all-systems --no-build --no-write-lock-file
nix build --no-write-lock-file --no-link \
  "$CHECKOUT#checks.x86_64-linux.home-assistant-config" \
  "$CHECKOUT#checks.x86_64-linux.home-assistant-migration" \
  "$CHECKOUT#checks.aarch64-linux.home-assistant-config" \
  "$CHECKOUT#checks.aarch64-linux.home-assistant-migration"
```

On an ARM workstation select the ARM tool package. Review any residual
differences individually: intentional native paths, endpoints and behavioral
improvements may remain different from HAOS. Retain their explicit decisions
with the exact generated report. Invalid or incomplete input must be corrected;
it cannot be accepted as a deliberate behavior change.

Repeat the full ARM build after any code change, keeping the existing private
`WORK` context. The following builds into a fresh directory, retains old public
build records, then promotes only the new public artifacts. Captures,
credentials, SSH trust and workstation session records stay at their established
paths. A build failure occurs before promotion.

```sh
set -euo pipefail
NEW_BUILD=$(mktemp -d "$WORK/build-reviewed.XXXXXXXX")
"$REVIEWED_TOOLS" build "$CHECKOUT" "$NEW_BUILD"
nix build "$CHECKOUT#packages.x86_64-linux.home-assistant-migrate" \
  --no-write-lock-file --out-link "$NEW_BUILD/tools-workstation"
OLD_BUILD=$(mktemp -d "$WORK/build-before-review.XXXXXXXX")
for record in revision flake-lock.sha256 target.json closure.json artifacts.json; do
  cp -a "$WORK/$record" "$OLD_BUILD/$record"
  install -m600 "$NEW_BUILD/$record" "$WORK/$record"
done
for artifact in system tools-arm installer qa-arm tools-workstation; do
  cp -a --no-dereference "$WORK/$artifact" "$OLD_BUILD/$artifact"
  ln -s "$(readlink -f "$NEW_BUILD/$artifact")" "$WORK/$artifact.reviewed"
  mv -Tf "$WORK/$artifact.reviewed" "$WORK/$artifact"
done
cp -a "$WORK/declarations.json" "$OLD_BUILD/declarations.json"
TOOLS="$WORK/tools-workstation/bin/home-assistant-migrate"
"$TOOLS" declarations "$WORK/declarations.reviewed.json"
mv -T "$WORK/declarations.reviewed.json" "$WORK/declarations.json"
SYSTEM=$(readlink -f "$WORK/system")
ARM_TOOLS=$(readlink -f "$WORK/tools-arm")
IMAGE="$WORK/installer/sd-image/nixos-installer-rpi5-kernel.img.zst"
```

On an ARM workstation change the workstation tool attribute to `aarch64-linux`.
Keep `NEW_BUILD`: its Nix out-links retain GC roots for the promoted closures.
Regenerate the endpoint plan from the current snapshot with section 6, rerun
preflight, and repeat credential preparation if a changed item needs a new
private key/value. Do not reuse a previous plan against different declarations.

Against `$FINAL_SNAPSHOT` in section 8, generate a fresh final workbook using
that final build's tool/declarations. Compare it with the reviewed rehearsal
workbook. Any new or changed source item requires its own decision and repeat
build/capture cycle before installation. Preserve the final workbook and runtime
decisions in the encrypted final recovery proof. The native cold audit and
physical acceptance then verify the migrated result.
