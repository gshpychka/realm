#!/usr/bin/env bash
# Bootstrap only from captured ownership and explicit official-address evidence.
set +x
set -euo pipefail
umask 077
usage() {
  cat <<'EOF'
prepare-yasno.sh --snapshot DIR --address-file PRIVATE_JSON
  --regions-file OFFICIAL_REGIONS_JSON --official-group-file OFFICIAL_GROUP_JSON
  --existing-secrets PRIVATE_YAML --output PRIVATE_YAML --plan PRIVATE_JSON
  [--entry-id ID]

Offline: never contacts HA/Yasno and never changes a registry. Address JSON must
contain numeric positive region_id, provider_id, street_id and house_id, selected
from Yasno's official address API. Supply the saved official group response too.
The captured entry's region/provider names must match the official region IDs,
and its entity unique IDs must match the official group. The plan lists exact
old -> neutral entity IDs. If renames are needed, output secrets are not created;
rename those exact entities through HA, recapture, then rerun this command.
Existing YAML keys are preserved; only yasno_address_guard is replaced. Outputs
must not exist. Requires Mike Farah yq (yq-go), jq and coreutils.
EOF
}
die() {
  printf '%s\n' "$*" >&2
  exit 1
}
snapshot='' address='' regions='' official_group='' secrets='' output='' plan='' entry_id=''
while (($#)); do
  case "$1" in
  --snapshot)
    snapshot=${2:?}
    shift 2
    ;;
  --address-file)
    address=${2:?}
    shift 2
    ;;
  --regions-file)
    regions=${2:?}
    shift 2
    ;;
  --official-group-file)
    official_group=${2:?}
    shift 2
    ;;
  --existing-secrets)
    secrets=${2:?}
    shift 2
    ;;
  --output)
    output=${2:?}
    shift 2
    ;;
  --plan)
    plan=${2:?}
    shift 2
    ;;
  --entry-id)
    entry_id=${2:?}
    shift 2
    ;;
  --help | -h)
    usage
    exit 0
    ;;
  *) die 'Unknown option; use --help.' ;;
  esac
done
[[ -n $snapshot && -n $address && -n $regions && -n $official_group && -n $secrets && -n $output && -n $plan ]] || {
  usage >&2
  exit 1
}
[[ ! -e $output && ! -L $output && ! -e $plan && ! -L $plan ]] || die 'Refusing to overwrite existing secret or plan files.'
task_dir=$(mktemp -d)
trap 'rm -rf -- "$task_dir"' EXIT
jq -e 'type == "object" and ([.region_id,.provider_id,.street_id,.house_id] | all(type == "number" and . > 0 and floor == .))' "$address" >/dev/null 2>&1 || die 'Address file requires four positive numeric official IDs.'
jq -e -n --slurpfile entries "$snapshot/.storage/core.config_entries" \
  --slurpfile registry "$snapshot/.storage/core.entity_registry" \
  --slurpfile address "$address" --slurpfile regions "$regions" \
  --slurpfile official "$official_group" --arg selected "$entry_id" '
  def one: if length == 1 then .[0] else error("ambiguous ownership") end;
  ([$entries[0].data.entries[] | select(.domain == "yasno_outages" and ($selected == "" or .entry_id == $selected))] | one) as $entry |
  ($entry.data + ($entry.options // {})) as $settings |
  ([$regions[0][] | select(.id == $address[0].region_id and .value == $settings.region)] | one) as $region |
  ([$region.dsos[] | select(.id == $address[0].provider_id and .name == $settings.provider)] | one) as $provider |
  if ([$official[0].group,$official[0].subgroup] | all(type == "number" and . > 0 and floor == .)) then . else error("invalid official group") end |
  ($official[0] | (.group|tostring) + "." + (.subgroup|tostring)) as $group |
  if ($settings.group // $group) == $group then . else error("configured group differs from official address") end |
  {
    electricity:"sensor.yasno_power",next_connectivity:"sensor.yasno_next_power",
    next_planned_outage:"sensor.yasno_next_planned_outage",next_probable_outage:"sensor.yasno_next_probable_outage",
    schedule_updated_on:"sensor.yasno_schedule_updated_on",status_today:"sensor.yasno_status_today",status_tomorrow:"sensor.yasno_status_tomorrow",
    planned_outages:"calendar.yasno_planned_outages",probable_outages:"calendar.yasno_probable_outages"
  } as $bindings |
  [$bindings | to_entries[] | . as $binding |
    ([$registry[0].data.entities[] | select(.platform == "yasno_outages" and .config_entry_id == $entry.entry_id and .unique_id == ($entry.entry_id + "-" + $group + "-" + $binding.key))] | one) as $entity |
    {key:$binding.key,old_entity_id:$entity.entity_id,new_entity_id:$binding.value,unique_id:$entity.unique_id,
      disabled_by:($entity.disabled_by // null),name_conflict: (any($registry[0].data.entities[]; .entity_id == $binding.value and (.unique_id != $entity.unique_id or .platform != "yasno_outages" or .config_entry_id != $entry.entry_id)))}
  ] as $renames |
  {
    entry_id:$entry.entry_id,official_group:$group,bindings:$bindings,entity_name_map:$renames,
    requires_rename:any($renames[]; .old_entity_id != .new_entity_id),
    has_disabled_binding:any($renames[]; .disabled_by != null),
    has_disabled_entry:($entry.disabled_by != null),
    has_name_conflict:any($renames[]; .name_conflict),
    guard:{
      app_path:"/var/lib/hass/pyscript/apps/yasno_address_guard",journal_path:"/var/lib/hass/yasno-address-guard/journal.json",
      entry_id:$entry.entry_id,region_id:$region.id,provider_id:$provider.id,
      street_id:$address[0].street_id,house_id:$address[0].house_id,bindings:$bindings,
      settings:{region:$settings.region,provider:$settings.provider,scan_interval:($settings.scan_interval // 15),
        filter_probable:($settings.filter_probable // true),status_all_day_events:($settings.status_all_day_events // true)}
    }
  }' >"$task_dir/plan" 2>/dev/null || die 'Yasno evidence is incomplete or incompatible: verify entry ownership, region/provider, official group and all nine entity unique IDs. No secret was created.'
# Preserve false preferences rather than treating them as an absent default.
jq --slurpfile entries "$snapshot/.storage/core.config_entries" '
  . as $plan | ($entries[0].data.entries[] | select(.entry_id == $plan.entry_id) | .data + (.options // {})) as $s |
  .guard.settings.filter_probable = (if $s | has("filter_probable") then $s.filter_probable else true end) |
  .guard.settings.status_all_day_events = (if $s | has("status_all_day_events") then $s.status_all_day_events else true end)' "$task_dir/plan" >"$plan"
jq -e '.guard.settings | (.region|type == "string") and (.provider|type == "string") and
  (.scan_interval|type == "number" and . >= 1 and . <= 60) and
  (.filter_probable|type == "boolean") and (.status_all_day_events|type == "boolean")' "$plan" >/dev/null 2>&1 || die 'Captured Yasno settings are invalid; private plan retained, no secret created.'
jq -e '.requires_rename == false and .has_name_conflict == false and .has_disabled_binding == false and .has_disabled_entry == false' "$plan" >/dev/null || die 'Private plan lists exact missing neutral names, conflicts or disabled bindings. Resolve through HA and recapture; no secret created.'
yq -o=json '.' "$secrets" >"$task_dir/secrets.json" 2>/dev/null || die 'Cannot parse existing private YAML secrets.'
jq -e 'type == "object"' "$task_dir/secrets.json" >/dev/null || die 'Existing secrets must be a YAML mapping.'
jq --slurpfile plan "$plan" '.yasno_address_guard = $plan[0].guard' "$task_dir/secrets.json" >"$task_dir/merged.json"
yq -P -o=yaml '.' "$task_dir/merged.json" >"$output" 2>/dev/null || {
  rm -f -- "$output"
  die 'Could not serialize private YAML secrets.'
}
printf 'Private Yasno configuration prepared with verified names and original preferences; no registry changed.\n'
