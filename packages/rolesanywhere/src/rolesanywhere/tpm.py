"""The CA's ECDSA P-256 key inside this machine's TPM2, driven with tpm2-tools.

The key is generated inside the TPM2 and never leaves it. On disk is only the
key wrapped by the TPM2's own storage key, which only this TPM2 can load. The
key has no auth value: the TPM2 signs with it only while PCR 7 holds the value
it had when the key was created, which it checks itself on every signature.
So there is no secret outside the TPM2 at all.
"""

import subprocess
from dataclasses import dataclass
from pathlib import Path

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec

# The parent of the CA key: a primary key in the owner (storage) hierarchy.
# The TPM2 derives it from the hierarchy's secret seed and this template, so
# creating it again yields the same key and it is never stored. Assumes the
# owner hierarchy has no auth value, the Linux default. Clearing the TPM2
# (from the firmware setup or Windows) replaces the seed, and with it the CA.
PRIMARY_KEY = ["-C", "o", "-g", "sha256", "-G", "ecc256:aes128cfb"]
# PCR 7 holds the Secure Boot state: whether it is on, its keys and deny list,
# and which certificate verified each boot binary. It differs under another
# OS on the same disk (Windows' boot manager is verified by Microsoft's
# certificate, NixOS's by this machine's own), with Secure Boot off, or after
# a Secure Boot key or dbx update; the TPM2 refuses to sign in all of them.
PCRS = "sha256:7"
CA_KEY = [
    "-G",
    "ecc256:ecdsa-sha256",
    # fixedtpm, fixedparent: the TPM2 refuses to export or duplicate the key.
    # sensitivedataorigin: the TPM2 generated it, so it never existed outside.
    # adminwithpolicy, and no userwithauth: every use of the key needs its
    # policy (PCR 7), never an auth value. With userwithauth, the key's empty
    # auth value would sign without the PCR check.
    # noda: failures don't count towards the TPM2's dictionary-attack lockout,
    # which would lock this key along with every other one.
    "-a",
    "fixedtpm|fixedparent|sensitivedataorigin|adminwithpolicy|sign|noda",
]
REQUIRED_ATTRIBUTES = frozenset(
    {"fixedtpm", "fixedparent", "sensitivedataorigin", "adminwithpolicy", "sign"}
)
FORBIDDEN_ATTRIBUTES = frozenset({"userwithauth"})


class TpmError(Exception):
    pass


@dataclass(frozen=True)
class Tpm:
    """This machine's TPM2. Each command is a separate tpm2-tools process,
    passing the TPM2's objects on in context files. Through the kernel's
    resource manager (tcti device:/dev/tpmrm0), every object a process loaded
    is flushed when it exits, so a killed command leaves nothing behind in the
    TPM2."""

    tools: Path
    tcti: str

    def run(self, tool: str, *args: str | Path, input: bytes | None = None) -> str:
        """Runs a tpm2-tools command; its errors go to our stderr (the journal)."""
        try:
            result = subprocess.run(
                [self.tools / f"tpm2_{tool}", *args],
                input=input,
                env={"TPM2TOOLS_TCTI": self.tcti},
                stdout=subprocess.PIPE,
                check=True,
            )
        except subprocess.CalledProcessError as error:
            message = f"tpm2_{tool} failed (exit status {error.returncode})"
            raise TpmError(message) from error
        return result.stdout.decode()

    def primary(self, workdir: Path) -> Path:
        """The parent of the CA key, loaded; returns its context file."""
        context = workdir / "primary.ctx"
        self.run("createprimary", *PRIMARY_KEY, "-c", context)
        return context

    def create(self, primary: Path, public: Path, private: Path, workdir: Path) -> None:
        """Has the TPM2 generate a CA key bound to the current PCR 7, and
        writes its wrapped halves."""
        policy = workdir / "pcr.policy"
        # the digest of "PCR 7 holds its current value", from a trial session
        self.run("createpolicy", "--policy-pcr", "-l", PCRS, "-L", policy)
        self.run(
            "create", "-C", primary, *CA_KEY, "-L", policy, "-u", public, "-r", private
        )

    def load(self, primary: Path, public: Path, private: Path, context: Path) -> None:
        """Loads a key this TPM2 wrapped; fails for any other TPM2's key."""
        self.run("load", "-C", primary, "-u", public, "-r", private, "-c", context)

    def read_public(
        self, context: Path, pem: Path
    ) -> tuple[frozenset[str], ec.EllipticCurvePublicKey]:
        """A loaded key's attributes and public key."""
        report = self.run(
            "readpublic", "-c", context, "-f", "pem", "-o", pem
        ).splitlines()
        # "attributes:", then "  value: fixedtpm|fixedparent|..."
        value = report[report.index("attributes:") + 1].strip().removeprefix("value:")
        key = serialization.load_pem_public_key(pem.read_bytes())
        if not isinstance(key, ec.EllipticCurvePublicKey) or not isinstance(
            key.curve, ec.SECP256R1
        ):
            raise TpmError("the key is not a P-256 key")
        return frozenset(value.strip().split("|")), key

    def sign(self, key: Path, message: bytes, workdir: Path) -> bytes:
        """Signs SHA-256(message) with a loaded CA key. Returns a DER signature."""
        signature = workdir / "signature"
        self.run(
            "sign",
            "-c",
            key,
            # satisfies the key's policy in a session of this process: the
            # TPM2 checks PCR 7 itself
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


def check_attributes(attributes: frozenset[str]) -> None:
    """Refuses a key that could leave the TPM2 or sign without the PCR check."""
    if not attributes >= REQUIRED_ATTRIBUTES or attributes & FORBIDDEN_ATTRIBUTES:
        raise TpmError(
            f"the key has the wrong attributes: {'|'.join(sorted(attributes))}"
        )
