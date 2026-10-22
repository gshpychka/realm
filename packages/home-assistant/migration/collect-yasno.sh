#!/usr/bin/env bash
# Official public GETs and explicit private selections; no HA writes.
set +x
set -euo pipefail
umask 077
usage() {
  cat <<'EOF'
collect-yasno.sh --snapshot DIR --output PRIVATE_DIRECTORY [--entry-id ID]
  [--query-file PRIVATE_JSON] [--selection-file PRIVATE_JSON] [--resume]

Existing captured street/house IDs are verified with official Yasno GETs.
For a group-only entry, query JSON is {"street_query":"...","house_query":"..."}.
First call saves street candidates and exits 3. Inspect yasno-streets.json locally,
create selection JSON {"street_id":NUMBER}, then --resume to fetch house candidates.
Select the exact house ID, add "house_id":NUMBER, and --resume again. No result is
selected automatically. Output must be new unless --resume; it remains mode 700.
Successful output contains yasno-regions.json, yasno-address.json and
 yasno-official-group.json for prepare-yasno.sh. Source state is never modified.
EOF
}
die() {
  printf '%s\n' "$*" >&2
  exit 1
}
snapshot='' output='' selected='' queries='' selection='' resume=false
while (($#)); do
  case "$1" in
  --snapshot)
    snapshot=${2:?}
    shift 2
    ;;
  --output)
    output=${2:?}
    shift 2
    ;;
  --entry-id)
    selected=${2:?}
    shift 2
    ;;
  --query-file)
    queries=${2:?}
    shift 2
    ;;
  --selection-file)
    selection=${2:?}
    shift 2
    ;;
  --resume)
    resume=true
    shift
    ;;
  --help | -h)
    usage
    exit 0
    ;;
  *) die 'Unknown option; use --help.' ;;
  esac
done
[[ -n $snapshot && $output == /* && ! -L $output ]] || {
  usage >&2
  exit 1
}
if [[ -e $output ]]; then
  [[ $resume == true && -d $output && $(stat -c %a "$output") == 700 && $(stat -c %u "$output") == "$EUID" ]] || die 'Use a new private output directory, or --resume its mode-700 directory.'
else
  [[ $resume == false ]] || die 'Cannot resume an absent collection.'
  mkdir -m700 -- "$output"
fi
task_dir=$(mktemp -d)
trap 'rm -rf -- "$task_dir"' EXIT
jq -e --arg selected "$selected" '[.data.entries[] | select(.domain == "yasno_outages" and ($selected == "" or .entry_id == $selected))] |
  if length == 1 then {entry_id:.[0].entry_id,settings:(.[0].data + (.[0].options // {}))} else error("ambiguous entry") end' \
  "$snapshot/.storage/core.config_entries" >"$task_dir/entry" 2>/dev/null || die 'Select exactly one captured Yasno entry with --entry-id.'
entry_id=$(jq -r .entry_id "$task_dir/entry")
if [[ $resume == true ]]; then
  [[ -f $output/entry-id && $(cat "$output/entry-id") == "$entry_id" ]] || die 'Resume directory belongs to a different source entry.'
else
  printf '%s\n' "$entry_id" >"$output/entry-id"
fi
get() {
  local endpoint=$1 result=$2
  shift 2
  curl --disable --fail --silent --show-error --proto '=https' --max-redirs 0 \
    --connect-timeout 10 --max-time 90 --get "$@" \
    "https://app.yasno.ua/api/blackout-service/public/shutdowns/addresses/v2/$endpoint" \
    --output "$result" || die 'Official Yasno GET failed; source state is unchanged.'
  jq -e . "$result" >/dev/null 2>&1 || die 'Official Yasno response is not valid JSON.'
}
get regions "$output/yasno-regions.json"
jq -e -n --slurpfile entry "$task_dir/entry" --slurpfile regions "$output/yasno-regions.json" '
  def one: if length == 1 then .[0] else error("ambiguous provider") end;
  ([$regions[0][] | select(.value == $entry[0].settings.region)] | one) as $region |
  ([$region.dsos[] | select(.name == $entry[0].settings.provider)] | one) as $provider |
  {region_id:$region.id,provider_id:$provider.id}' >"$task_dir/ids" 2>/dev/null || die 'Captured region/provider names do not match one official selection.'
jq -e '[.region_id,.provider_id] | all(type == "number" and . > 0 and floor == .)' "$task_dir/ids" >/dev/null || die 'Official region/provider IDs have an unexpected schema.'
region_id=$(jq -r .region_id "$task_dir/ids")
provider_id=$(jq -r .provider_id "$task_dir/ids")
if jq -e '.settings | [.street_id,.house_id] | all(type == "number" and . > 0 and floor == .)' "$task_dir/entry" >/dev/null; then
  street_id=$(jq -r .settings.street_id "$task_dir/entry")
  house_id=$(jq -r .settings.house_id "$task_dir/entry")
else
  [[ -f $queries ]] || die 'A group-only entry needs an explicit private street/house query JSON file.'
  jq -e '(.street_query|type == "string" and length > 0) and (.house_query|type == "string" and length > 0)' "$queries" >/dev/null 2>&1 || die 'Private query JSON requires nonempty street_query and house_query strings.'
  jq -j .street_query "$queries" >"$task_dir/street-query"
  jq -j .house_query "$queries" >"$task_dir/house-query"
  get streets "$output/yasno-streets.json" --data-urlencode "regionId=$region_id" --data-urlencode "dsoId=$provider_id" --data-urlencode "query@$task_dir/street-query"
  jq -e 'type == "array" and all(.[]; (.id|type == "number") and (.value|type == "string"))' "$output/yasno-streets.json" >/dev/null || die 'Official street candidates have an unexpected schema.'
  if [[ ! -f $selection ]] || ! jq -e '.street_id|type == "number" and . > 0 and floor == .' "$selection" >/dev/null 2>&1; then
    printf '{"field":"street_id","candidates":"yasno-streets.json"}\n' >"$output/selection-required.json"
    printf 'Select the exact street ID from private yasno-streets.json; add it to selection JSON and --resume.\n'
    exit 3
  fi
  street_id=$(jq -r .street_id "$selection")
  jq -e --argjson id "$street_id" '[.[] | select(.id == $id)] | length == 1' "$output/yasno-streets.json" >/dev/null || die 'Selected street ID is not one exact official result.'
  get houses "$output/yasno-houses.json" --data-urlencode "regionId=$region_id" --data-urlencode "dsoId=$provider_id" --data-urlencode "streetId=$street_id" --data-urlencode "query@$task_dir/house-query"
  jq -e 'type == "array" and all(.[]; (.id|type == "number") and (.value|type == "string"))' "$output/yasno-houses.json" >/dev/null || die 'Official house candidates have an unexpected schema.'
  if ! jq -e '.house_id|type == "number" and . > 0 and floor == .' "$selection" >/dev/null 2>&1; then
    printf '{"field":"house_id","candidates":"yasno-houses.json"}\n' >"$output/selection-required.json"
    printf 'Select the exact house ID from private yasno-houses.json; add it to selection JSON and --resume.\n'
    exit 3
  fi
  house_id=$(jq -r .house_id "$selection")
  jq -e --argjson id "$house_id" '[.[] | select(.id == $id)] | length == 1' "$output/yasno-houses.json" >/dev/null || die 'Selected house ID is not one exact official result.'
fi
jq --argjson street "$street_id" --argjson house "$house_id" '. + {street_id:$street,house_id:$house}' "$task_dir/ids" >"$output/yasno-address.json"
get group "$output/yasno-official-group.json" --data-urlencode "regionId=$region_id" --data-urlencode "dsoId=$provider_id" --data-urlencode "streetId=$street_id" --data-urlencode "houseId=$house_id"
jq -e '[.group,.subgroup] | all(type == "number" and . > 0 and floor == .)' "$output/yasno-official-group.json" >/dev/null || die 'Official address response has an invalid group.'
rm -f -- "$output/selection-required.json"
printf 'Official private address evidence collected; continue with prepare-yasno. No HA state changed.\n'
