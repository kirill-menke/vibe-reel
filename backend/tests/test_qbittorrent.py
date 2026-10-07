"""reel-api's qBittorrent client (qbittorrent.py): the cookie login on
qBittorrent 4.x .. 5.2, the API key, a configuration that fails closed, ids
that never widen `hashes=`, and the 503 / 404 a route makes of its errors.
reel-api only reads and steers torrents the arrs added (activity, streaming,
cancel); the routes below are the streaming ones."""

import httpx
import pytest

from reel_api import qbittorrent as qb
from tests.conftest import QBIT
from tests.support.qbit import QbitSim, SimFile, SimTorrent, make_hash


@pytest.fixture
def sim(qbit):
    return qbit


def torrent(seed: str, **kw) -> SimTorrent:
    kw.setdefault("name", f"{seed}.mkv")
    kw.setdefault("files", [SimFile(kw["name"], 4 * 1024 * 1024)])
    return SimTorrent(hash=make_hash(seed), **kw)


def stream(seed: str) -> str:
    """The HEAD of a torrent's stream: one torrents/info + files + properties
    round (streaming.py), 200 for a torrent qBittorrent has."""
    return f"/api/downloads/{make_hash(seed)}/stream"


# ---------------------------------------------------------------- errors of the streaming routes


@pytest.mark.parametrize("method, path", [("HEAD", "/api/downloads/{h}/stream"), ("GET", "/api/downloads/{h}/stream"),
                                          ("GET", "/api/downloads/{h}/probe")])
async def test_unreachable_is_503(sim, api, method, path):
    sim.fail("/torrents/info", exc=httpx.ConnectError("refused"))
    r = await api.request(method, path.format(h=make_hash("x")))
    assert r.status_code == 503 and r.headers["retry-after"] == "30"
    if method != "HEAD":
        assert r.json() == {"error": "temporarily_unavailable",
                            "detail": "download service temporarily unavailable, retry later"}


@pytest.mark.parametrize("method, path", [("HEAD", "/api/downloads/x/stream"), ("GET", "/api/downloads/x/stream"),
                                          ("GET", "/api/downloads/x/probe")])
async def test_no_download_backend_is_503(make_api, method, path):
    async with make_api(QBIT_URL=None) as api:
        r = await api.request(method, path)
    assert r.status_code == 503 and r.headers["retry-after"] == "30"


# ---------------------------------------------------------------- login


async def test_login_once_then_carries_on(upstream, make_api):
    sim = QbitSim(upstream, username="reel", password="pw")
    sim.add_torrent(torrent("l"))
    async with make_api(QBIT_USERNAME="reel", QBIT_PASSWORD="pw") as api:
        assert (await api.head(stream("l"))).status_code == 200
        assert (await api.head(stream("l"))).status_code == 200
    assert sim.called("/auth/login") == [{"username": "reel", "password": "pw"}]


@pytest.mark.parametrize("version, status, body, cookie", [
    (5, 204, "", "QBT_SID_8080"),  # qBittorrent 5.2+: 204, no body, port-named cookie (measured on 5.2.3)
    (4, 200, "Ok.", "SID"),       # 4.1 .. 5.1
])
async def test_login_succeeds_on_both_answers(upstream, version, status, body, cookie):
    """The production bug: 5.2 answers a good login 204 No Content, and the
    client wanted 200 "Ok." — no qBittorrent access at all. Both shapes are a
    login, and the session cookie rides on every later call."""
    sim = QbitSim(upstream, version=version, username="reel", password="pw")
    sim.add_torrent(torrent("l"))
    client = qb.QBittorrentClient(QBIT, "reel", "pw")
    assert len(await client.info_map()) == 1
    (login,) = [r for p, r in sim.requests if p == "/auth/login"]
    (info,) = [r for p, r in sim.requests if p == "/torrents/info"]
    assert "cookie" not in login.headers
    assert info.headers["cookie"].startswith(f"{cookie}=sid")
    assert "authorization" not in info.headers
    answer = upstream.routes["qbit_auth_login"].calls.last.response
    assert (answer.status_code, answer.text) == (status, body)


@pytest.mark.parametrize("version", [4, 5])
async def test_a_live_session_is_still_a_login(upstream, version):
    """Logging in on a session that is still live answers success without a
    new cookie (both versions): still a login, the jar keeps the cookie."""
    sim = QbitSim(upstream, version=version, username="reel", password="pw")
    client = qb.QBittorrentClient(QBIT, "reel", "pw")
    await client.info_map()
    client._logged_in = False
    await client.info_map()
    assert len(sim.called("/auth/login")) == 2 and len(sim.sessions) == 1


@pytest.mark.parametrize("status, body, cookie, why", [
    (200, "Fails.", None, "wrong username or password"),        # 4.1 .. 5.1
    (401, "Unauthorized", None, "wrong username or password"),  # 5.2+
    (403, "Your IP address has been banned after too many failed authentication attempts.", None,
     "banned"),
    (200, "Fails.", "SID=x", "wrong username or password"),     # a cookie doesn't make "Fails." a login
    (204, "", None, "no session cookie"),                       # 2xx without a session: not a login
    (200, "<html>proxy login</html>", None, "no session cookie"),
    (204, "", "other=1", "no session cookie"),                   # a bare 2xx needs a *session* cookie
    (200, "", "tracking=1", "no session cookie"),
    (500, "Internal Server Error", None, "HTTP 500"),
    (302, "", "SID=x", "HTTP 302"),
])
async def test_login_failure_answers_are_a_clear_download_error(upstream, status, body, cookie, why):
    """Every way qBittorrent says no — 4.x's 200 "Fails.", 5.2's 401, the
    failed-login IP ban (403, both versions) — and any answer that sets no
    session is a DownloadError naming why; the password never appears."""
    sim = QbitSim(upstream, username="reel", password="hunter22")
    headers = {"set-cookie": f"{cookie}; path=/"} if cookie else {}
    upstream.routes["qbit_auth_login"].side_effect = None
    upstream.routes["qbit_auth_login"].return_value = httpx.Response(status, text=body, headers=headers)
    client = qb.QBittorrentClient(QBIT, "reel", "hunter22")
    with pytest.raises(qb.DownloadError, match="qbittorrent login") as e:
        await client.info_map()
    assert why in str(e.value) and "hunter22" not in str(e.value)
    assert sim.called("/torrents/info") == []


class CustomCookieSim(QbitSim):
    """qBittorrent 4.6 .. 5.1 with WebAPI\\SessionCookieName set: the login is
    the usual 200 "Ok.", but the session cookie has the configured name."""

    @property
    def cookie_name(self) -> str:
        return "MYQBT"


async def test_login_ok_with_a_custom_session_cookie_name(upstream):
    """200 "Ok." is 4.1 .. 5.1's own success answer, so it is a login whatever
    the cookie is called (4.6+ lets the user rename it); the custom cookie
    rides on the later calls."""
    sim = CustomCookieSim(upstream, version=4, username="reel", password="pw")
    sim.add_torrent(torrent("l"))
    client = qb.QBittorrentClient(QBIT, "reel", "pw")
    assert len(await client.info_map()) == 1
    (info,) = [r for p, r in sim.requests if p == "/torrents/info"]
    assert info.headers["cookie"].startswith("MYQBT=sid")


def _login_answer(status: int, body: str = "", set_cookie: str | None = None,
                  sent: str | None = None) -> httpx.Response:
    """A login answer as the client sees it: `sent` is the Cookie header the
    POST carried (the jar's cookies), `set_cookie` the answer's Set-Cookie."""
    req = httpx.Request("POST", f"{QBIT}/api/v2/auth/login", headers={"cookie": sent} if sent else {})
    headers = {"set-cookie": f"{set_cookie}; path=/"} if set_cookie else {}
    return httpx.Response(status, text=body, headers=headers, request=req)


def _jar(**cookies: str) -> httpx.Cookies:
    jar = httpx.Cookies()
    for name, value in cookies.items():
        jar.set(name, value, domain="qbit.test", path="/")
    return jar


@pytest.mark.parametrize("answer, jar", [
    (_login_answer(200, "Ok."), _jar()),                                     # 4.x, no cookie at all
    (_login_answer(200, "Ok.", "MYQBT=s1"), _jar(MYQBT="s1")),               # 4.6+ custom name
    (_login_answer(200, "Ok.", sent="SID=s1"), _jar(SID="s1")),              # 4.x, session still live
    (_login_answer(204, "", "QBT_SID_8080=s2"), _jar(QBT_SID_8080="s2")),    # 5.2, new session
    (_login_answer(204, "", "QBT_SID_8080=s2", sent="QBT_SID_8080=old"), _jar(QBT_SID_8080="s2")),
    (_login_answer(204, "", sent="QBT_SID_8080=s1"), _jar(QBT_SID_8080="s1")),  # 5.2, still logged in
    (_login_answer(200, "", "SID=s3"), _jar(SID="s3")),                      # some 2xx, new SID cookie
], ids=["ok-no-cookie", "ok-custom-name", "ok-live", "204-new", "204-replaces", "204-live", "200-sid"])
def test_login_refusal_accepts(answer, jar):
    assert qb.login_refusal(answer, jar) is None


@pytest.mark.parametrize("answer, jar", [
    # A stale session cookie left in the jar (the session expired, which is
    # why the client logs in again) rides on the POST; a proxy's 2xx sets no
    # new one. Only qBittorrent's own "still logged in" shape (204, no body)
    # may lean on the jar.
    (_login_answer(200, "<html>proxy</html>", sent="SID=stale"), _jar(SID="stale")),
    (_login_answer(200, "", sent="QBT_SID_8080=stale"), _jar(QBT_SID_8080="stale")),
    (_login_answer(202, "", sent="QBT_SID_8080=stale"), _jar(QBT_SID_8080="stale")),
    # 204 without a cookie sent: nothing can be "still" logged in.
    (_login_answer(204), _jar(QBT_SID_8080="other-host")),
    # 204 that expires the cookie it was sent: the jar no longer holds it.
    (_login_answer(204, "", "QBT_SID_8080=; Max-Age=0", sent="QBT_SID_8080=s1"), _jar()),
    # A non-session cookie sent along doesn't count either.
    (_login_answer(204, "", sent="tracking=1"), _jar(tracking="1")),
], ids=["proxy-html-stale", "proxy-200-stale", "proxy-202-stale", "204-nothing-sent", "204-expires",
        "204-foreign-cookie"])
def test_login_refusal_needs_a_cookie_from_this_answer(answer, jar):
    assert qb.login_refusal(answer, jar) == f"no session cookie in the answer (HTTP {answer.status_code})"


async def test_a_stale_jar_cookie_does_not_make_a_proxy_page_a_login(upstream):
    """The session expires (every call 403s); the re-login POST still carries
    the old cookie, and something in front of qBittorrent answers it with a
    200 page. That is a DownloadError, not a login on the stale cookie."""
    sim = QbitSim(upstream, version=5, username="reel", password="pw")
    client = qb.QBittorrentClient(QBIT, "reel", "pw")
    await client.info_map()
    sim.logged_in = False
    upstream.routes["qbit_auth_login"].side_effect = None
    upstream.routes["qbit_auth_login"].return_value = httpx.Response(200, text="<html>proxy</html>")
    with pytest.raises(qb.DownloadError, match="no session cookie"):
        await client.info_map()
    relogin = upstream.routes["qbit_auth_login"].calls.last.request
    assert relogin.headers["cookie"].startswith("QBT_SID_8080=sid")  # the stale cookie did ride along
    assert sim.called("/torrents/info") == [{}, {}]  # the first, then the 403 that sent it to log in


async def test_wrong_password_on_5_2_is_503(upstream, make_api, caplog):
    sim = QbitSim(upstream, username="reel", password="s3cret-right")
    async with make_api(QBIT_USERNAME="reel", QBIT_PASSWORD="s3cret-wrong") as api:
        r = await api.get(stream("l"))
    assert r.status_code == 503 and "s3cret" not in r.text
    assert "qbittorrent login failed: wrong username or password (HTTP 401)" in caplog.text
    assert "s3cret" not in caplog.text and sim.called("/torrents/info") == []


async def test_login_without_password_sends_empty(upstream, make_api):
    sim = QbitSim(upstream, username="reel", password=None)
    sim.add_torrent(torrent("l"))
    async with make_api(QBIT_USERNAME="reel") as api:
        assert (await api.head(stream("l"))).status_code == 200
    assert sim.called("/auth/login") == [{"username": "reel", "password": ""}]


async def test_login_fails_is_503_and_retried(upstream, make_api):
    sim = QbitSim(upstream, username="reel", password="right")
    sim.add_torrent(torrent("l"))
    async with make_api(QBIT_USERNAME="reel", QBIT_PASSWORD="wrong") as api:  # nothing logs in at startup
        r = await api.get(stream("l"))
        assert r.status_code == 503 and "qbit" not in r.text.lower()
        assert sim.called("/torrents/info") == []
        sim.password = "wrong"
        assert (await api.head(stream("l"))).status_code == 200
    assert len(sim.called("/auth/login")) == 2  # the failed request, the one that worked


async def test_login_http_error_is_503(upstream, make_api):
    sim = QbitSim(upstream, username="reel", password="pw")
    async with make_api(QBIT_USERNAME="reel", QBIT_PASSWORD="pw") as api:
        api.app_module.downloader._logged_in = False
        sim.fail("/auth/login", status=403, body="banned")
        assert (await api.get(stream("l"))).status_code == 503


async def test_login_unreachable_is_503(upstream, make_api):
    """An unreachable qBittorrent during login is the documented 503, like
    any other unreachable qBittorrent call (the ConnectError used to
    escape: a plain 500)."""
    QbitSim(upstream, username="reel", password="pw")
    async with make_api(QBIT_USERNAME="reel", QBIT_PASSWORD="pw", raise_app_exceptions=False) as api:
        api.app_module.downloader._logged_in = False
        upstream.routes["qbit_auth_login"].side_effect = httpx.ConnectError("refused")
        r = await api.get(stream("l"))
    assert r.status_code == 503, r.text
    assert r.json() == {"error": "temporarily_unavailable",
                        "detail": "download service temporarily unavailable, retry later"}


async def test_no_username_never_logs_in(sim, api):
    sim.add_torrent(torrent("l"))
    assert (await api.head(stream("l"))).status_code == 200
    assert sim.called("/auth/login") == []


async def test_session_expiry_logs_in_again(upstream, make_api):
    """When the WebUI session expires (qBittorrent's session timeout, or a
    qBittorrent restart) every call answers 403 "Forbidden": the client logs
    in again and the request still succeeds. (It used to never re-log in
    until reel-api restarted: every qBittorrent call was a plain 500.)"""
    sim = QbitSim(upstream, username="reel", password="pw")
    sim.add_torrent(torrent("l"))
    async with make_api(QBIT_USERNAME="reel", QBIT_PASSWORD="pw", raise_app_exceptions=False) as api:
        assert (await api.head(stream("l"))).status_code == 200
        sim.logged_in = False  # the WebUI session expired
        r = await api.head(stream("l"))
        assert r.status_code == 200, r.text
    assert len(sim.called("/auth/login")) == 2


async def test_session_expiry_on_a_post_logs_in_again(upstream, make_api):
    """A POST that meets an expired session (403) logs in again and is sent
    once more, like a GET."""
    sim = QbitSim(upstream, username="reel", password="pw")
    t = sim.add_torrent(torrent("force"))
    async with make_api(QBIT_USERNAME="reel", QBIT_PASSWORD="pw") as api:
        await api.app_module.downloader.info_map()  # logs in
        sim.logged_in = False
        await api.app_module.downloader.force_start(t.hash)
    assert t.force_start is True
    assert len(sim.called("/torrents/setForceStart")) == 2
    assert len(sim.called("/auth/login")) == 2  # the first call's + the re-login


async def test_files_404_text_body_is_no_such_download(sim, make_api):
    """files/properties/pieceStates answer 404 "Not Found" (text, not JSON)
    for a hash qBittorrent doesn't know — e.g. a torrent removed between the
    torrents/info row and the files call. That is "no such download" (404),
    not a JSONDecodeError (plain 500)."""
    h = make_hash("removed")
    sim.add_torrent(torrent("removed"))
    async with make_api(raise_app_exceptions=False) as api:
        with pytest.raises(qb.NoSuchDownload):
            await api.app_module.downloader.files(make_hash("unknown"))
        sim.fail("/torrents/files", status=404, body="Not Found")
        r = await api.get(f"/api/downloads/{h.upper()}/probe")
    assert r.status_code == 404, r.text
    assert r.json() == {"error": "not_found", "detail": "no such download"}


@pytest.mark.parametrize("status, body", [(500, "Internal Server Error"), (200, "<html>proxy</html>"),
                                          (403, "Forbidden")])
async def test_non_json_or_failed_get_is_503(sim, make_api, status, body):
    """Any other non-2xx answer (no credentials configured, so a 403 can't be
    fixed by logging in) or a body that isn't JSON is the documented 503 +
    Retry-After, never a plain 500."""
    async with make_api(raise_app_exceptions=False) as api:
        sim.fail("/torrents/info", status=status, body=body)
        r = await api.get(stream("l"))
    assert r.status_code == 503, r.text
    assert r.headers["retry-after"] == "30"
    assert r.json()["error"] == "temporarily_unavailable"


# ---------------------------------------------------------------- API key (qBittorrent 5.2+)

KEY = "qbt_" + "Zq7Xw3" * 4 + "Pm9k"  # qBittorrent's format: qbt_ + 28 letters/digits
OTHER_KEY = "qbt_" + "a1" * 14
assert len(KEY) == len(OTHER_KEY) == 32


def _auth_headers(sim) -> set[tuple[str | None, str | None]]:
    return {(r.headers.get("authorization"), r.headers.get("cookie")) for _, r in sim.requests}


async def test_api_key_is_a_bearer_on_every_call_and_never_logs_in(upstream, make_api):
    """QBIT_API_KEY: every qBittorrent call carries `Authorization: Bearer`,
    no cookie login ever happens — and it wins over QBIT_USERNAME/PASSWORD
    (stateless, so no session to expire and no failed-login IP ban)."""
    sim = QbitSim(upstream, api_key=KEY, username="reel", password="pw")
    t = sim.add_torrent(torrent("keyed", pieces=[0] * 64))
    async with make_api(QBIT_API_KEY=KEY, QBIT_USERNAME="reel", QBIT_PASSWORD="pw") as api:
        assert (await api.head(stream("keyed"))).status_code == 200
        assert (await api.get(f"/api/downloads/{t.hash}/probe")).status_code == 409  # header not on disk yet
        client = api.app_module.downloader
        await client.force_start(t.hash)
        await client.make_sequential(await client.rows([t.hash]))
        await client.delete_with_data([t.hash])
    assert sim.called("/auth/login") == [] and sim.sessions == set()
    assert {p for p, _ in sim.requests} == {"/torrents/info", "/torrents/files", "/torrents/properties",
                                            "/torrents/pieceStates", "/torrents/setForceStart",
                                            "/torrents/toggleSequentialDownload",
                                            "/torrents/toggleFirstLastPiecePrio", "/torrents/delete"}
    assert _auth_headers(sim) == {(f"Bearer {KEY}", None)}


@pytest.mark.parametrize("status", [401, 403])
async def test_a_refused_api_key_is_a_download_error_without_a_login(upstream, status):
    """A wrong key (5.2: no session -> 403; host-header validation: 401) is a
    DownloadError naming the key — on GETs and on POSTs, which otherwise
    ignore their status — sent once, never followed by a login attempt."""
    sim = QbitSim(upstream, api_key=OTHER_KEY, username="reel", password="pw")
    t = sim.add_torrent(torrent("refused"))
    client = qb.QBittorrentClient(QBIT, "reel", "pw", api_key=KEY)
    if status == 401:
        sim.fail("/torrents/info", status=401, body="Unauthorized")
        sim.fail("/torrents/setForceStart", status=401, body="Unauthorized")
    with pytest.raises(qb.DownloadError, match=rf"qbittorrent refused the API key \(HTTP {status}\)") as e:
        await client.info_map()
    assert KEY not in str(e.value)
    with pytest.raises(qb.DownloadError, match="refused the API key"):
        await client.force_start(t.hash)
    assert t.force_start is False
    assert len(sim.called("/torrents/info")) == 1 and len(sim.called("/torrents/setForceStart")) == 1
    assert sim.called("/auth/login") == []


async def test_a_refused_api_key_is_503_and_never_logged(upstream, make_api, caplog):
    QbitSim(upstream, api_key=OTHER_KEY)
    caplog.set_level("DEBUG")  # httpx/httpcore included
    async with make_api(QBIT_API_KEY=KEY) as api:
        r = await api.get(stream("x"))
    assert r.status_code == 503 and KEY not in r.text
    assert "qbittorrent refused the API key (HTTP 403)" in caplog.text
    assert KEY not in caplog.text


async def test_the_key_never_reaches_the_logs(upstream, make_api, caplog, tmp_path):
    """Neither the key nor the key file's content is logged — on success,
    refusal, unreachable, a malformed key or a file that wins over the env."""
    caplog.set_level("DEBUG")
    sim = QbitSim(upstream, api_key=KEY)
    sim.add_torrent(torrent("logged"))
    f = tmp_path / "qbit-key"
    f.write_text(KEY + "\n")
    for env in ({"QBIT_API_KEY": KEY, "QBIT_API_KEY_FILE": None},
                {"QBIT_API_KEY": OTHER_KEY, "QBIT_API_KEY_FILE": str(f)},
                {"QBIT_API_KEY": KEY[:-1] + "!", "QBIT_API_KEY_FILE": None}):
        async with make_api(raise_app_exceptions=False, **env) as api:
            await api.head(stream("logged"))
            upstream.routes["qbit_torrents_info"].side_effect = httpx.ConnectError("refused")
            await api.head(stream("logged"))
            upstream.routes["qbit_torrents_info"].side_effect = sim._wrap("/torrents/info", sim._info)
    # each pass really ran: the file won, the malformed key was warned about, the calls failed
    assert "using the file" in caplog.text and "not in qBittorrent's API key format" in caplog.text
    assert caplog.text.count("qbittorrent unreachable") == 3
    for secret in (KEY, OTHER_KEY, KEY[:-1]):
        assert secret not in caplog.text
    assert "Bearer" not in caplog.text


def test_api_key_file_is_read_at_startup_and_stripped(reel_env, tmp_path):
    """QBIT_API_KEY_FILE (systemd: LoadCredential= + %d/…): read once, when
    the client is made, surrounding whitespace stripped."""
    f = tmp_path / "qbit-api-key"
    f.write_text(f"  {KEY}\n\n")
    reel_env(QBIT_URL=QBIT, QBIT_API_KEY_FILE=str(f))
    c = qb.make_download_client()
    f.write_text(OTHER_KEY)  # later changes are not re-read
    assert c._api_key == KEY and c._client.headers["authorization"] == f"Bearer {KEY}"


async def test_api_key_file_drives_the_requests(upstream, make_api, tmp_path):
    sim = QbitSim(upstream, api_key=KEY)
    sim.add_torrent(torrent("l"))
    f = tmp_path / "k"
    f.write_text(KEY + "\n")
    async with make_api(QBIT_API_KEY_FILE=str(f)) as api:
        assert (await api.head(stream("l"))).status_code == 200
    assert _auth_headers(sim) == {(f"Bearer {KEY}", None)}


@pytest.mark.parametrize("env, expect", [
    ({"QBIT_API_KEY": KEY}, (KEY, None, None)),
    ({"QBIT_API_KEY": KEY, "QBIT_USERNAME": "u", "QBIT_PASSWORD": "p"}, (KEY, None, None)),  # the key wins
    ({"QBIT_API_KEY": "", "QBIT_USERNAME": "u", "QBIT_PASSWORD": "p"}, (None, "u", "p")),   # empty = unset
    ({"QBIT_API_KEY": "  \n", "QBIT_USERNAME": "u"}, (None, "u", None)),
    ({"QBIT_API_KEY_FILE": "FILE", "QBIT_API_KEY": OTHER_KEY}, (KEY, None, None)),        # the file wins
    ({"QBIT_API_KEY_FILE": "FILE", "QBIT_USERNAME": "u", "QBIT_PASSWORD": "p"}, (KEY, None, None)),
])
def test_api_key_precedence(reel_env, tmp_path, caplog, env, expect):
    caplog.set_level("INFO")
    f = tmp_path / "key"
    f.write_text(KEY)
    reel_env(QBIT_URL=QBIT, **{k: (str(f) if v == "FILE" else v) for k, v in env.items()})
    c = qb.make_download_client()
    assert (c._api_key, c._username, c._password) == expect
    if "QBIT_API_KEY_FILE" in env and env.get("QBIT_API_KEY"):
        assert "QBIT_API_KEY_FILE and QBIT_API_KEY are both set" in caplog.text
    if expect[0] and "QBIT_USERNAME" in env:
        assert "QBIT_USERNAME/QBIT_PASSWORD are ignored" in caplog.text
    assert KEY not in caplog.text and OTHER_KEY not in caplog.text


@pytest.mark.parametrize("content, why", [
    (None, "unreadable"),
    ("", "is empty"),
    (" \n", "is empty"),
    (KEY[:10] + "\n" + KEY[10:], "whitespace or control characters"),
])
async def test_a_bad_key_file_fails_closed(upstream, make_api, tmp_path, caplog, content, why):
    """A configured but unusable key (missing/unreadable/empty file, a key
    that can't be a header) is logged at startup and every download call is
    503 — no silent fall-back to QBIT_USERNAME/PASSWORD, nothing sent."""
    f = tmp_path / "key"
    if content is not None:
        f.write_text(content)
    sim = QbitSim(upstream, username="reel", password="pw")
    async with make_api(QBIT_API_KEY_FILE=str(f), QBIT_USERNAME="reel", QBIT_PASSWORD="pw") as api:
        r = await api.get(stream("l"))
        with pytest.raises(qb.DownloadError, match=why):
            await api.app_module.downloader.info_map()
    assert r.status_code == 503
    assert sim.requests == []
    assert f"QBIT_API_KEY_FILE {f}" in caplog.text and why in caplog.text
    assert KEY[:10] not in caplog.text


def test_a_key_in_an_unexpected_format_is_sent_with_a_warning(reel_env, caplog):
    reel_env(QBIT_URL=QBIT, QBIT_API_KEY="not-a-qbt-key")
    c = qb.make_download_client()
    assert c._api_key == "not-a-qbt-key"
    assert "not in qBittorrent's API key format" in caplog.text and "not-a-qbt-key" not in caplog.text


# ---------------------------------------------------------------- construction


def test_make_download_client_env(reel_env):
    assert qb.make_download_client() is None
    reel_env(QBIT_URL=f"{QBIT}/")
    c = qb.make_download_client()
    assert (c.base_url, c._username, c._password, c._api_key) == (QBIT, None, None, None)
    assert "authorization" not in c._client.headers
    reel_env(QBIT_USERNAME="u", QBIT_PASSWORD="p")
    c = qb.make_download_client()
    assert (c._username, c._password) == ("u", "p")


# ---------------------------------------------------------------- ids never widen `hashes=`


@pytest.mark.parametrize("gid", ["all", "ALL", "a" * 39, "a" * 41, "g" * 40, f"{'a' * 40}|{'b' * 40}",
                                 f"{'a' * 40}%7C{'b' * 40}"])
async def test_a_download_id_that_is_not_one_hash_is_404_unasked(sim, api, gid):
    """qBittorrent's `hashes` take `all` and |-lists: a stream of
    /api/downloads/all would force-start every torrent. A malformed id is a
    404 before qBittorrent is asked."""
    sim.add_torrent(torrent("keep", state="queuedDL"))
    for method, path in (("GET", "stream"), ("HEAD", "stream"), ("GET", "probe")):
        r = await api.request(method, f"/api/downloads/{gid}/{path}")
        assert r.status_code == 404, (method, path, gid, r.text)
        if method == "GET":
            assert r.json() == {"error": "not_found", "detail": "no such download"}
    assert sim.calls == []


async def test_client_methods_check_the_hash_themselves(sim, api):
    client = api.app_module.downloader
    for call in (client.raw_info, client.files, client.properties, client.piece_states, client.force_start):
        for bad in ("all", None, 40, "x" * 40):
            with pytest.raises(qb.NoSuchDownload):
                await call(bad)
    assert sim.calls == []


async def test_rows_and_delete_skip_malformed_hashes(sim, api, caplog):
    client = api.app_module.downloader
    good = make_hash("good")
    sim.add_torrent(torrent("good", category="tv-sonarr"))
    assert await client.rows(["all", None, "a|b"]) == []
    await client.delete_with_data(["all", 7])
    assert sim.called("/torrents/info") == [] and sim.called("/torrents/delete") == []
    assert "ignoring malformed info-hash 'all'" in caplog.text
    rows = await client.rows(["all", good.upper()])
    assert [r["hash"] for r in rows] == [good]
    assert sim.called("/torrents/info")[-1] == {"hashes": good}
    await client.delete_with_data([good.upper(), "all"])
    assert sim.called("/torrents/delete") == [{"hashes": good, "deleteFiles": "true"}]


async def test_delete_with_data_failure_is_a_download_error(sim, api):
    sim.add_torrent(torrent("x"))
    sim.fail("/torrents/delete", status=500, body="boom")
    with pytest.raises(qb.DownloadError):
        await api.app_module.downloader.delete_with_data([make_hash("x")])
