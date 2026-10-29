"""The CA's ECDSA P-256 key, which this machine's TPM2 derives on demand.

The TPM2 derives a primary key from its owner hierarchy's secret seed and the
key's template, so the same seed and template always yield the same key, and
nothing is stored. The template carries a policy on PCR 7's current value, the
Secure Boot state, and the key signs only while PCR 7 holds that value. After
a Secure Boot change or a TPM2 clear, the TPM2 derives another key.
"""

import os
import subprocess
from pathlib import Path

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec

# the kernel's TPM2 resource manager, which flushes whatever a process loaded
# into the TPM2 when it exits
TCTI = "device:/dev/tpmrm0"
# PCR 7 holds the Secure Boot state: whether it is on, its keys and deny list,
# and which certificate verified each boot binary. It differs under another OS
# on the same disk, with Secure Boot off, or after a Secure Boot key or dbx
# update.
PCRS = "sha256:7"
# fixedtpm, fixedparent: the TPM2 refuses to export or duplicate the key.
# sensitivedataorigin: the TPM2 generated it, so it never existed outside.
# adminwithpolicy, and no userwithauth: every use of the key needs its
# policy (PCR 7). With userwithauth, the key's empty auth value would sign
# without the PCR check.
# noda: failures don't count towards the TPM2's dictionary-attack lockout,
# which would lock this key along with every other one.
ATTRIBUTES = "fixedtpm|fixedparent|sensitivedataorigin|adminwithpolicy|sign|noda"


class TpmError(Exception):
    pass


def _run(tool: str, *args: str | Path, input: bytes | None = None) -> None:
    """Runs a tpm2-tools command; its errors go to our stderr (the journal)."""
    try:
        subprocess.run(
            [f"tpm2_{tool}", *args],
            input=input,
            env={**os.environ, "TPM2TOOLS_TCTI": TCTI},
            stdout=subprocess.DEVNULL,
            check=True,
        )
    except subprocess.CalledProcessError as error:
        message = f"tpm2_{tool} failed (exit status {error.returncode})"
        raise TpmError(message) from error


def derive(workdir: Path) -> tuple[Path, ec.EllipticCurvePublicKey]:
    """Has the TPM2 derive the CA key; returns its context file and public key."""
    policy = workdir / "pcr.policy"
    context = workdir / "ca.ctx"
    public = workdir / "ca.pem"
    # the digest of "PCR 7 holds its current value", from a trial session
    _run("createpolicy", "--policy-pcr", "-l", PCRS, "-L", policy)
    _run(
        "createprimary",
        "-C",
        "o",
        "-G",
        "ecc256:ecdsa-sha256",
        "-a",
        ATTRIBUTES,
        "-L",
        policy,
        "-c",
        context,
        "-f",
        "pem",
        "-o",
        public,
    )
    key = serialization.load_pem_public_key(public.read_bytes())
    if not isinstance(key, ec.EllipticCurvePublicKey):
        raise TpmError("the CA key is not an EC key")
    return context, key


def sign(context: Path, message: bytes, workdir: Path) -> bytes:
    """Signs SHA-256(message) with the derived CA key. Returns a DER signature."""
    signature = workdir / "signature"
    _run(
        "sign",
        "-c",
        context,
        # satisfies the key's policy in a session of this process: the TPM2
        # checks PCR 7 itself
        "-p",
        f"pcr:{PCRS}",
        "-g",
        "sha256",
        "-s",
        "ecdsa",
        # "plain" for ECDSA is DER, as X.509 and the cryptography library take it
        "-f",
        "plain",
        "-o",
        signature,
        input=message,
    )
    return signature.read_bytes()
