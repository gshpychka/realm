"""Calls one JSON-RPC method of the Kodi on this box and prints its result.

Usage: python3 rpc.py METHOD [PARAMS_JSON]
"""

import json
import socket
import sys


def call(method, params=None):
    """The method's result, or Kodi's error object when the call fails."""
    request = {"jsonrpc": "2.0", "id": 1, "method": method, "params": params or {}}
    with socket.create_connection(("127.0.0.1", 9090), timeout=10) as conn:
        conn.sendall(json.dumps(request).encode())
        decoder = json.JSONDecoder()
        buffer = ""
        while True:
            chunk = conn.recv(65536)
            if not chunk:
                raise ConnectionError("Kodi closed the JSON-RPC connection")
            buffer += chunk.decode(errors="replace")
            # the connection also carries Kodi's notifications, back to back
            pos = 0
            while True:
                while pos < len(buffer) and buffer[pos].isspace():
                    pos += 1
                try:
                    reply, pos = decoder.raw_decode(buffer, pos)
                except ValueError:
                    break
                if reply.get("id") == 1:
                    return reply.get("result", reply.get("error"))
            buffer = buffer[pos:]


if __name__ == "__main__":
    params = json.loads(sys.argv[2]) if len(sys.argv) > 2 else None
    print(json.dumps(call(sys.argv[1], params)))
