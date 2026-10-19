#!/usr/bin/env python3
"""Create native Mosquitto credentials offline, using its official utility.

Reads the imported HA broker login and optional private JSON client records.
Passwords never appear on a command line or stdout. No running service is used.
"""

import argparse
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

from private_paths import require_private_path


def prepare(source, clients, output, complete=False):
    for path in [source, output, *([clients] if clients else [])]:
        require_private_path(path)
    if output.exists():
        raise ValueError("refusing to overwrite existing credentials")
    executable = shutil.which("mosquitto_passwd")
    if executable is None:
        raise RuntimeError("mosquitto_passwd is required for offline hashing")
    entries = json.loads((source / ".storage/core.config_entries").read_text())["data"][
        "entries"
    ]
    users = {}
    logins = [entry["data"] for entry in entries if entry["domain"] == "mqtt"]
    if clients:
        logins.extend(json.loads(clients.read_text()))
    for login in logins:
        username, password = login["username"], login["password"]
        if (
            not isinstance(username, str)
            or not username
            or any(c in username for c in ":\r\n\x00")
        ):
            raise ValueError("invalid username")
        if (
            not isinstance(password, str)
            or not password
            or any(c in password for c in "\r\n\x00")
        ):
            raise ValueError("invalid password format")
        if username in users and users[username] != password:
            raise ValueError("conflicting credentials for the same client identity")
        users[username] = password
    if not users:
        raise ValueError("no imported broker identity")
    os.umask(0o077)
    output.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    if output.parent.stat().st_mode & 0o077:
        raise ValueError("output directory must be mode 0700")
    temporary = output.with_name(output.name + ".private-input-" + str(os.getpid()))
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(descriptor, "w") as stream:
            for username, password in sorted(users.items()):
                stream.write(username + ":" + password + "\n")
        process = subprocess.run(
            [executable, "-U", str(temporary)], capture_output=True, check=False
        )
        if process.returncode:
            raise RuntimeError(
                "offline password hashing failed; utility output suppressed"
            )
        hashed = dict(
            line.split(":", 1) for line in temporary.read_text().splitlines() if line
        )
        if set(hashed) != set(users) or any(
            not value.startswith("$") or value == users[name]
            for name, value in hashed.items()
        ):
            raise RuntimeError("password utility did not replace plaintext")
        # Hard-link creation is atomic and refuses a destination created by a
        # concurrent operator after the initial existence check. Never replace it.
        os.link(temporary, output)
    finally:
        temporary.unlink(missing_ok=True)
    return {
        "hashed_users": len(users),
        "complete_client_inventory_acknowledged": complete,
        "live_changes": False,
        "readiness_marker_created": False,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--clients", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--complete-client-inventory", action="store_true")
    args = parser.parse_args()
    try:
        report = prepare(
            args.source, args.clients, args.output, args.complete_client_inventory
        )
    except Exception as error:
        print(
            "Offline broker preparation failed: "
            + type(error).__name__
            + "; no private values printed",
            file=sys.stderr,
        )
        return 1
    print(json.dumps(report))
    return 0


if __name__ == "__main__":
    sys.exit(main())
