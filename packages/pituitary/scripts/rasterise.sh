#!/usr/bin/env bash
# Turns tui-test SVG captures into PNGs that can be opened and looked at.
#
# resvg loads no system fonts here, so the terminal font comes from the dev shell.
set -euo pipefail

dir=${1:?usage: rasterise.sh <directory-of-svgs> [zoom]}
zoom=${2:-2}
font_dir=${PITUITARY_FONT_DIR:?PITUITARY_FONT_DIR is set by the nix dev shell}
fallback_dir=${PITUITARY_FALLBACK_FONT_DIR:-}
symbol_dir=${PITUITARY_SYMBOL_FONT_DIR:-}
fonts=(--use-fonts-dir "$font_dir")
if [ -n "$fallback_dir" ]; then fonts+=(--use-fonts-dir "$fallback_dir"); fi
if [ -n "$symbol_dir" ]; then fonts+=(--use-fonts-dir "$symbol_dir"); fi

count=0
for svg in "$dir"/*.svg; do
  [ -e "$svg" ] || continue
  resvg \
    --skip-system-fonts \
    "${fonts[@]}" \
    --font-family "JetBrains Mono" \
    --zoom "$zoom" \
    "$svg" "${svg%.svg}.png" 2>/dev/null
  count=$((count + 1))
done
printf 'rasterised %d capture(s) in %s\n' "$count" "$dir"
