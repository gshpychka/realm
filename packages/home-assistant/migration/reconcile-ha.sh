#!/usr/bin/env bash
# Supported Core 2026.10.2 config flows only. Never edit .storage or call devices.
set +x
set -euo pipefail
umask 077

usage() {
  cat <<'EOF'
reconcile-ha.sh --export-plan SNAPSHOT --declarations PUBLIC_JSON
  --mqtt-credentials-file PRIVATE_JSON --glances-credentials-file PRIVATE_JSON
  --output PRIVATE_PLAN [--glances-entry-id ID]
reconcile-ha.sh --plan PRIVATE_PLAN [--apply --token-file TOKEN_FILE
  --url http://127.0.0.1:8123 --integration mqtt|matter|glances|all
  --receipt PRIVATE_RECEIPT]

Export and default plan modes are offline and read-only. Apply changes config
entries on the replacement native controller, never devices. MQTT credentials
are {"username":"...","password":"..."}; Glances credentials are an object
with optional username/password. Keep these files private and out of Git/Nix.
Apply requires Core 2026.10.2, config_dir /var/lib/hass, and an explicit loopback
HTTP URL. Use an SSH tunnel to the replacement Pi if running this elsewhere.
Glances creates a replacement entry and retains the old one for verified entity
name reconciliation. A private receipt prevents duplicate replacements on retry.
EOF
}
die() {
  printf '%s\n' "$*" >&2
  exit 1
}
plan='' snapshot='' declarations='' mqtt_credentials='' glances_credentials=''
output='' glances_id='' token_file='' url='' receipt='' integration=all apply=false
while (($#)); do
  case "$1" in
  --export-plan)
    snapshot=${2:?}
    shift 2
    ;;
  --declarations)
    declarations=${2:?}
    shift 2
    ;;
  --mqtt-credentials-file)
    mqtt_credentials=${2:?}
    shift 2
    ;;
  --glances-credentials-file)
    glances_credentials=${2:?}
    shift 2
    ;;
  --output)
    output=${2:?}
    shift 2
    ;;
  --glances-entry-id)
    glances_id=${2:?}
    shift 2
    ;;
  --plan)
    plan=${2:?}
    shift 2
    ;;
  --token-file)
    token_file=${2:?}
    shift 2
    ;;
  --url)
    url=${2:?}
    shift 2
    ;;
  --receipt)
    receipt=${2:?}
    shift 2
    ;;
  --integration)
    integration=${2:?}
    shift 2
    ;;
  --apply)
    apply=true
    shift
    ;;
  --help | -h)
    usage
    exit 0
    ;;
  *) die 'Unknown option; use --help.' ;;
  esac
done
[[ $integration =~ ^(mqtt|matter|glances|all)$ ]] || die 'Invalid integration selection.'
if [[ -n $snapshot ]]; then
  [[ -z $plan && $apply == false && -n $declarations && -n $output ]] || die 'Export requires declarations/output and cannot apply.'
  [[ $mqtt_credentials == /* && $glances_credentials == /* ]] || die 'Use absolute private credential file paths.'
  [[ ! -e $output && ! -L $output ]] || die 'Refusing to overwrite an existing plan.'
  [[ -f $snapshot/.HA_VERSION && -f $snapshot/.storage/core.restore_state ]] || die 'Snapshot lacks Core version or restore-state evidence.'
  version=$(tr -d '\r\n' <"$snapshot/.HA_VERSION")
  [[ $version == 2026.10.2 ]] || die 'Snapshot Core version differs from the reviewed 2026.10.2 pin.'
  # Only identity/capability metadata is exported, never entry data or state values.
  jq -e -n --slurpfile entries "$snapshot/.storage/core.config_entries" \
    --slurpfile registry "$snapshot/.storage/core.entity_registry" \
    --slurpfile restore "$snapshot/.storage/core.restore_state" \
    --slurpfile declaration "$declarations" --arg selected_glances "$glances_id" \
    --arg mqtt_credentials "$mqtt_credentials" --arg glances_credentials "$glances_credentials" '
    def exactly_one: if length == 1 then .[0].entry_id else error("Entry selection is ambiguous or absent") end;
    ($entries[0].data.entries) as $entries |
    ($registry[0].data.entities) as $entities |
    ($restore[0].data | map(.state) | map(select(type == "object"))) as $states |
    ($declaration[0].devices) as $devices |
    if (["roomVoiceTarget", "kitchenVoiceTarget", "reaperWakeTarget"] | all(. as $key | $devices[$key] | type == "string")) then . else error("Missing declared target identities") end |
    ([$entries[] | select(.domain == "glances") |
      select(if $selected_glances != "" then .entry_id == $selected_glances
      else (.data.host // "" | test("^(core|local|[a-f0-9]{8})[-_]")) end)] | exactly_one) as $glances_entry |
    {
      schema: 1, core_version: "2026.10.2", config_dir: "/var/lib/hass",
      entries: {
        mqtt: ([$entries[] | select(.domain == "mqtt")] | exactly_one),
        matter: ([$entries[] | select(.domain == "matter")] | exactly_one),
        glances: $glances_entry
      },
      credential_files: {mqtt: $mqtt_credentials, glances: $glances_credentials},
      endpoints: {mqtt: {broker: "127.0.0.1", port: 1883}, matter: {url: "ws://127.0.0.1:5580/ws"},
        glances: {host: "127.0.0.1", port: 61208, ssl: false, verify_ssl: false}},
      capability_inventory: [
        {name: "roomVoiceTarget", required: ["assist_satellite.announce", "media_player.volume_set"]},
        {name: "kitchenVoiceTarget", required: ["media_player.volume_set"]},
        {name: "reaperWakeTarget", required: ["switch.turn_on"]}
      ] | map(. as $target | . + {device_id: $devices[.name],
        candidates: [$entities[] | select(.device_id == $devices[$target.name]) | . as $entity |
          {entity_id, disabled_by, platform, config_entry_id,
          supported_features: ([$states[] | select(.entity_id == $entity.entity_id) | .attributes.supported_features][0] // null)}]}),
      glances_entity_names: [$entities[] | select(.platform == "glances" and .config_entry_id == $glances_entry) |
        {entity_id,unique_id,config_entry_id,disabled_by,hidden_by,area_id,name,icon,labels,options}],
      operator_acceptance: ["Verify candidate capabilities and availability before replacing any device target.",
        "Glances replacement changes entry/device/sensor unique IDs. Retain old entry until the exact sensor-name map is verified."]
    }' >"$output" 2>/dev/null || {
    rm -f -- "$output"
    die 'Cannot export plan: incomplete inventory, ambiguous entries or invalid declarations. Select the Glances entry explicitly if needed.'
  }
  printf 'Private reconciliation plan written; credentials were not copied.\n'
  exit 0
fi
[[ -n $plan && -z $snapshot ]] || {
  usage >&2
  exit 1
}
jq -e '.schema == 1 and .core_version == "2026.10.2" and .config_dir == "/var/lib/hass" and
  ([.entries.mqtt,.entries.matter,.entries.glances] | all(type == "string" and test("^[a-zA-Z0-9_-]+$"))) and
  .endpoints == {mqtt:{broker:"127.0.0.1",port:1883},matter:{url:"ws://127.0.0.1:5580/ws"},glances:{host:"127.0.0.1",port:61208,ssl:false,verify_ssl:false}}' "$plan" >/dev/null 2>&1 || die 'Invalid or incompatible private plan.'
if [[ $apply == false ]]; then
  jq '{core_version,config_dir,entries,endpoints,capability_inventory,operator_acceptance}' "$plan"
  exit 0
fi
[[ $url =~ ^http://127\.0\.0\.1:([0-9]{1,5})$ ]] || die 'Apply requires an explicit IPv4 loopback HTTP URL and port.'
[[ -f $token_file && ! -L $token_file ]] || die 'Apply requires a regular private token file.'
[[ $(stat -c '%a' "$token_file") =~ ^(400|600)$ ]] || die 'Token file must have mode 400 or 600.'
receipt=${receipt:-"$plan.receipt.json"}
[[ ! -L $receipt ]] || die 'Receipt must not be a symlink.'
task_dir=$(mktemp -d)
active_flow=''
cleanup() {
  # Cancel a failed setup flow; never remove an integration entry or a device.
  if [[ -n $active_flow ]]; then
    curl --disable --silent --noproxy '*' --proto '=http' --max-redirs 0 \
      --connect-timeout 5 --max-time 10 --config "$task_dir/auth" \
      -X DELETE "$url/api/config/config_entries/flow/$active_flow" >/dev/null 2>&1 || true
  fi
  rm -rf -- "$task_dir"
}
trap cleanup EXIT
ha_token=$(tr -d '\r\n' <"$token_file")
[[ $ha_token =~ ^[A-Za-z0-9._-]+$ ]] || die 'Invalid token format.'
printf 'header = "Authorization: Bearer %s"\n' "$ha_token" >"$task_dir/auth"
unset ha_token
api() {
  local method=$1 path=$2 payload=${3:-}
  local -a args=(--disable --silent --show-error --fail --noproxy '*' --proto '=http' --max-redirs 0 --connect-timeout 5 --max-time 120 --config "$task_dir/auth" -X "$method" --output "$task_dir/response")
  if [[ -n $payload ]]; then args+=(--header 'Content-Type: application/json' --data-binary "@$payload"); fi
  curl "${args[@]}" "$url$path" || die 'HA request failed; no private response values were printed.'
  jq -e 'type == "object" or type == "array"' "$task_dir/response" >/dev/null 2>&1 || die 'HA returned an invalid response.'
}
api GET /api/config
jq -e '.version == "2026.10.2" and .config_dir == "/var/lib/hass"' "$task_dir/response" >/dev/null || die 'Target is not the reviewed native replacement controller; no flows started.'
api GET /api/config/config_entries/entry
cp "$task_dir/response" "$task_dir/entries"
plan_hash=$(sha256sum "$plan" | cut -d ' ' -f 1)
if [[ -e $receipt ]]; then
  jq -e --arg hash "$plan_hash" '.plan_sha256 == $hash' "$receipt" >/dev/null || die 'Receipt belongs to a different plan.'
else
  jq -n --arg hash "$plan_hash" '{plan_sha256:$hash,applied:{}}' >"$receipt"
fi
record() {
  local name=$1 new_id=$2
  local receipt_temp
  receipt_temp=$(mktemp "$(dirname "$receipt")/.ha-reconcile-receipt.XXXXXX")
  jq --arg name "$name" --arg new_id "$new_id" '.applied[$name] = {entry_id:$new_id}' "$receipt" >"$receipt_temp"
  mv -f -- "$receipt_temp" "$receipt"
}
start_flow() {
  api POST /api/config/config_entries/flow "$task_dir/payload"
  active_flow=$(jq -er '.flow_id | select(type == "string" and test("^[a-zA-Z0-9_-]+$"))' "$task_dir/response") || die 'HA did not start the expected flow.'
}
for selected in mqtt matter glances; do
  [[ $integration == all || $integration == "$selected" ]] || continue
  entry_id=$(jq -r --arg name "$selected" '.entries[$name]' "$plan")
  if [[ $selected == glances ]]; then
    replacement=$(jq -r '.applied.glances.entry_id // ""' "$receipt")
    if [[ -n $replacement ]]; then
      jq -e --arg id "$replacement" 'any(.[]; .entry_id == $id and .domain == "glances")' "$task_dir/entries" >/dev/null || die 'Recorded Glances replacement is absent; refusing duplicate creation.'
      printf 'Glances replacement already recorded; original entry retained.\n'
      continue
    fi
  fi
  jq -e --arg id "$entry_id" --arg domain "$selected" 'any(.[]; .entry_id == $id and .domain == $domain)' "$task_dir/entries" >/dev/null || die 'Planned original config entry is absent; no flow started for it.'
  case "$selected" in
  mqtt)
    credential_file=$(jq -r '.credential_files.mqtt' "$plan")
    jq -e '(.username|type == "string" and length > 0) and (.password|type == "string" and length > 0)' "$credential_file" >/dev/null 2>&1 || die 'Invalid native MQTT credentials file.'
    jq -n --arg id "$entry_id" '{handler:"mqtt",entry_id:$id}' >"$task_dir/payload"
    start_flow
    jq -e '.type == "form" and .step_id == "broker"' "$task_dir/response" >/dev/null || die 'Unexpected MQTT flow; review the pinned contract.'
    jq '{broker:"127.0.0.1",port:1883,protocol:"5",username,password,other_settings:{set_ca_cert:"off",set_client_cert:false,transport:"tcp"}}' "$credential_file" >"$task_dir/payload"
    api POST "/api/config/config_entries/flow/$active_flow" "$task_dir/payload"
    jq -e '.type == "abort" and .reason == "reconfigure_successful"' "$task_dir/response" >/dev/null || die 'MQTT reconfiguration failed; original entry was not removed.'
    active_flow=''
    record mqtt "$entry_id"
    ;;
  matter)
    jq -e '[.[] | select(.domain == "matter")] | length == 1' "$task_dir/entries" >/dev/null || die 'Matter entry selection is ambiguous.'
    printf '{"handler":"matter"}\n' >"$task_dir/payload"
    start_flow
    jq -e '.type == "form" and .step_id == "manual"' "$task_dir/response" >/dev/null || die 'Unexpected Matter flow; native manual setup is required.'
    printf '{"url":"ws://127.0.0.1:5580/ws"}\n' >"$task_dir/payload"
    api POST "/api/config/config_entries/flow/$active_flow" "$task_dir/payload"
    jq -e '.type == "abort" and .reason == "reconfiguration_successful"' "$task_dir/response" >/dev/null || die 'Matter reconnection failed; original entry was not removed.'
    active_flow=''
    record matter "$entry_id"
    ;;
  glances)
    credential_file=$(jq -r '.credential_files.glances' "$plan")
    jq -e 'type == "object" and ((keys - ["username","password"])|length == 0) and all(.[];type == "string")' "$credential_file" >/dev/null 2>&1 || die 'Invalid private Glances credentials file.'
    printf '{"handler":"glances"}\n' >"$task_dir/payload"
    start_flow
    jq -e '.type == "form" and .step_id == "user"' "$task_dir/response" >/dev/null || die 'Unexpected Glances setup flow.'
    jq '. + {host:"127.0.0.1",port:61208,ssl:false,verify_ssl:false}' "$credential_file" >"$task_dir/payload"
    api POST "/api/config/config_entries/flow/$active_flow" "$task_dir/payload"
    replacement=$(jq -er 'select(.type == "create_entry") | .result.entry_id | select(type == "string" and test("^[a-zA-Z0-9_-]+$"))' "$task_dir/response") || die 'Glances replacement was not created.'
    active_flow=''
    record glances "$replacement"
    ;;
  esac
  printf '%s supported config flow completed; private receipt updated.\n' "$selected"
done
printf 'Verify Glances replacement sensors against plan.glances_entity_names before removing the old entry or renaming entities.\n'
