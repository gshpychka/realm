"""The CA: one key inside this machine's TPM2 and its self-signed certificate,
which AWS trusts as an IAM Roles Anywhere trust anchor once registered.

`rolesanywhere ca` runs at boot and on every deploy. It keeps exactly one CA
the TPM2 signs with, in <stateDirectory>/<SKI>/ with <currentLink> pointing at
it, and replaces it when:
- there is none yet;
- the TPM2 no longer signs with it: PCR 7 changed (a Secure Boot key or dbx
  update, Secure Boot turned off), or the TPM2 was cleared;
- a replacement was requested (rolesanywhere-replace-ca).
AWS only trusts the CA certificate registered with it by hand, which
services.rolesanywhere.caCertificate names, and the issuer refuses until that
is the current CA. Every run logs whether it is, and how to register it if not.
"""

import datetime
import fcntl
import os
import shutil
import tempfile
from pathlib import Path

from cryptography import x509
from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.serialization import Encoding

from . import certificates
from .config import Config
from .log import log
from .tpm import Tpm, TpmError, check_attributes

PROBE = b"rolesanywhere probe"
# replaced this long before its certificate expires, so no client certificate outlives it
EXPIRY_MARGIN = datetime.timedelta(days=1)


def load_certificate(path: Path) -> x509.Certificate:
    return x509.load_pem_x509_certificate(path.read_bytes())


def problem(
    config: Config,
    tpm: Tpm,
    primary: Path,
    directory: Path,
    workdir: Path,
    now: datetime.datetime,
) -> str | None:
    """Why the CA in directory can't sign, or None if it can."""
    names = config["caFiles"]
    try:
        certificate = load_certificate(directory / names["certificate"])
    except (OSError, ValueError):
        return "its certificate is unreadable"
    context = workdir / "ca.ctx"
    try:
        tpm.load(
            primary, directory / names["public"], directory / names["private"], context
        )
        attributes, key = tpm.read_public(context, workdir / "key.pem")
        check_attributes(attributes)
    except TpmError as error:
        return f"this TPM2 does not hold its key ({error}); was the TPM2 cleared?"
    if key != certificate.public_key():
        return "its certificate is for another key"
    try:
        signature = tpm.sign(context, PROBE, workdir)
    except TpmError:
        return (
            "the TPM2 refuses to sign with its key: PCR 7 changed since it was created"
        )
    try:
        key.verify(signature, PROBE, ec.ECDSA(hashes.SHA256()))
    except InvalidSignature:
        return "its key's signature does not verify"
    if certificate.not_valid_after_utc - EXPIRY_MARGIN <= now:
        return "its certificate expires"
    return None


def generate(
    config: Config, tpm: Tpm, primary: Path, workdir: Path, now: datetime.datetime
) -> Path:
    """Has the TPM2 generate a CA key, certifies it, and stores both. Returns
    the CA's directory."""
    names = config["caFiles"]
    scratch = workdir / "new"
    scratch.mkdir()
    public, private = scratch / names["public"], scratch / names["private"]
    tpm.create(primary, public, private, scratch)
    context = scratch / "ca.ctx"
    tpm.load(primary, public, private, context)
    attributes, key = tpm.read_public(context, scratch / "key.pem")
    check_attributes(attributes)
    certificate = certificates.ca_certificate(
        config["name"], key, lambda message: tpm.sign(context, message, scratch), now
    )

    directory = Path(config["stateDirectory"]) / certificates.ski(certificate)
    directory.mkdir()
    # readable by all: the certificate is public, and is copied from here to register it
    directory.chmod(0o755)
    # the key's halves stay root's, though only this TPM2 can load them
    for half in (public, private):
        shutil.copyfile(half, directory / half.name)
        (directory / half.name).chmod(0o600)
    (directory / names["certificate"]).write_bytes(
        certificate.public_bytes(Encoding.PEM)
    )
    (directory / names["certificate"]).chmod(0o644)
    return directory


def link_current(config: Config, directory: Path) -> None:
    """Points the current link at directory, atomically."""
    link = Path(config["stateDirectory"]) / config["currentLink"]
    staged = link.with_name(f".{link.name}.new")
    staged.unlink(missing_ok=True)
    staged.symlink_to(directory.name)
    os.replace(staged, link)


def report_registration(config: Config, directory: Path) -> None:
    """Logs whether AWS trusts the current CA, and how to make it if not."""
    names = config["caFiles"]
    current = load_certificate(directory / names["certificate"])
    name = certificates.ski(current)
    registered_path = config["registeredCertificate"]
    if registered_path is None:
        reason = "none is registered yet"
    else:
        try:
            registered = load_certificate(Path(registered_path))
        except (OSError, ValueError):
            reason = f"{registered_path} is unreadable"
        else:
            if registered == current:
                log(f"CA {name} is the one registered with AWS")
                return
            reason = f"the registered one is {certificates.ski(registered)}"
    published = (
        Path(config["stateDirectory"]) / config["currentLink"] / names["certificate"]
    )
    log(
        f"CA {name} is not registered with AWS ({reason}), so no certificates are issued. "
        f"To register it, copy {published} into the file services.rolesanywhere.caCertificate names, "
        "update the Roles Anywhere trust anchor with it, and deploy this machine."
    )


def ensure(config: Config) -> int:
    tpm = Tpm(Path(config["tpm2Tools"]), config["tcti"])
    state = Path(config["stateDirectory"])
    link = state / config["currentLink"]
    replace_request = state / config["replaceRequest"]
    now = datetime.datetime.now(datetime.UTC)
    # one run at a time; context files go to the runtime directory, a tmpfs
    with (
        (state / ".lock").open("w") as lock,
        tempfile.TemporaryDirectory(dir=os.environ["RUNTIME_DIRECTORY"]) as scratch,
    ):
        fcntl.flock(lock, fcntl.LOCK_EX)
        workdir = Path(scratch)
        try:
            primary = tpm.primary(workdir)
        except TpmError as error:
            log(f"no CA: {error}; is there a usable TPM2?")
            return 1

        # the link's target is a directory name in state
        current = (
            state / link.readlink() if link.is_symlink() and link.exists() else None
        )
        if current is None:
            reason = "there is none yet"
        elif replace_request.exists():
            reason = "a replacement was requested"
        else:
            reason = problem(config, tpm, primary, current, workdir, now)
        if reason is not None:
            if current is not None:
                log(f"replacing CA {current.name}: {reason}")
            try:
                current = generate(config, tpm, primary, workdir, now)
            except (TpmError, ValueError) as error:
                log(f"could not generate a CA: {error}")
                return 1
            link_current(config, current)
            log(f"generated CA {current.name}")
        replace_request.unlink(missing_ok=True)

        for entry in state.iterdir():
            if entry.is_dir() and not entry.is_symlink() and entry.name != current.name:
                shutil.rmtree(entry)
                log(f"deleted CA {entry.name}")
        report_registration(config, current)
    return 0
