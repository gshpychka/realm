"""The issuer's settings: a JSON file written by Nix."""

import json
from pathlib import Path
from typing import TypedDict


class Config(TypedDict):
    # the machine's name: the first half of every certificate's subject
    name: str
    clients: list[str]
    certificateLifetimeSeconds: int
    # the CA certificate registered with AWS (services.rolesanywhere.caCertificate)
    caCertificate: str


def load(path: Path) -> Config:
    return json.loads(path.read_text())
