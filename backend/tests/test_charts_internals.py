"""charts.Charts._gql details the endpoint tests reached only loosely — found
by the T42 mutation pass: the client identity IMDb's edge requires (without
the `x-imdb-client-name` header it answers 403, see trending.py), the
request timeout, and a GraphQL answer that carries `errors` next to `data`."""

from __future__ import annotations

import asyncio
import json

import httpx
import pytest

from reel_api import charts as charts_mod
from reel_api.charts import Charts, ChartsError


@pytest.fixture
def gql(upstream):
    return upstream.post(charts_mod.IMDB_GRAPHQL)


async def test_gql_identifies_as_imdb_web_next(gql):
    gql.respond(200, json={"data": {"x": 1}})
    c = Charts({})
    assert await c._gql("query Q { x }", {"a": 1}) == {"x": 1}
    req = gql.calls.last.request
    assert req.headers["x-imdb-client-name"] == "imdb-web-next"
    assert json.loads(req.content) == {"query": "query Q { x }", "variables": {"a": 1}}
    assert c._client.timeout == httpx.Timeout(20)


async def test_gql_errors_next_to_data_are_an_error(gql):
    errors = [{"message": "m" * 300}]
    gql.respond(200, json={"errors": errors, "data": {"x": 1}})
    with pytest.raises(ChartsError) as e:
        await Charts({})._gql("q", {})
    assert str(e.value) == "imdb: " + str(errors)[:200]


async def test_gql_runs_at_most_six_requests_at_once(gql):
    running, peak = [0], [0]
    release = asyncio.Event()

    async def slow(request):
        running[0] += 1
        peak[0] = max(peak[0], running[0])
        await release.wait()
        running[0] -= 1
        return httpx.Response(200, json={"data": {}})

    gql.mock(side_effect=slow)
    c = Charts({})
    tasks = [asyncio.create_task(c._gql("q", {})) for _ in range(8)]
    for _ in range(50):
        await asyncio.sleep(0)
    release.set()
    for t in tasks:
        with pytest.raises(ChartsError):  # empty data
            await t
    assert peak[0] == 6
