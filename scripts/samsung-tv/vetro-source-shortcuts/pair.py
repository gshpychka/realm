"""Pair the setup tool with Vetro; enter the TV code through a loopback form.

Run on hoard, and forward localhost:4794 from eve while pairing. The API key
stays in a mode-0600 file on hoard and is never sent to the browser or printed.
"""

import argparse
import html
import http.server
import ipaddress
import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument("tv", type=ipaddress.IPv4Address)
args = parser.parse_args()
base = f"http://{args.tv}:8099"
token_file = Path.home() / ".config/realm-tv" / f"vetro-{args.tv}.token"


def api(path, data):
    request = urllib.request.Request(
        base + path,
        data=json.dumps(data).encode(),
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(request, timeout=15) as response:
        return json.load(response)


pending = None
paired = False


class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def respond(self, message="", success=False):
        body = (
            "<!doctype html><meta charset=utf-8><title>Pair Vetro setup</title>"
            "<style>body{font:20px system-ui;max-width:34em;margin:4em auto}"
            "input,button{font:inherit;padding:.5em}input{width:8em}</style>"
            "<h1>Pair Vetro setup</h1>"
            f"<p>{html.escape(message)}</p>"
            + (
                "<p>You can close this tab.</p>"
                if success
                else "<p>Waiting for the previous code to expire. This page will refresh.</p>"
                "<meta http-equiv=refresh content=3>"
                if pending is None
                else "<p>Enter the six-digit code shown on your TV for "
                "<b>Realm HDMI shortcut setup</b>.</p>"
                "<form method=post><input name=code type=password inputmode=numeric "
                "pattern='[0-9]{6}' minlength=6 maxlength=6 required autofocus "
                "autocomplete=off aria-label='TV pairing code'> "
                "<button>Pair</button></form>"
            )
        ).encode()
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.headers.get("Host") not in ("localhost:4794", "127.0.0.1:4794"):
            self.send_error(403)
            return
        self.respond()

    def do_POST(self):
        global paired
        if self.headers.get("Host") not in (
            "localhost:4794",
            "127.0.0.1:4794",
        ) or self.headers.get("Origin") not in (
            "http://localhost:4794",
            "http://127.0.0.1:4794",
        ):
            self.send_error(403)
            return
        if pending is None:
            self.respond()
            return
        size = int(self.headers.get("Content-Length", "0"))
        if not 0 < size < 100:
            self.send_error(400)
            return
        code = urllib.parse.parse_qs(self.rfile.read(size).decode()).get("code", [""])[
            0
        ]
        if len(code) != 6 or not code.isascii() or not code.isdigit():
            self.respond("Enter exactly six digits.")
            return
        try:
            result = api("/auth/confirm", {"id": pending["id"], "code": code})
            if not result.get("ok") or not result.get("token"):
                raise ValueError("Pairing was not accepted.")
            token_file.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            fd = os.open(token_file, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
            with os.fdopen(fd, "w") as output:
                output.write(result["token"] + "\n")
            os.chmod(token_file, 0o600)
        except (urllib.error.HTTPError, ValueError):
            self.respond(
                "Pairing failed. Check the TV code and try again before it expires."
            )
            return
        self.respond(
            "Paired successfully. The setup tool can now finish the HDMI shortcut.",
            success=True,
        )
        paired = True


with http.server.HTTPServer(("127.0.0.1", 4794), Handler) as server:
    server.timeout = 1
    deadline = time.monotonic() + 300
    retry_at = 0
    print(
        "Open http://localhost:4794 and enter the code displayed on the TV.", flush=True
    )
    while not paired and time.monotonic() < deadline:
        if pending is None and time.monotonic() >= retry_at:
            try:
                pending = api("/auth/pair", {"name": "Realm HDMI shortcut setup"})
                print("Fresh pairing code requested on the TV.", flush=True)
            except urllib.error.HTTPError as error:
                if error.code != 429:
                    raise
                retry_at = time.monotonic() + 10
        server.handle_request()
if not paired:
    raise SystemExit("Pairing timed out; no API key saved.")
print("Vetro setup paired; API key saved privately on hoard.")
