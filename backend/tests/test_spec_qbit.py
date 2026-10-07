"""Mock fidelity: QbitSim (tests/support/qbit.py) against the public
qBittorrent WebUI API reference (the wiki page for qBittorrent 5.0, cached by
tests/specs/fetch_specs.py; skips without the cache).

* every endpoint QbitSim implements is documented;
* a tour through every QBittorrentClient method records what reel-api sends:
  every endpoint and every parameter must be documented;
* every field reel-api READS from torrents/info, torrents/files,
  torrents/properties (found statically, with `ast`, at each read site — so a
  new read is checked without editing this file) is in the doc's field tables
  and QbitSim emits it;
* every torrent state reel-api compares against is a documented state, and
  pieceStates values are documented as 0/1/2 with 2 = downloaded.

The wiki page lags the code in the places listed below (the stopped* states,
5.2's login and API key), each checked in qBittorrent's source; nothing else
is exempt.
"""

from __future__ import annotations

import ast
import inspect
import re
import textwrap
from pathlib import Path

import httpx
import pytest

from reel_api import app as app_mod
from reel_api import qbittorrent, streaming, undo
from reel_api.qbittorrent import QBittorrentClient
from tests.support.growing import GrowingFile
from tests.support.qbit import QBIT, QbitSim, SimFile, SimTorrent, make_hash
from tests.support.specs import qbit_endpoints

pytestmark = pytest.mark.spec

# qBittorrent 5.0 renamed the paused* states to stopped*
# (src/webui/api/serialize/serialize_torrent.cpp at release-5.0.0 returns
# "stoppedDL"/"stoppedUP"); the 5.0 wiki's state table still lists paused*.
UNDOCUMENTED_STATES = {"stoppedDL", "stoppedUP"}

# QbitSim's torrents/info rows carry `infohash_v1` like the real thing
# (serialize_torrent.cpp at release-5.0.0: KEY_TORRENT_INFOHASHV1, since 4.4);
# the wiki's field table doesn't list it. reel-api doesn't read it.
SIM_UNDOCUMENTED_INFO_FIELDS = {"infohash_v1"}

# qBittorrent 5.2 (WebAPI 2.14.0) changed the login; the wiki documents 5.0's.
# release-5.2.0 src/webui/webapplication.cpp + api/authcontroller.cpp: a good
# login is a null API result -> 204 + Set-Cookie QBT_SID_<WebUI port> (was
# 200 "Ok." + SID), bad credentials throw Unauthorized -> 401 (was 200
# "Fails."; WebAPI_Changelog.md 2.14.0 says so too), the IP ban stays 403.
# Measured on the NAS's 5.2.3: 204. The same release added the API key
# (`Authorization: Bearer qbt_…`, WebUI\APIKey): a wrong one leaves the request
# without a session -> 403, and auth/* refuses a Bearer request with 403.
LOGIN_5_2 = {"ok": 204, "bad": 401, "banned": 403, "cookie": "QBT_SID_"}
LOGIN = "/api/v2/auth/login"

INFO, FILES, PROPS = "/api/v2/torrents/info", "/api/v2/torrents/files", "/api/v2/torrents/properties"

# Where reel-api reads qBittorrent payloads: (module, function, variable names, endpoint).
READ_SITES = [
    (qbittorrent, "QBittorrentClient.info_map", {"r"}, INFO),
    (qbittorrent, "QBittorrentClient.make_sequential", {"r"}, INFO),
    (streaming, "_main_file", {"row"}, INFO),
    (streaming, "_main_file", {"f", "main"}, FILES),
    (streaming, "_main_file", {"props"}, PROPS),
    (app_mod, "_activity_items", {"row"}, INFO),
    (undo, "Undo._purge", {"r"}, INFO),
]


def _function(module, qualname: str):
    obj = module
    for part in qualname.split("."):
        obj = getattr(obj, part)
    return obj


def product_source(module, qualname: str | None = None) -> str:
    """The source of a reel_api module, or of one function/class in it by
    qualname. Read from the module's file rather than through `inspect`: under
    mutmut (tests/run_mutmut.sh) the imported module is the generated copy in
    backend/mutants/, full of trampolines and every mutant's text, so this reads
    the unmutated file next to it (backend/mutants/src/... -> backend/src/...)."""
    path = Path(module.__file__).resolve()
    if "mutants" in path.parts:
        i = len(path.parts) - 1 - path.parts[::-1].index("mutants")
        path = Path(*path.parts[:i], *path.parts[i + 1:])
    text = path.read_text(encoding="utf-8")
    if qualname is None:
        return text
    node = ast.parse(text)
    for part in qualname.split("."):
        node = next(n for n in node.body
                    if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and n.name == part)
    return textwrap.dedent(ast.get_source_segment(text, node, padded=True))


def keys_read(module, qualname: str, names: set[str]) -> set[str]:
    """String keys read as `v["k"]` or `v.get("k")` for v in `names` inside the function."""
    _function(module, qualname)  # still exists
    tree = ast.parse(product_source(module, qualname))
    out = set()
    for node in ast.walk(tree):
        if (isinstance(node, ast.Subscript) and isinstance(node.value, ast.Name) and node.value.id in names
                and isinstance(node.slice, ast.Constant) and isinstance(node.slice.value, str)):
            out.add(node.slice.value)
        elif (isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and node.func.attr == "get"
              and isinstance(node.func.value, ast.Name) and node.func.value.id in names and node.args
              and isinstance(node.args[0], ast.Constant) and isinstance(node.args[0].value, str)):
            out.add(node.args[0].value)
    return out


def all_reads() -> dict[str, set[str]]:
    out: dict[str, set[str]] = {}
    for module, fn, names, endpoint in READ_SITES:
        keys = keys_read(module, fn, names)
        assert keys, f"{module.__name__}.{fn}: no reads of {names} found (site moved?)"
        out.setdefault(endpoint, set()).update(keys)
    return out


@pytest.fixture
def doc(spec_cache):
    return qbit_endpoints(spec_cache.qbit)


def documented_states(doc) -> set[str]:
    for table in doc[INFO].tables():
        firsts = {n for row in table for n in re.findall(r"`(\w+)`", row[0])}
        if {"missingFiles", "metaDL"} <= firsts:
            return firsts
    raise AssertionError("no state table in the torrents/info section")


# ---------------------------------------------------------------- endpoints and parameters


def test_every_endpoint_the_sim_implements_is_documented(doc, upstream):
    sim = QbitSim(upstream)
    missing = [f"{m} /api/v2{p}" for m, p in sim.endpoints if f"/api/v2{p}" not in doc]
    assert missing == []


@pytest.fixture
async def tour(upstream, tmp_path):
    """Every QBittorrentClient method once, with login and a multi-file
    torrent; returns the sim (its `calls` hold what was sent)."""
    sim = QbitSim(upstream, username="admin", password="pw")
    g = GrowingFile(tmp_path / "Movie.mkv", b"x" * 200_000, piece_size=65536)
    g.grow_to(100_000)
    h = make_hash("qbit-tour")
    sim.add_growing(h, g)
    other = make_hash("qbit-tour-2")
    sim.add_torrent(SimTorrent(hash=other, name="Show.S01", category="tv-sonarr",
                               files=[SimFile("Show.S01/a.nfo", 10), SimFile("Show.S01/e1.mkv", 70_000)]))
    qb = QBittorrentClient(QBIT, "admin", "pw")
    await qb.info_map()
    rows = await qb.rows([h, other])
    await qb.make_sequential(rows)
    await qb.raw_info(h)
    await qb.files(other)
    await qb.properties(h)
    await qb.piece_states(h)
    await qb.force_start(h)
    await qb.delete_with_data([other, h])
    return sim


def test_the_tour_reaches_every_sim_endpoint(tour):
    assert {(m, p) for m, p, _ in tour.calls} == set(tour.endpoints)


def test_every_parameter_sent_is_documented(tour, doc):
    bad = sorted({(p, k) for _, p, data in tour.calls for k in data if k not in doc[f"/api/v2{p}"].params})
    assert bad == []


# ---------------------------------------------------------------- login


async def _login_answers(upstream, version: int) -> dict[str, httpx.Response]:
    sim = QbitSim(upstream, version=version, username="admin", password="pw")
    async with httpx.AsyncClient() as http:
        out = {"bad": await http.post(QBIT + LOGIN, data={"username": "admin", "password": "nope"}),
               "ok": await http.post(QBIT + LOGIN, data={"username": "admin", "password": "pw"})}
        sim.logged_in, sim.banned = False, True
        http.cookies.clear()
        out["banned"] = await http.post(QBIT + LOGIN, data={"username": "admin", "password": "pw"})
    return out


async def test_the_4x_login_answers_as_the_wiki_documents(doc, upstream):
    """Up to 5.1 (version=4): 403 when banned, 200 for everything else, and a
    success sets the SID cookie — the wiki's Login section."""
    section = doc[LOGIN]
    codes = {row[0]: row[1] for t in section.tables() for row in t if re.fullmatch(r"\d{3}", row[0])}
    assert set(codes) == {"200", "403"} and "banned" in codes["403"].lower()
    assert "cookie with your SID" in section.body
    a = await _login_answers(upstream, 4)
    assert (a["ok"].status_code, a["ok"].text, list(a["ok"].cookies)) == (200, "Ok.", ["SID"])
    assert (a["bad"].status_code, a["bad"].text, list(a["bad"].cookies)) == (200, "Fails.", [])
    assert a["banned"].status_code == 403 and "banned" in a["banned"].text


async def test_the_5_2_login_answers_as_the_source_says(doc, upstream):
    """version=5 answers like 5.2's source (LOGIN_5_2), which the 5.0 wiki
    doesn't describe — if it ever documents 204/401, revisit LOGIN_5_2."""
    codes = {row[0] for t in doc[LOGIN].tables() for row in t if re.fullmatch(r"\d{3}", row[0])}
    assert not codes & {"204", "401"}, "the wiki documents the 5.2 login now: check LOGIN_5_2 against it"
    a = await _login_answers(upstream, 5)
    assert {k: r.status_code for k, r in a.items()} == {k: LOGIN_5_2[k] for k in ("ok", "bad", "banned")}
    assert a["ok"].text == "" and [c.startswith(LOGIN_5_2["cookie"]) for c in a["ok"].cookies] == [True]
    assert list(a["bad"].cookies) == []


async def test_the_5_2_api_key(upstream):
    """version=5 with api_key: the right Bearer is a session, a wrong one or
    none is 403, and a login carrying a Bearer is refused (403)."""
    QbitSim(upstream, api_key="qbt_" + "k" * 28)
    async with httpx.AsyncClient() as http:
        info = QBIT + INFO
        assert (await http.get(info, headers={"Authorization": "Bearer qbt_" + "k" * 28})).status_code == 200
        assert (await http.get(info, headers={"Authorization": "Bearer qbt_" + "x" * 28})).status_code == 403
        assert (await http.get(info)).status_code == 403
        r = await http.post(QBIT + LOGIN, data={"username": "a", "password": "b"},
                            headers={"Authorization": "Bearer qbt_" + "k" * 28})
        assert r.status_code == 403


# ---------------------------------------------------------------- fields read


def test_the_read_sites_are_found():
    reads = all_reads()
    # a sanity floor, not a pin: the reads that make streaming and activity work
    assert {"hash", "state", "progress", "content_path", "seq_dl", "f_l_piece_prio"} <= reads[INFO]
    assert {"name", "size", "index"} <= reads[FILES]
    assert reads[PROPS] == {"piece_size"}


@pytest.mark.parametrize("endpoint", [INFO, FILES, PROPS])
def test_every_field_read_is_documented(doc, endpoint):
    assert sorted(all_reads()[endpoint] - doc[endpoint].fields) == []


@pytest.mark.parametrize("endpoint", [INFO, FILES, PROPS])
async def test_the_sim_emits_every_field_read(upstream, tmp_path, endpoint):
    sim = QbitSim(upstream)
    g = GrowingFile(tmp_path / "M.mkv", b"y" * 70_000, piece_size=65536)
    g.grow_to(70_000)
    h = make_hash("emit")
    sim.add_growing(h, g)
    qb = QBittorrentClient(QBIT, None, None)
    if endpoint == INFO:
        payload = (await qb.rows([h]))[0]
    elif endpoint == FILES:
        payload = (await qb.files(h))[0]
    else:
        payload = await qb.properties(h)
    assert sorted(all_reads()[endpoint] - set(payload)) == []


def test_sim_fields_are_documented(doc, upstream, tmp_path):
    """The other direction: QbitSim invents nothing (info/files/properties)."""
    sim = QbitSim(upstream)
    t = sim.add_torrent(SimTorrent(hash=make_hash("d"), name="d", files=[SimFile("d.mkv", 10)]))
    files = sim._files({"hash": t.hash})
    props = sim._properties({"hash": t.hash})
    assert set(t.row()) - doc[INFO].fields == SIM_UNDOCUMENTED_INFO_FIELDS
    assert not (SIM_UNDOCUMENTED_INFO_FIELDS & all_reads()[INFO])
    assert sorted(set(files.json()[0]) - doc[FILES].fields) == []
    assert sorted(set(props.json()) - doc[PROPS].fields) == []


# ---------------------------------------------------------------- states and pieces


def _states_reel_api_compares() -> set[str]:
    out = app_mod._DL_STATES | app_mod._QUEUE_STATES | app_mod._PAUSED_STATES
    for mod in (streaming, app_mod.livehls):
        out |= set(re.findall(r'"(\w+(?:DL|UP))"', product_source(mod)))
    return out


def test_every_state_reel_api_knows_is_documented(doc):
    unknown = _states_reel_api_compares() - documented_states(doc)
    assert unknown and unknown <= UNDOCUMENTED_STATES
    # and those really are missing from the wiki (else the exception is stale)
    assert not (UNDOCUMENTED_STATES & documented_states(doc))


def test_sim_states_are_documented_or_known(doc):
    src = inspect.getsource(QbitSim)
    used = set(re.findall(r'"(\w+(?:DL|UP))"', src))
    assert used - documented_states(doc) <= UNDOCUMENTED_STATES


def test_piece_states_are_documented_as_0_1_2(doc):
    table = doc["/api/v2/torrents/pieceStates"].tables()
    values = {row[0].strip("`"): row[1] for t in table for row in t
              if row and re.fullmatch(r"`\d+`", row[0])}  # `0`; the status-code table has bare 200/404
    assert set(values) == {"0", "1", "2"}
    assert "downloaded" in values["2"].lower() and "already" in values["2"].lower()
    assert "not" in values["0"].lower()


async def test_sim_piece_states_use_only_documented_values(upstream, tmp_path):
    sim = QbitSim(upstream)
    g = GrowingFile(tmp_path / "P.mkv", b"z" * 300_000, piece_size=65536)
    g.grow_to(150_000)
    sim.add_growing(make_hash("p"), g)
    states = await QBittorrentClient(QBIT, None, None).piece_states(make_hash("p"))
    assert set(states) <= {0, 1, 2} and 2 in states and 0 in states
