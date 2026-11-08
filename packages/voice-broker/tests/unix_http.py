"""A scripted HTTP/1.1 peer on a Unix socket, in the standard library only."""

from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlsplit


@dataclass(frozen=True)
class Request:
    method: str
    path: str
    query: dict[str, list[str]]
    body: Any


# What the peer does with a request: (status, JSON body or raw bytes), or None to hang up unanswered.
Respond = Callable[[Request], Awaitable[tuple[int, Any] | None]]


@asynccontextmanager
async def serve(socket: Path, respond: Respond) -> AsyncIterator[list[Request]]:
    """Answers each request on `socket` with `respond`; yields the requests as they arrive."""
    requests: list[Request] = []

    async def handle(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        try:
            head = (await reader.readuntil(b"\r\n\r\n")).decode()
            line, *fields = head.split("\r\n")
            method, target, _ = line.split(" ")
            headers = {k.strip().lower(): v.strip() for k, v in (f.split(":", 1) for f in fields if ":" in f)}
            raw = await reader.readexactly(int(headers.get("content-length", "0")))
            url = urlsplit(target)
            request = Request(method, url.path, parse_qs(url.query), json.loads(raw) if raw else None)
            requests.append(request)
            answer = await respond(request)
            if answer is None:
                return
            status, body = answer
            data = body if isinstance(body, bytes) else json.dumps(body).encode()
            writer.write(
                f"HTTP/1.1 {status} X\r\nContent-Type: application/json\r\nContent-Length: {len(data)}\r\n"
                f"Connection: close\r\n\r\n".encode()
                + data
            )
            await writer.drain()
        finally:
            writer.close()

    server = await asyncio.start_unix_server(handle, path=str(socket))
    try:
        yield requests
    finally:
        server.close()
        await server.wait_closed()
