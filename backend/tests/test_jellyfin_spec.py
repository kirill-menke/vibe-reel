"""JellyfinSim against Jellyfin 12.1's OpenAPI (the subset in
tests/specs/jellyfin-12.1-subset.json, fetched by tests/fetch_fixtures.py and
git-ignored; never skipped: without it every test here fails with the fetch
command).

The guard itself (`jellyfin_spec_guard` in conftest.py) checks every request
and answer of every push test; here: the subset covers what push.py calls,
the validator catches what it claims to, and the sim's own answers pass.
"""

from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path

import httpx
import pytest

from tests.specs import vendor_jellyfin
from tests.support import jellyfin
from tests.support.fetched import FETCH, require
from tests.support.jellyfin import SERVER_ID, JellyfinSim, jf_id
from tests.support.jfspec import SUBSET, jf_spec

BASE = "http://jellyfin.test"
AUTH = {"Authorization": 'MediaBrowser Client="reel-api", Device="NAS", DeviceId="d", Version="1", Token="tok"'}
PUSH = Path(__file__).resolve().parents[1] / "src" / "reel_api" / "push.py"


@pytest.fixture(autouse=True)
def _subset_fetched():
    require(SUBSET)


def test_the_subset_is_vendored_from_12_1():
    src = json.loads(SUBSET.read_text())["x-source"]
    assert src["version"] == "12.1.0" and src["sha256"] == vendor_jellyfin.SOURCE_SHA256
    assert set(jf_spec().ops) == {"GET /Users/Me", "GET /Items", "GET /Shows/{seriesId}/Episodes"}


def test_the_subset_is_derived_from_the_pinned_spec():
    """Not in git, so nothing reviews it: it must be exactly what vendor_jellyfin.py
    derives from the pinned 12.1.0 spec (cached next to it by fetch_fixtures.py)."""
    raw = require(vendor_jellyfin.DEFAULT_SRC).read_bytes()
    assert hashlib.sha256(raw).hexdigest() == vendor_jellyfin.SOURCE_SHA256
    assert SUBSET.read_text() == vendor_jellyfin.derive(raw), "re-derive: " + FETCH + " jellyfin"


def test_every_jellyfin_route_push_calls_is_in_the_subset():
    """push.py's `_jf(token, "<path>", …)` calls, read from the source: each
    must match a vendored operation (a new route needs vendor_jellyfin.py)."""
    paths = re.findall(r'_jf\(token, f?"([^"]+)"', PUSH.read_text())
    assert paths, "push.py's Jellyfin calls not found — update this test"
    for p in paths:
        concrete = re.sub(r"\{[^}]+\}", jf_id("x"), p)
        assert jf_spec().match("GET", concrete), p


# ---------------------------------------------------------------- the validator bites


def req(path, params=None, headers=AUTH):
    return httpx.Request("GET", BASE + path, params=params, headers=headers)


@pytest.mark.parametrize("request_,problem", [
    (req("/Users/Me/Views"), "route not in the 12.1 subset"),
    (req("/Items", {"Recursive": "yes"}), "query Recursive='yes' is not a boolean"),
    (req("/Items", {"Limit": "3000000000"}), "is not an int32"),
    (req("/Items", {"IncludeItemTypes": "Series,Show"}), "query IncludeItemTypes='Series,Show' is not one of the enum"),
    (req("/Items", {"Fields": "ProviderIds,ImdbId"}), "is not one of the enum"),
    (req("/Items", {"userId": "anna"}), "query userId='anna' is not a uuid"),
    (req("/Items", {"SearchTitle": "Silo"}), "unknown query parameter 'SearchTitle'"),
    (req("/Shows/silo/Episodes"), "path seriesId='silo' is not a uuid"),
    (req("/Items", headers={"Authorization": 'MediaBrowser Client="reel-api", Token="tok"'}),
     "Authorization lacks Device, DeviceId, Version"),
    (req("/Items", headers={"Authorization": 'MediaBrowser Token=""'}),
     "Authorization lacks Client, Device, DeviceId, Version, Token"),
    (req("/Items", headers={"Authorization": 'MediaBrowser Client="reel-api", Device="NAS", '
                                             'DeviceId="d", Version="1"'}), "Authorization lacks Token"),
    (req("/Items", headers={**AUTH, "X-Emby-Authorization": AUTH["Authorization"]}), "X-Emby-Authorization"),
])
def test_requests_off_the_spec_are_caught(request_, problem):
    assert any(problem in p for p in jf_spec().request(request_)), jf_spec().request(request_)


def test_a_token_only_header_passes():
    """12.1 answers `MediaBrowser Token="…"` alone from the token's own device
    record (measured 2026-10-05) — the request guard (security.py) asks
    /Users/Me that way. Anything between that and the full header is still
    caught above."""
    assert jf_spec().request(req("/Users/Me", headers={"Authorization": 'MediaBrowser Token="tok"'})) == []


async def test_the_guards_users_me_traffic_passes(jf_auth):
    """The request guard's real check (security.JellyfinAuth) against its sim
    (conftest's JellyfinAuthSim): Token-only request, UserDto / 401 answers,
    all on the 12.1 spec — and a sim answer off it would be caught."""
    from reel_api import security
    from tests.conftest import JELLYFIN, TEST_TOKEN, TEST_USER

    auth = security.JellyfinAuth(JELLYFIN)
    assert await auth.user(TEST_TOKEN) == TEST_USER
    assert await auth.user("unknown-token-0123456789abcdef") is None
    assert jf_auth.asked == [TEST_TOKEN, "unknown-token-0123456789abcdef"]
    assert jf_auth.violations == []
    assert jf_spec().response("GET /Users/Me", 200, {"Id": TEST_USER, "Admin": True}, set()) == [
        "JellyfinSim GET /Users/Me -> 200: $.Admin: not in the UserDto schema"]


def test_requests_push_sends_pass():
    uid = jf_id("user:anna")
    for r in (req("/Users/Me"),
              req("/Items", {"SearchTerm": "Silo", "IncludeItemTypes": "Series", "Recursive": "true",
                             "Fields": "ProviderIds", "Limit": 20, "userId": uid}),
              req(f"/Shows/{jf_id('s')}/Episodes", {"userId": uid, "IsMissing": "false", "Fields": "DateCreated"})):
        assert jf_spec().request(r) == []


ITEM = {"Name": "Silo", "ServerId": SERVER_ID, "Id": jf_id("i"), "Type": "Series",
        "UserData": {"PlaybackPositionTicks": 0, "PlayCount": 0, "IsFavorite": False, "Played": False,
                     "Key": "k", "ItemId": jf_id("i")}}


def page(*items):
    return {"Items": list(items), "TotalRecordCount": len(items), "StartIndex": 0}


@pytest.mark.parametrize("body,fields,problem", [
    (page({**ITEM, "Tvdb": "1"}), set(), "$.Items[0].Tvdb: not in the BaseItemDto schema"),
    (page({**ITEM, "UserData": {"Played": True}}), set(), "$.Items[0].UserData: required Key missing"),
    (page({**ITEM, "ProductionYear": "2023"}), set(), '$.Items[0].ProductionYear="2023" is not an integer'),
    (page({**ITEM, "Type": "Show"}), set(), '$.Items[0].Type="Show" is not one of the enum'),
    (page({**ITEM, "Id": "silo-1"}), set(), "$.Items[0].Id='silo-1' is not a uuid"),
    (page({**ITEM, "Id": None}), set(), "$.Items[0].Id: null where not nullable"),
    (page({**ITEM, "ProviderIds": {"Tvdb": "1"}}), set(),
     "$.Items[0].ProviderIds: an optional field (ItemFields) served without Fields=ProviderIds"),
    (page({**ITEM, "DateCreated": "2026-09-01"}), {"DateCreated"}, "is not a date-time"),
    (page({**ITEM, "MediaSources": [{"Id": "x"}]}), {"MediaSources"}, "schema MediaSourceInfo isn't vendored"),
    ({"Items": [], "Total": 0}, set(), "$.Total: not in the BaseItemDtoQueryResult schema"),
])
def test_answers_off_the_spec_are_caught(body, fields, problem):
    got = jf_spec().response("GET /Items", 200, body, fields)
    assert any(problem in p for p in got), got


def test_an_undeclared_status_is_caught_and_5xx_is_allowed():
    assert jf_spec().response("GET /Items", 404, None, set()) == [
        "JellyfinSim GET /Items -> 404: status not declared (declares 200, 401, 403, 503)"]
    assert jf_spec().response("GET /Items", 500, None, set()) == []
    assert jf_spec().response("GET /Shows/{seriesId}/Episodes", 404, None, set()) == []


# ---------------------------------------------------------------- the sim's answers


@pytest.fixture
def jf(upstream):
    return JellyfinSim(upstream, BASE)


async def get(path, params=None, token="tok"):
    headers = {"Authorization": AUTH["Authorization"].replace('"tok"', f'"{token}"')}
    async with httpx.AsyncClient() as h:
        return await h.get(BASE + path, params=params, headers=headers)


async def test_the_sims_answers_pass_and_honour_fields(jf):
    u = jf.add_user("anna", "tok")
    show = jf.add_series("Silo", 367506)
    jf.add_episode(show, 1, 1)
    jf.add_episode(show, 1, 2, end=3)
    jf.add_movie("Dune", 438631)
    me = (await get("/Users/Me")).json()
    assert me["Id"] == u.id and me["Name"] == "anna"
    plain = (await get("/Items", {"SearchTerm": "Silo", "userId": u.id})).json()["Items"][0]
    assert "ProviderIds" not in plain and plain["UserData"]["Key"]
    rich = (await get("/Items", {"SearchTerm": "Silo", "Fields": "ProviderIds", "userId": u.id})).json()["Items"][0]
    assert rich["ProviderIds"] == {"Tvdb": "367506"}
    eps = (await get(f"/Shows/{show.id}/Episodes", {"userId": u.id, "IsMissing": "false",
                                                    "fields": "DateCreated"})).json()["Items"]
    assert [(e["IndexNumber"], e.get("IndexNumberEnd")) for e in eps] == [(1, None), (2, 3)]
    assert all(e["DateCreated"].endswith("Z") for e in eps)
    eps = (await get(f"/Shows/{show.id}/Episodes", {"userId": u.id})).json()["Items"]
    assert all("DateCreated" not in e for e in eps)
    assert (await get("/Users/Me", token="nope")).status_code == 401
    assert jf.violations == []


async def test_the_sim_records_a_request_off_the_spec(jf):
    jf.add_user("anna", "tok")
    await get("/Items", {"SearchTerm": "Silo", "Fields": "ImdbId"})
    assert jf.violations == ["Jellyfin GET /Items: query Fields='ImdbId' is not one of the enum"]
    jf.violations.clear()  # provoked on purpose; the guard would fail the test otherwise
    assert jellyfin.LIVE[-1] is jf
