"""The gzip middleware (app.py `_GZipExceptStreams`).

Contract (its docstring): the JSON API is gzipped (minimum_size 1024,
compresslevel 6), but the video stream (`.../stream`, GET and HEAD) and every
`/hls/` path never are: the stream answers Range requests of a growing file
with 206 + Content-Range + Content-Length, and gzip would drop the length and
make the byte offsets meaningless.

The installed Starlette also skips video/* and 206 on its own, which would
hide a broken path bypass behind it. So besides the end-to-end checks, the
bypass rule is tested against a fake inner app that answers text/plain 200 —
a body Starlette *would* compress if the bypass didn't hold.
"""

from __future__ import annotations

import gzip
import zlib

import pytest
from starlette.middleware import Middleware

from tests.support.arr import series_obj
from tests.support.growing import GrowingFile
from tests.support.qbit import make_hash

GZ = {"Accept-Encoding": "gzip"}
PLAIN = {"Accept-Encoding": "identity"}  # httpx itself sends "gzip, deflate" by default


def gzip_level(body: bytes, level: int) -> bytes:
    """What zlib's gzip wrapper makes of `body` at `level` (deterministic: mtime 0)."""
    c = zlib.compressobj(level, zlib.DEFLATED, 16 + zlib.MAX_WBITS)
    return c.compress(body) + c.flush()


# ---------------------------------------------------------------- the app's JSON API


async def test_middleware_is_installed_on_the_app(app_module):
    mws = [m for m in app_module.app.user_middleware if isinstance(m, Middleware)]
    assert [m.cls for m in mws].count(app_module._GZipExceptStreams) == 1


async def test_large_json_answer_is_gzipped_when_asked(api, sonarr):
    sonarr.set_lookup("dark", [series_obj(100 + i, f"Dark {i}") for i in range(12)])
    plain = await api.get("/api/lookup", params={"q": "dark"}, headers=PLAIN)
    assert plain.status_code == 200
    raw = plain.content
    assert len(raw) > 1024
    assert "content-encoding" not in plain.headers  # not asked -> identity

    r = await api.get("/api/lookup", params={"q": "dark"}, headers=GZ)
    assert r.status_code == 200
    assert r.headers["content-encoding"] == "gzip"
    assert "accept-encoding" in r.headers["vary"].lower()
    assert r.json() == plain.json()  # httpx decodes; the payload is unchanged
    # Content-Length is the compressed size, and smaller than the raw JSON
    assert int(r.headers["content-length"]) < len(raw)


async def test_openapi_json_is_gzipped(api):
    r = await api.get("/openapi.json", headers=GZ)
    assert r.status_code == 200
    assert r.headers["content-encoding"] == "gzip"
    assert r.json()["info"]["title"]


async def test_small_json_is_not_gzipped(api):
    r = await api.get("/health", headers=GZ)
    assert r.status_code == 200
    assert len(r.content) < 1024
    assert "content-encoding" not in r.headers


async def test_small_error_body_is_not_gzipped(api):
    r = await api.get("/api/downloads/not-a-hash/hls/1/index.m3u8", headers=GZ)
    assert r.status_code == 404
    assert "content-encoding" not in r.headers


# ---------------------------------------------------------------- the video stream


SIZE = 300_000


@pytest.fixture
def stream(qbit, tmp_path):
    """A fully downloaded, very compressible single-file torrent."""
    blob = (b"reel" * (SIZE // 4 + 1))[:SIZE]
    g = GrowingFile(tmp_path / "dl" / "Film.2026.mkv", blob, piece_size=64 * 1024)
    g.grow_to(SIZE)
    h = make_hash("gzip")
    qbit.add_growing(h, g)
    return h, blob


@pytest.mark.parametrize("rng,start,end", [
    ("bytes=0-99999", 0, 99_999),
    ("bytes=1000-", 1000, SIZE - 1),
    ("bytes=-5000", SIZE - 5000, SIZE - 1),
])
async def test_stream_206_is_never_gzipped_and_length_is_raw(api, stream, rng, start, end):
    h, blob = stream
    r = await api.get(f"/api/downloads/{h}/stream", headers={**GZ, "Range": rng})
    assert r.status_code == 206
    assert "content-encoding" not in r.headers
    assert r.headers["content-range"] == f"bytes {start}-{end}/{SIZE}"
    assert r.headers["content-length"] == str(end - start + 1)
    assert r.content == blob[start:end + 1]


async def test_stream_full_get_is_never_gzipped(api, stream):
    h, blob = stream
    r = await api.get(f"/api/downloads/{h}/stream", headers=GZ)
    assert r.status_code == 200
    assert "content-encoding" not in r.headers
    assert r.headers["content-length"] == str(SIZE)
    assert r.content == blob


async def test_stream_head_is_never_gzipped(api, stream):
    h, _ = stream
    r = await api.head(f"/api/downloads/{h}/stream", headers=GZ)
    assert r.status_code == 200
    assert "content-encoding" not in r.headers
    assert r.headers["content-length"] == str(SIZE)


# ---------------------------------------------------------------- the bypass rule itself


BODY = ("x" * 63 + "\n").encode() * 64  # 4 KiB of text, very compressible


def _text_app(seen, body=BODY, status=200, ctype=b"text/plain; charset=utf-8"):
    async def app(scope, receive, send):
        seen.append(scope["type"])
        if scope["type"] != "http":
            return
        await send({"type": "http.response.start", "status": status,
                    "headers": [(b"content-type", ctype), (b"content-length", str(len(body)).encode())]})
        await send({"type": "http.response.body", "body": body})
    return app


async def _call(mw, path, *, gz=True, scope_type="http"):
    scope = {"type": scope_type, "path": path, "method": "GET", "query_string": b"",
             "headers": [(b"accept-encoding", b"gzip")] if gz else []}
    out = []

    async def receive():
        return {"type": "http.request", "body": b"", "more_body": False}

    async def send(msg):
        out.append(msg)

    await mw(scope, receive, send)
    if scope_type != "http":
        return None, {}, b""
    start = next(m for m in out if m["type"] == "http.response.start")
    headers = {k.decode().lower(): v.decode() for k, v in start["headers"]}
    body = b"".join(m.get("body", b"") for m in out if m["type"] == "http.response.body")
    return start["status"], headers, body


@pytest.mark.parametrize("path", [
    "/api/downloads/abc/stream",
    f"/api/downloads/{make_hash('s')}/stream",
    "/api/downloads/abc/hls/1/index.m3u8",
    "/api/downloads/abc/hls/1/s00001.m4s",
    "/api/downloads/abc/hls/2/init.mp4",
    "/anything/hls/",
])
async def test_bypassed_paths_reach_the_app_untouched(app_module, path):
    seen = []
    mw = app_module._GZipExceptStreams(_text_app(seen))
    status, headers, body = await _call(mw, path)
    assert status == 200 and seen == ["http"]
    assert "content-encoding" not in headers
    assert "vary" not in headers  # gzip never looked at it
    assert headers["content-length"] == str(len(BODY))
    assert body == BODY


@pytest.mark.parametrize("path", [
    "/api/downloads/abc/streams",       # not *ending* in /stream
    "/api/downloads/abc/stream/x",
    "/api/downloads/abc/hls",           # the start/status route: no trailing slash
    "/api/downloads/abc/probe",
    "/api/charts/top_movies",
    "/api/trailers/dQw4w9WgXcQ/index.m3u8",
])
async def test_other_paths_are_gzipped(app_module, path):
    seen = []
    mw = app_module._GZipExceptStreams(_text_app(seen))
    status, headers, body = await _call(mw, path)
    assert status == 200
    assert headers["content-encoding"] == "gzip"
    assert headers["content-length"] == str(len(body))
    assert gzip.decompress(body) == BODY


async def test_compresslevel_is_6(app_module):
    mw = app_module._GZipExceptStreams(_text_app([]))
    _, _, body = await _call(mw, "/api/charts/x")
    assert body == gzip_level(BODY, 6)


def test_compresslevel_check_can_tell_levels_apart():
    """Guards test_compresslevel_is_6: the body must compress differently at other levels."""
    assert len({gzip_level(BODY, lv) for lv in (1, 6, 9)}) == 3
    assert len(gzip_level(BODY, 6)) < len(BODY) // 4


@pytest.mark.parametrize("n,compressed", [(1023, False), (1024, True)])
async def test_minimum_size_is_1024(app_module, n, compressed):
    body = b"y" * n
    mw = app_module._GZipExceptStreams(_text_app([], body=body))
    _, headers, out = await _call(mw, "/api/charts/x")
    assert ("content-encoding" in headers) is compressed
    assert (gzip.decompress(out) if compressed else out) == body


async def test_without_accept_encoding_nothing_is_gzipped(app_module):
    mw = app_module._GZipExceptStreams(_text_app([]))
    _, headers, body = await _call(mw, "/api/charts/x", gz=False)
    assert "content-encoding" not in headers and body == BODY


async def test_non_http_scopes_pass_through(app_module):
    seen = []
    mw = app_module._GZipExceptStreams(_text_app(seen))
    await _call(mw, "/api/downloads/x/stream", scope_type="lifespan")
    assert seen == ["lifespan"]


async def test_hls_m3u8_from_the_app_is_not_gzipped_even_when_large(api, qbit, app_module):
    """End to end over a real job directory: the playlist is
    application/vnd.apple.mpegurl, which Starlette would compress."""
    from reel_api import livehls

    gid = make_hash("hls-gz")
    j = livehls.Job(gid, 1)
    j.dir.mkdir(parents=True, exist_ok=True)
    lines = ["#EXTM3U", "#EXT-X-VERSION:7", "#EXT-X-TARGETDURATION:7", '#EXT-X-MAP:URI="init.mp4"']
    lines += [f"#EXTINF:6.006000,\ns{i:05d}.m4s" for i in range(200)]
    (j.dir / "index.m3u8").write_text("\n".join(lines) + "\n")
    livehls.live.jobs[j.key] = j
    r = await api.get(f"/api/downloads/{gid}/hls/1/index.m3u8", headers=GZ)
    assert r.status_code == 200 and len(r.content) > 4096
    assert r.headers["content-type"] == "application/vnd.apple.mpegurl"
    assert "content-encoding" not in r.headers
