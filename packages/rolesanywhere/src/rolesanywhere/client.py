"""rolesanywhere-credentials: AWS credentials for the current user, through IAM
Roles Anywhere and this machine's CA.

  rolesanywhere-credentials --trust-anchor-arn T --profile-arn P --role-arn R
      print credential_process JSON for role R
  rolesanywhere-credentials --certificate
      print a fresh certificate (without its key), e.g. to check its subject

AWS CLIs and SDKs refresh such a profile on their own when the credentials expire:

  [profile myhost]
  credential_process = rolesanywhere-credentials --trust-anchor-arn ... --profile-arn ... --role-arn ...
"""

import argparse
import json
import os
import socket
import subprocess
import sys

# longer than the issuer's RuntimeMaxSec, so a slow issuer is reported, not cut off
ISSUER_TIMEOUT_SECONDS = 60


class Failure(Exception):
    pass


def fetch(socket_path: str, unit: str) -> dict[str, str]:
    """A fresh certificate and its key from this machine's issuer."""
    # The issuer identifies this process by its UID; there is nothing to send.
    try:
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as conn:
            conn.settimeout(ISSUER_TIMEOUT_SECONDS)
            conn.connect(socket_path)
            chunks = []
            while chunk := conn.recv(4096):
                chunks.append(chunk)
    except FileNotFoundError:
        raise Failure(
            f"{socket_path} does not exist: is services.rolesanywhere enabled on this machine?"
        ) from None
    except PermissionError:
        raise Failure(
            f"no access to {socket_path}: add this user to services.rolesanywhere.clients "
            "(a new group membership applies from the next login)"
        ) from None
    except ConnectionRefusedError:
        raise Failure(
            f"nothing is listening on {socket_path}: is {unit}.socket running?"
        ) from None
    if not chunks:
        raise Failure(f"the issuer answered nothing; see journalctl -u '{unit}@*'")
    reply = json.loads(b"".join(chunks))
    if "error" in reply:
        raise Failure(f"the issuer refused: {reply['error']}")
    return reply


def memfd(name: str, content: str) -> int:
    """content in an anonymous file that lives only in memory and disappears
    when every process holding it exits. aws_signing_helper opens /dev/fd/<fd>
    afresh, at offset 0, each time it reads (several times for the key, so a
    pipe would not do)."""
    fd = os.memfd_create(name)
    os.write(fd, content.encode())
    return fd


def credentials(helper: str, issued: dict[str, str], args: argparse.Namespace) -> int:
    """Has aws_signing_helper trade the certificate for credentials; it prints
    them as credential_process JSON."""
    certificate = memfd("certificate", issued["certificate"])
    key = memfd("private-key", issued["privateKey"])
    command = [
        helper,
        "credential-process",
        "--certificate",
        f"/dev/fd/{certificate}",
        "--private-key",
        f"/dev/fd/{key}",
        "--trust-anchor-arn",
        args.trust_anchor_arn,
        "--profile-arn",
        args.profile_arn,
        "--role-arn",
        args.role_arn,
    ]
    if args.endpoint is not None:
        command += ["--endpoint", args.endpoint]
    return subprocess.run(command, pass_fds=(certificate, key), check=False).returncode


def main() -> int:
    parser = argparse.ArgumentParser(
        prog="rolesanywhere-credentials",
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("--socket", required=True, help=argparse.SUPPRESS)
    parser.add_argument("--unit", required=True, help=argparse.SUPPRESS)
    parser.add_argument("--helper", required=True, help=argparse.SUPPRESS)
    parser.add_argument(
        "--certificate", action="store_true", help="print a fresh certificate instead"
    )
    parser.add_argument("--trust-anchor-arn")
    parser.add_argument("--profile-arn")
    parser.add_argument("--role-arn")
    parser.add_argument(
        "--endpoint",
        help="Roles Anywhere endpoint URL; by default the one in the trust anchor's region",
    )
    args = parser.parse_args()
    arns = (args.trust_anchor_arn, args.profile_arn, args.role_arn)
    if not args.certificate and None in arns:
        parser.error("--trust-anchor-arn, --profile-arn and --role-arn are required")

    try:
        issued = fetch(args.socket, args.unit)
    except Failure as error:
        print(f"rolesanywhere-credentials: {error}", file=sys.stderr)
        return 1
    if args.certificate:
        print(issued["certificate"], end="")
        return 0
    return credentials(args.helper, issued, args)


if __name__ == "__main__":
    sys.exit(main())
