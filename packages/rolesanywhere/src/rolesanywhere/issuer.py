"""Issues one short-lived client certificate to the caller of an accepted connection.

systemd starts `serve` per connection (Accept=yes) with the accepted socket as
stdin, and the current CA's files as credentials. The caller is identified by
the UID the kernel recorded when it connected (SO_PEERCRED). Nothing is read
from the connection, so there is no request to parse or forge.

A declared client gets one JSON line back: a fresh P-256 key, generated here
in memory, and a certificate for it with the subject "<name>:<user>", signed
by the CA in the TPM2 and valid for certificateLifetimeSeconds:
{"certificate": PEM, "privateKey": PEM, "expiresAt": unix time}. Together they
get AWS credentials until the certificate expires, the same way a short-lived
token would. Anyone else gets {"error": ...}.
"""

import datetime
import json
import os
import pwd
import socket
import struct
import sys
import tempfile
from pathlib import Path

from cryptography import x509
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec

from . import certificates
from .ca import load_certificate
from .config import Config
from .log import log
from .tpm import Tpm, TpmError

# struct ucred: pid, uid, gid
UCRED = struct.Struct("3i")


class IssuerError(Exception):
    pass


def peer_credentials(conn: socket.socket) -> tuple[int, int]:
    """(pid, uid) of the connecting process, as the kernel recorded at connect()."""
    pid, uid, _gid = UCRED.unpack(
        conn.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, UCRED.size)
    )
    return pid, uid


def read_proc(pid: int, name: str) -> str:
    """A /proc file the caller controls, escaped like a bytes literal. A
    process can name itself (comm) or its cgroup anything: invalid UTF-8, or
    a newline that journald would turn into a forged log line of its own."""
    raw = Path(f"/proc/{pid}/{name}").read_bytes().removesuffix(b"\n")
    return repr(raw)[2:-1]


def describe_process(pid: int) -> str:
    """Best effort, for the audit log only: by now the PID may be another process."""
    try:
        command = read_proc(pid, "comm")
        cgroup = read_proc(pid, "cgroup")
    except OSError:
        return f"pid {pid}"
    # cgroup v2: a single "0::<path>" line
    return f"pid {pid} {command} in {cgroup.removeprefix('0::')}"


def reply(conn: socket.socket, message: dict[str, str | int]) -> None:
    conn.sendall(json.dumps(message).encode() + b"\n")


def issue(
    config: Config, subject: str, key: ec.EllipticCurvePrivateKey
) -> x509.Certificate:
    """A certificate for key, signed by the current CA, if AWS trusts it."""
    # systemd copied the current CA's files into this per-service, in-memory directory
    credentials = Path(os.environ["CREDENTIALS_DIRECTORY"])
    names = config["caFiles"]
    ca = load_certificate(credentials / names["certificate"])
    registered = config["registeredCertificate"]
    try:
        trusted = registered is not None and load_certificate(Path(registered)) == ca
    except (OSError, ValueError):
        trusted = False
    if not trusted:
        # AWS would reject its certificates; see ca.report_registration
        raise IssuerError(
            f"this machine's CA {certificates.ski(ca)} is not registered with AWS; "
            "see journalctl -u rolesanywhere-ca"
        )
    tpm = Tpm(Path(config["tpm2Tools"]), config["tcti"])
    try:
        with tempfile.TemporaryDirectory() as scratch:
            workdir = Path(scratch)
            context = workdir / "ca.ctx"
            tpm.load(
                tpm.primary(workdir),
                credentials / names["public"],
                credentials / names["private"],
                context,
            )
            return certificates.client_certificate(
                subject,
                key.public_key(),
                ca,
                lambda message: tpm.sign(context, message, workdir),
                datetime.datetime.now(datetime.UTC),
                datetime.timedelta(seconds=config["certificateLifetimeSeconds"]),
            )
    except TpmError as error:
        raise IssuerError(
            f"the TPM2 did not sign ({error}); see journalctl -u rolesanywhere-ca"
        ) from error
    except ValueError as error:
        raise IssuerError(str(error)) from error


def serve(config: Config) -> int:
    conn = socket.socket(fileno=sys.stdin.fileno())
    pid, uid = peer_credentials(conn)
    try:
        user = pwd.getpwuid(uid).pw_name
    except KeyError:
        user = None
    caller = f"{user or f'uid {uid}'} ({describe_process(pid)})"

    if user is None or user not in config["clients"]:
        log(f"refused {caller}: not in services.rolesanywhere.clients")
        reply(
            conn,
            {
                "error": f"{user or f'uid {uid}'} is not in services.rolesanywhere.clients"
            },
        )
        return 0

    subject = f"{config['name']}:{user}"
    key = ec.generate_private_key(ec.SECP256R1())
    try:
        certificate = issue(config, subject, key)
    except (IssuerError, OSError) as error:
        log(f"refused {caller}: {error}")
        reply(conn, {"error": str(error)})
        return 1
    expires_at = int(certificate.not_valid_after_utc.timestamp())
    reply(
        conn,
        {
            "certificate": certificate.public_bytes(
                serialization.Encoding.PEM
            ).decode(),
            "privateKey": key.private_bytes(
                serialization.Encoding.PEM,
                serialization.PrivateFormat.PKCS8,
                serialization.NoEncryption(),
            ).decode(),
            "expiresAt": expires_at,
        },
    )
    # the session's name, so CloudTrail's events trace back to the process logged here
    log(
        f"issued {certificates.serial_hex(certificate)} subject={subject} until={expires_at} to {caller}"
    )
    return 0
