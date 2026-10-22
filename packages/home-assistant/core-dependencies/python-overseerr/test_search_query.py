"""Search must reach the HTTP server without pre-encoding query values."""

import pytest
from aiohttp import web
from aiohttp.test_utils import TestServer
from python_overseerr import OverseerrClient

from tests import load_fixture


@pytest.mark.parametrize(
    "keyword",
    [
        "frosty the snowman",
        "100% real",
        "one&two+three/?#=%20",
        "Дюна: Частина друга",
    ],
    ids=["spaces", "percent", "reserved", "unicode"],
)
async def test_search_query_received_verbatim(keyword: str) -> None:
    """Exercise aiohttp's actual request URL and the server's query parser."""
    received = []

    async def search(request: web.Request) -> web.Response:
        received.append(list(request.query.items()))
        return web.Response(
            text=load_fixture("overseerr/search_1.json"),
            content_type="application/json",
        )

    app = web.Application()
    app.router.add_get("/api/v1/search", search)
    async with (
        TestServer(app) as server,
        OverseerrClient(server.host, server.port, "test-key", ssl=False) as client,
    ):
        assert await client.search(keyword)

    assert received == [[("query", keyword)]]
