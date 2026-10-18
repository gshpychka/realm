"""Local Hermes API credentials and authenticated service readiness.

The credential stays on the host, outside the Nix store and process arguments.
Run as the Hermes service user; never print the resulting key.
"""

import argparse
import json
import os
import re
import secrets
import stat
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path


def api_key(path: Path) -> str:
    with os.fdopen(os.open(path, os.O_RDONLY | os.O_NOFOLLOW)) as handle:
        info = os.fstat(handle.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_mode & 0o077:
            raise ValueError(
                "Hermes API credential must be a private regular file (0600)"
            )
        value = handle.read()
    match = re.fullmatch(r"API_SERVER_KEY=([A-Za-z0-9_-]{43,})\n", value)
    if not match:
        raise ValueError("Malformed Hermes API credential; preserve it and investigate")
    return match[1]


def prepare(path: Path) -> None:
    # O_EXCL preserves an existing credential, including a dangling symlink.
    # Complete the write before systemd starts the gateway with EnvironmentFile.
    try:
        descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError:
        api_key(path)
        return
    with os.fdopen(descriptor, "w") as handle:
        handle.write(f"API_SERVER_KEY={secrets.token_urlsafe(48)}\n")
        handle.flush()
        os.fsync(handle.fileno())


def sync_environment(
    destination: Path, base: Path, sources: list[str], credential: Path
) -> None:
    """Refresh the dotenv file Hermes loads with override=True, atomically."""
    with base.open() as handle:
        values = json.load(handle)
    sections = [
        "\n".join(f"{name}={json.dumps(value)}" for name, value in values.items())
    ]
    for source in sources:
        optional = source.startswith("-")
        path = Path(source[1:] if optional else source)
        try:
            sections.append(path.read_text())
        except FileNotFoundError:
            if not optional:
                raise
    # The generated credential wins over accidental integration-file copies.
    sections.append(f"API_SERVER_KEY={api_key(credential)}\n")
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w", dir=destination.parent, delete=False
        ) as handle:
            temporary = Path(handle.name)
            handle.write("\n".join(sections) + "\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, destination)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def ready(path: Path, port: int, timeout: float) -> None:
    key = api_key(path)
    # Do not send this local credential through a configured HTTP proxy.
    client = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    request = urllib.request.Request(
        f"http://127.0.0.1:{port}/health/detailed",
        headers={"Authorization": f"Bearer {key}"},
    )
    deadline = time.monotonic() + timeout
    while True:
        try:
            with client.open(
                request, timeout=min(3, max(0.1, deadline - time.monotonic()))
            ) as response:
                body = json.load(response)
                if (
                    response.status == 200
                    and isinstance(body, dict)
                    and body.get("status") == "ok"
                    and body.get("platform") == "hermes-agent"
                ):
                    return
        except urllib.error.HTTPError as error:
            if error.code in (401, 403):
                raise RuntimeError("Hermes rejected its local API credential") from None
        except (OSError, ValueError):
            pass
        if time.monotonic() >= deadline:
            raise RuntimeError("Hermes authenticated API did not become ready")
        time.sleep(min(1, max(0, deadline - time.monotonic())))


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("operation", choices=["prepare", "ready", "sync-environment"])
    parser.add_argument("--credential", type=Path, required=True)
    parser.add_argument("--port", type=int, default=8642)
    parser.add_argument("--timeout", type=float, default=90)
    parser.add_argument("--destination", type=Path)
    parser.add_argument("--base", type=Path)
    parser.add_argument("--source", action="append", default=[])
    args = parser.parse_args()
    if args.operation == "prepare":
        prepare(args.credential)
    elif args.operation == "ready":
        ready(args.credential, args.port, args.timeout)
    else:
        if args.destination is None or args.base is None:
            parser.error("sync-environment requires --destination and --base")
        sync_environment(args.destination, args.base, args.source, args.credential)


if __name__ == "__main__":
    main()
