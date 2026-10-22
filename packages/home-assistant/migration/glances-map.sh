#!/usr/bin/env bash
# Match identities, never metric display-name guesses; no registry writes.
set +x
set -euo pipefail
umask 077
usage() {
  cat <<'EOF'
glances-map.sh --plan PRIVATE_NATIVE_PLAN --receipt PRIVATE_RECEIPT
  --snapshot COLD_NATIVE_HA_CONFIG --output PRIVATE_JSON

Match the selected old Glances sensor suffixes to the receipt's replacement
entry in a cold native registry copy. The plan hash must match its receipt.
Exit 0 means each old metric has one exact identity match. Exit 3 writes the
specific absent/ambiguous metrics requiring an operator replacement/retirement
decision. No integration, registry, dashboard or recorder data is changed.
After verifying the map, delete only the old Glances entry through HA, then use
the emitted replacement_entity_id -> target_entity_id map in entity settings.
EOF
}
die() {
  printf '%s\n' "$*" >&2
  exit 1
}
plan='' receipt='' snapshot='' output=''
while (($#)); do
  case "$1" in
  --plan)
    plan=${2:?}
    shift 2
    ;;
  --receipt)
    receipt=${2:?}
    shift 2
    ;;
  --snapshot)
    snapshot=${2:?}
    shift 2
    ;;
  --output)
    output=${2:?}
    shift 2
    ;;
  --help | -h)
    usage
    exit 0
    ;;
  *) die 'Unknown option; use --help.' ;;
  esac
done
[[ -n $plan && -n $receipt && -n $snapshot && -n $output ]] || {
  usage >&2
  exit 1
}
[[ ! -e $output && ! -L $output ]] || die 'Refusing to overwrite an existing mapping.'
plan_hash=$(sha256sum "$plan" | cut -d ' ' -f 1)
jq -e --arg hash "$plan_hash" '.plan_sha256 == $hash and (.applied.glances.entry_id|type == "string" and length > 0)' "$receipt" >/dev/null 2>&1 || die 'Use the exact native plan and its completed Glances replacement receipt.'
jq -e -n --slurpfile before "$plan" --slurpfile receipt "$receipt" \
  --slurpfile after "$snapshot/.storage/core.entity_registry" '
  ($before[0].entries.glances) as $old_id |
  ($receipt[0].applied.glances.entry_id) as $new_id |
  if ($before[0].glances_entity_names|length) > 0 and $old_id != $new_id then . else error("invalid old inventory") end |
  [$before[0].glances_entity_names[] as $old |
    if $old.config_entry_id == $old_id and ($old.unique_id|startswith($old_id + "-")) then . else error("unexpected old identity") end |
    ($old.unique_id|ltrimstr($old_id)) as $suffix |
    [$after[0].data.entities[] | select(.platform == "glances" and .config_entry_id == $new_id and .unique_id == ($new_id + $suffix))] as $matches |
    {old_entity_id:$old.entity_id,replacement_entity_id:(if ($matches|length) == 1 then $matches[0].entity_id else null end),
     target_entity_id:$old.entity_id,new_unique_id:($new_id + $suffix),
     status:(if ($matches|length) == 1 then "exact_metric_match" else "requires_metric_decision" end),
     old_metadata:($old | {disabled_by,hidden_by,area_id,name,icon,labels,options})}
  ]' >"$output" 2>/dev/null || {
  rm -f -- "$output"
  die 'Cannot map inconsistent Glances inventory; no registry changed.'
}
if ! jq -e 'all(.[]; .status == "exact_metric_match")' "$output" >/dev/null; then
  printf 'Private mapping lists exact missing/ambiguous metrics. Record verified replacement or retirement for each; no names changed.\n'
  exit 3
fi
printf 'Every old metric has one exact replacement match; verify private mapping before old-entry removal and entity renames.\n'
