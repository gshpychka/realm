"""Install the shared HDMI remapper feature through an authorized Vetro session.

Run on hoard: python3 deploy.py TV_ADDRESS --helper ./result
Pair first with pair.py. Original Vetro files are backed up on the TV; use
--rollback to restore them. No remote-button assignments are created or changed.
"""

import argparse
import base64
import hashlib
import ipaddress
import json
import shlex
import time
import urllib.error
import urllib.request
from pathlib import Path

from patch import patched

parser = argparse.ArgumentParser()
parser.add_argument("tv", type=ipaddress.IPv4Address)
parser.add_argument("--helper", type=Path)
parser.add_argument("--rollback", action="store_true")
parser.add_argument("--helper-only", action="store_true")
args = parser.parse_args()
base = f"http://{args.tv}:8099"
token = (
    (Path.home() / ".config/realm-tv" / f"vetro-{args.tv}.token").read_text().strip()
)
directory = "/home/owner/share/vetro-source-shortcuts"
service = "/opt/usr/apps/vetrotvapp/res/wgt/service"
revision = "42bceac690aed4c3ac42cfd2c85f20054fc8c81b"
names = ("remap.js", "main.js", "dashboard.js")


def api(path, data=None):
    request = urllib.request.Request(
        base + path,
        data=None if data is None else json.dumps(data).encode(),
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        },
    )
    with urllib.request.urlopen(request, timeout=45) as response:
        return json.load(response)


def execute(command):
    result = api("/exec", {"cmd": command})
    if not result.get("ok") or result.get("timed_out"):
        raise RuntimeError(result.get("stderr") or result.get("output") or str(result))
    return result.get("output", "")


def upload(path, data):
    # Vetro's /exec request limit is 64 KiB. Stage bounded chunks; verify before install.
    execute(f": > {shlex.quote(path)}")
    for offset in range(0, len(data), 24000):
        chunk = base64.b64encode(data[offset : offset + 24000]).decode()
        execute(f"printf %s '{chunk}' | base64 -d >> {shlex.quote(path)}")
    digest = hashlib.sha256(data).hexdigest()
    execute("echo " + shlex.quote(f"{digest}  {path}") + " | sha256sum -c -")


def restart():
    old_pid = int(api("/status")["self"]["pid"])
    if old_pid < 2:
        raise RuntimeError("Invalid Vetro service PID")
    # Tizen can relaunch the package wrapper while retaining its JS service host.
    # End the PID Vetro itself reports, as its own updater does, then relaunch.
    execute(
        f"(sleep 2; kill -TERM {old_pid}; sleep 2; app_launcher -u 5001 -s vetrotvapp.svc) </dev/null "
        f">{directory}/restart.log 2>&1 &"
    )
    time.sleep(5)
    for _ in range(60):
        try:
            status = api("/status")
            if status.get("self", {}).get("pid") != old_pid and status.get(
                "agent", {}
            ).get("connected"):
                print("Vetro restarted with a connected root agent.", flush=True)
                return
        except (urllib.error.URLError, TimeoutError, ConnectionError):
            pass
        time.sleep(2)
    raise RuntimeError(
        "Vetro has not recovered yet; inspect state before retrying writes."
    )


status = api("/status")
if status.get("app", {}).get("sourceRevision") != revision:
    raise SystemExit(
        "Vetro source revision differs; rebase the integration before deploying."
    )
if not status.get("agent", {}).get("connected"):
    raise SystemExit("Vetro's root helper is not connected.")
rules_before = api("/remap")["rules"]

if args.rollback:
    execute(
        "set -e\n"
        + "\n".join(
            f"cat {directory}/backup/{name} > {service}/{name}" for name in names
        )
    )
    restart()
    print(
        "Original Vetro service files restored. Shared helper files and configuration retained."
    )
else:
    if not args.helper:
        parser.error("--helper is required")
    execute(f"mkdir -p {directory}/staging")
    for name in ("SourceShortcut.dll", "SourceShortcut.runtimeconfig.json"):
        upload(f"{directory}/{name}", (args.helper / name).read_bytes())
    print("Shared helper staged and hash-verified.", flush=True)
    if args.helper_only:
        raise SystemExit(0)

    originals = {name: execute(f"cat {service}/{name}") for name in names}
    updates = patched(originals)
    updates["source-shortcuts.js"] = (
        Path(__file__).with_name("source-shortcuts.js").read_text()
    )
    for name, text in updates.items():
        upload(f"{directory}/staging/{name}", text.encode())
    upload(
        f"{directory}/staging/targets.json",
        Path(__file__).with_name("targets.json").read_bytes(),
    )

    # Refuse an unreviewed redeploy and check that the source did not change during staging.
    commands = ["set -e", f"test ! -e {directory}/backup", f"mkdir {directory}/backup"]
    for name, text in originals.items():
        digest = hashlib.sha256(text.encode()).hexdigest()
        commands.append(
            "echo " + shlex.quote(f"{digest}  {service}/{name}") + " | sha256sum -c -"
        )
        commands.append(f"cp -p {service}/{name} {directory}/backup/{name}")
    execute("\n".join(commands))
    try:
        commands = ["set -e"]
        for name in updates:
            commands.append(f"cat {directory}/staging/{name} > {service}/{name}")
            commands.append(f"chmod 644 {service}/{name}")
        commands.append(f"cp {directory}/staging/targets.json {directory}/targets.json")
        commands.append(f"chmod 644 {directory}/targets.json")
        execute("\n".join(commands))
    except Exception:
        # Restore the existing files while the original service still runs in memory.
        execute(
            "set -e\n"
            + "\n".join(
                f"cat {directory}/backup/{name} > {service}/{name}" for name in names
            )
        )
        raise
    restart()
    for name, text in updates.items():
        digest = hashlib.sha256(text.encode()).hexdigest()
        execute(
            "echo " + shlex.quote(f"{digest}  {service}/{name}") + " | sha256sum -c -"
        )
    print(
        "HDMI source actions installed; original files backed up on the TV.", flush=True
    )

if api("/remap")["rules"] != rules_before:
    raise RuntimeError("Remote-button assignments changed unexpectedly.")
print("Existing remote-button assignments are unchanged.", flush=True)
