"""The settings every server-side command takes: a JSON file written by Nix."""

import json
from pathlib import Path
from typing import TypedDict


class CaFiles(TypedDict):
    """A CA's files in <stateDirectory>/<SKI>/. Each is also the name of the
    credential systemd hands the file over as."""

    public: str  # the key's TPM2B_PUBLIC
    private: str  # the key's TPM2B_PRIVATE, wrapped by this TPM2's storage key
    certificate: str  # the self-signed CA certificate, PEM


class Config(TypedDict):
    # the machine's name: the first half of every certificate's subject
    name: str
    clients: list[str]
    certificateLifetimeSeconds: int
    # the CA certificate AWS trusts (services.rolesanywhere.caCertificate), or None
    # before the first one is registered
    registeredCertificate: str | None
    stateDirectory: str
    # symlink in stateDirectory to the current CA's directory
    currentLink: str
    # file in stateDirectory whose presence asks for the CA's replacement
    replaceRequest: str
    caFiles: CaFiles
    tpm2Tools: str
    tcti: str


def load(path: Path) -> Config:
    return json.loads(path.read_text())
