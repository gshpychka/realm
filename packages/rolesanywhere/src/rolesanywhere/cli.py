"""rolesanywhere: issue short-lived client certificates to local Unix users from
a CA key in this machine's TPM2."""

import argparse
import datetime
import socket
import sys
import tempfile
from pathlib import Path

from cryptography.hazmat.primitives.serialization import Encoding

from . import certificates, config, issuer, tpm


def ca_certificate() -> int:
    """Prints a self-signed CA certificate for this TPM2's CA key."""
    with tempfile.TemporaryDirectory() as scratch:
        workdir = Path(scratch)
        context, key = tpm.derive(workdir)
        certificate = certificates.ca_certificate(
            socket.gethostname(),
            key,
            lambda message: tpm.sign(context, message, workdir),
            datetime.datetime.now(datetime.UTC),
        )
    print(certificate.public_bytes(Encoding.PEM).decode(), end="")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(prog="rolesanywhere", description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    serve = commands.add_parser(
        "serve", help="issue a certificate to the caller of the connection on stdin"
    )
    serve.add_argument("config", type=Path, help="JSON config written by Nix")
    commands.add_parser(
        "ca-certificate",
        help="print a CA certificate for this TPM2's CA key, to register with AWS",
    )
    args = parser.parse_args()
    if args.command == "serve":
        return issuer.serve(config.load(args.config))
    return ca_certificate()


if __name__ == "__main__":
    sys.exit(main())
