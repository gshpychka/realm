"""Applies Kodi settings to the running Kodi over JSON-RPC.

Reads "id value" lines from stdin, the value a JSON literal, skipping blank and
# lines. Sets each setting whose value differs and prints "changed <id> <value>"
for it, or "rejected <id>" when Kodi refuses it: Kodi refuses a setting it lacks
and one that a setting it depends on hides.
"""

import json
import socket
import sys

rows = []
for line in sys.stdin:
    line = line.strip()
    if line and not line.startswith("#"):
        setting, value = line.split(None, 1)
        rows.append((setting, json.loads(value)))

decoder = json.JSONDecoder()
conn = socket.create_connection(("127.0.0.1", 9090), timeout=10)


def call_batch(method, params):
    """Replies to one call of method per params entry, in order."""
    batch = [
        {"jsonrpc": "2.0", "id": i, "method": method, "params": p}
        for i, p in enumerate(params)
    ]
    conn.sendall(json.dumps(batch).encode())
    received = b""
    while True:
        chunk = conn.recv(65536)
        if not chunk:
            sys.exit("Kodi closed the JSON-RPC connection before replying")
        received += chunk
        text = received.decode(errors="replace")
        pos = 0
        while True:
            while pos < len(text) and text[pos].isspace():
                pos += 1
            try:
                reply, pos = decoder.raw_decode(text, pos)
            except ValueError:
                break
            # Announcements share the connection; the batch's reply is a list.
            if isinstance(reply, list):
                return sorted(reply, key=lambda r: r["id"])


current = call_batch("Settings.GetSettingValue", [{"setting": s} for s, _ in rows])
changes = [
    (s, v)
    for (s, v), reply in zip(rows, current, strict=True)
    if reply.get("result", {}).get("value") != v
]
# Kodi runs a batch's calls in order, so a setting takes effect before the ones
# after it that depend on it.
results = (
    call_batch(
        "Settings.SetSettingValue", [{"setting": s, "value": v} for s, v in changes]
    )
    if changes
    else []
)
for (setting, value), reply in zip(changes, results, strict=True):
    print(
        f"changed {setting} {json.dumps(value)}"
        if reply.get("result") is True
        else f"rejected {setting}"
    )
