"""FUTURE operator-enabled restic preparation; never run in this migration.

Stop only the services that were running, take a consistent protected copy,
then restore their prior running state even when the copy fails. This causes
a short planned HA outage. No timer can use it before owner provisioning.
"""

import argparse
import fcntl
import json
import os
import shutil
import sqlite3
import subprocess
from pathlib import Path

SERVICES = (
    "ha-mcp",
    "home-assistant",
    "matter-server",
    "mosquitto",
    "tailscaled",
    "bluetooth",
)


def command(*args, check=True):
    return subprocess.run(
        args, check=check, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL
    )


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--operator-enabled", action="store_true", required=True)
    parser.parse_args()
    if not Path("/var/lib/private/home-assistant/.backup-enabled").is_file():
        raise RuntimeError("backup is not owner-enabled")
    os.umask(0o077)
    with Path("/run/lock/home-assistant-backup.lock").open("w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        active = [
            name
            for name in SERVICES
            if command(
                "systemctl", "is-active", "--quiet", name, check=False
            ).returncode
            == 0
        ]
        staging = Path("/var/lib/home-assistant-backup.next")
        current = Path("/var/lib/home-assistant-backup")
        previous = Path("/var/lib/home-assistant-backup.previous")
        if staging.exists():
            raise RuntimeError("an incomplete previous snapshot needs operator review")
        staging.mkdir(mode=0o700)
        try:
            if active:
                command("systemctl", "stop", *active)
            for name in [
                "hass",
                "matter-server",
                "mosquitto",
                "private/home-assistant",
                "ha-mcp",
                "tailscale",
                "bluetooth",
            ]:
                source = Path("/var/lib") / name
                if not source.is_dir():
                    raise RuntimeError("required persistent service state is missing")
                shutil.copytree(source, staging / name, symlinks=True)
            host_keys = sorted(Path("/etc/ssh").glob("ssh_host_*_key"))
            if not host_keys:
                raise RuntimeError("required SSH server identity is missing")
            key_directory = staging / "ssh-host-keys"
            key_directory.mkdir(mode=0o700)
            for key in host_keys:
                for source in [key, key.with_name(key.name + ".pub")]:
                    if source.is_file():
                        destination = key_directory / source.name
                        shutil.copyfile(source, destination)
                        destination.chmod(0o600)
            for name in ["home-assistant_v2.db", "zigbee.db"]:
                database = staging / "hass" / name
                if not database.is_file():
                    raise RuntimeError("required SQLite database missing")
                with sqlite3.connect(
                    database.as_uri() + "?mode=ro", uri=True
                ) as connection:
                    if connection.execute("PRAGMA quick_check").fetchone() != ("ok",):
                        raise RuntimeError("SQLite validation failed")
            (staging / ".consistent-snapshot").write_text(
                json.dumps({"format": 1, "services_stopped": active}) + "\n"
            )
            if previous.exists():
                shutil.rmtree(previous)
            if current.exists():
                current.rename(previous)
            staging.rename(current)
        finally:
            if active:
                command("systemctl", "start", *reversed(active))


if __name__ == "__main__":
    main()
