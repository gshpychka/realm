"""rolesanywhere: keep this machine's CA in its TPM2, and issue short-lived
client certificates from it to local Unix users."""

import argparse
import sys
from pathlib import Path

from . import ca, config, issuer


def main() -> int:
    parser = argparse.ArgumentParser(prog="rolesanywhere", description=__doc__)
    parser.add_argument(
        "command",
        choices=["ca", "serve"],
        help="ca: make sure there is a CA the TPM2 signs with; serve: issue a certificate for an accepted connection",
    )
    parser.add_argument("config", type=Path, help="JSON config written by Nix")
    args = parser.parse_args()
    settings = config.load(args.config)
    if args.command == "serve":
        return issuer.serve(settings)
    return ca.ensure(settings)


if __name__ == "__main__":
    sys.exit(main())
