"""Take a protected, consistent service-state copy for encrypted restic backups.

Stop only active services and restore their running state even if copying fails.
"""

import fcntl
import json
import os
import shutil
import sqlite3
import subprocess
import sys
from pathlib import Path

SERVICES = (
    "ha-mcp",
    "home-assistant",
    "matter-server",
    "mosquitto",
    "tailscaled",
    "bluetooth",
)
JOURNAL = "/run/home-assistant-backup/active-services.json"


def command(*args, check=True):
    return subprocess.run(
        args, check=check, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL
    )


def restore_services():
    """Also called by systemd after SIGTERM/SIGKILL bypasses Python's finally."""
    journal = Path(JOURNAL)
    if not journal.exists():
        return
    active = json.loads(journal.read_text())
    if not isinstance(active, list) or any(name not in SERVICES for name in active):
        raise RuntimeError("invalid stopped-service journal needs operator review")
    if active:
        command("systemctl", "start", *reversed(active))
    # Keep the journal if starting any service fails, so recovery is retryable.
    journal.unlink()


def snapshot():
    if Path(JOURNAL).exists():
        raise RuntimeError("restore services from the previous backup before retrying")
    active = [
        name
        for name in SERVICES
        if command("systemctl", "is-active", "--quiet", name, check=False).returncode
        == 0
    ]
    staging = Path("/var/lib/home-assistant-backup.next")
    current = Path("/var/lib/home-assistant-backup")
    previous = Path("/var/lib/home-assistant-backup.previous")
    if staging.exists():
        raise RuntimeError("an incomplete previous snapshot needs operator review")
    sources = [
        Path("/var/lib") / name
        for name in (
            "hass",
            "matter-server",
            "mosquitto",
            "private/home-assistant",
            "ha-mcp",
            "tailscale",
            "bluetooth",
        )
    ]
    if any(not source.is_dir() for source in sources):
        raise RuntimeError("required persistent service state is missing")
    host_keys = sorted(Path("/etc/ssh").glob("ssh_host_*_key"))
    if not host_keys:
        raise RuntimeError("required SSH server identity is missing")
    staging.mkdir(mode=0o700)
    # Record before stopping: systemd's cleanup hook can recover after a killed
    # copy process, and a partially failed stop can still have stopped services.
    Path(JOURNAL).write_text(json.dumps(active))
    try:
        if active:
            command("systemctl", "stop", *active)
        for source in sources:
            # copytree/copy2 lose uid/gid when this root job copies service state.
            # Archive metadata is required for a usable restore. The trailing
            # /. follows DynamicUser's top-level /var/lib/ha-mcp symlink while
            # preserving symlinks *inside* each state directory.
            destination = staging / source.relative_to(Path("/var/lib"))
            destination.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            command(
                "cp",
                "--archive",
                "--reflink=auto",
                "--",
                str(source) + "/.",
                str(destination),
            )
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
        (staging / ".consistent-snapshot").touch(mode=0o600)
        if previous.exists():
            shutil.rmtree(previous)
        if current.exists():
            current.rename(previous)
        staging.rename(current)
    finally:
        restore_services()


def main(recover=False):
    os.umask(0o077)
    with Path("/run/home-assistant-backup/lock").open("w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if recover:
            restore_services()
        else:
            snapshot()


if __name__ == "__main__":
    if sys.argv[1:] not in ([], ["recover"]):
        raise SystemExit("usage: consistent-backup.py [recover]")
    main(recover=sys.argv[1:] == ["recover"])
