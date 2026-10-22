#!/usr/bin/env bash
# Read only private captured YAML; never import it into Nix or update the source.
set +x
set -euo pipefail
umask 077
exec python3 "$(dirname -- "${BASH_SOURCE[0]}")/config-drift.py" "$@"
