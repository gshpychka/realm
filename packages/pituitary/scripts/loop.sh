#!/usr/bin/env bash
# One iteration of the development loop.
#
# Runs every gate, keeps going after a failure so one run reports every problem,
# and leaves a digest in artifacts/report.md next to the captured screens.
set -uo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
realm_root="$(git rev-parse --show-toplevel)"
system="$(nix eval --impure --raw --expr builtins.currentSystem)"
mkdir -p artifacts/logs artifacts/screens
rm -rf artifacts/perf
report=artifacts/report.md
: >"$report"

status=0
declare -a failed=()

gate() {
  local name=$1
  shift
  local log="artifacts/logs/$name.log"
  local started=$SECONDS
  printf '%-10s ' "$name"
  if "$@" >"$log" 2>&1; then
    printf 'pass (%ss)\n' "$((SECONDS - started))"
    printf '| %s | pass | %ss | [%s](logs/%s.log) |\n' "$name" "$((SECONDS - started))" "$name" "$name" >>"$report.rows"
    return 0
  fi
  status=1
  failed+=("$name")
  printf 'FAIL (%ss) · %s\n' "$((SECONDS - started))" "$log"
  printf '| %s | **fail** | %ss | [%s](logs/%s.log) |\n' "$name" "$((SECONDS - started))" "$name" "$name" >>"$report.rows"
  return 1
}

: >"$report.rows"

gate install bun install --frozen-lockfile
gate typecheck tsc -p .
gate lint biome check .
gate unit bun test packages/ scripts/
gate e2e node --test --test-reporter=spec "e2e/**/*.test.ts"
# Timings, one file at a time so no other test competes for the machine.
gate perf node --test --test-concurrency=1 --test-reporter=spec "e2e/**/*.perf.ts"
# The package pins its installed dependencies by hash, so a changed bun.lock fails here first.
gate package nix build "$realm_root#pituitary" --no-link
# Evaluates the Home Manager module against a home with every option set.
gate module nix build "$realm_root#checks.$system.pituitary-home-manager" --no-link

{
  printf '# Loop report\n\n'
  printf '%s\n\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')"
  printf '| gate | result | elapsed | log |\n|---|---|---|---|\n'
  cat "$report.rows"
  printf '\n'

  if [ ${#failed[@]} -gt 0 ]; then
    printf '## First failure: %s\n\n```\n' "${failed[0]}"
    tail -n 60 "artifacts/logs/${failed[0]}.log"
    printf '```\n\n'
  fi

  printf '## Timings\n\n| measure | figures | budget |\n|---|---|---|\n'
  for figure in artifacts/perf/*.json; do
    [ -e "$figure" ] || continue
    node -e 'const f = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
      const { name, budget, ...rest } = f;
      const show = Object.entries(rest).map(([k, v]) => typeof v === "object"
        ? `${k} p50 ${v.p50}ms · p95 ${v.p95}ms · max ${v.max}ms (n=${v.n})` : `${k} ${v}`).join("; ");
      console.log(`| ${name} | ${show} | ${budget} |`);' "$figure"
  done
  printf '\n'

  printf '## Screens\n\n'
  for screen in artifacts/screens/*.txt; do
    [ -e "$screen" ] || continue
    printf '### %s\n\n```\n' "$(basename "$screen" .txt)"
    cat "$screen"
    printf '```\n\n'
  done
} >"$report"
rm -f "$report.rows"

if [ $status -eq 0 ]; then
  printf 'all gates passed · %s\n' "$report"
else
  printf 'failed: %s · %s\n' "${failed[*]}" "$report"
fi
exit $status
