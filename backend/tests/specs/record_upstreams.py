"""Record real upstream answers for the hand-written fakes to be checked against.

    cd backend && uv run --frozen --group dev python tests/fetch_fixtures.py [--refresh] imdb   # usual way
    cd backend && uv run --frozen --group dev python tests/specs/record_upstreams.py imdb
    cd backend && uv run --frozen --group dev python tests/specs/record_upstreams.py ytdlp [ID ...]
    cd backend && uv run --frozen --group dev python tests/specs/record_upstreams.py ytdlp-repick  # offline

Opt-in and networked (the tests never are): writes trimmed recordings into
tests/recorded/, stripped of anything session- or person-bound (no stream
URLs, no signatures, no client IP, no cookies; nothing here is ever sent with
credentials). The yt-dlp ones are committed; the IMDb ones are not (IMDb's
data: git-ignored, fetched like the Sonarr/Radarr specs — the replay tests
fail without them, naming tests/fetch_fixtures.py).

imdb   Calls IMDb's GraphQL through reel-api's own clients (`Trending._imdb`,
       `Charts._fetch`, so the exact query text, variables and headers the
       product sends), plus two probes of how the edge answers a mistake
       (an unknown field; no `x-imdb-client-name` header). Lists are cut to a
       few entries (tests/recorded/imdb/*.json); a trending list also keeps the
       first entry of each case tests/support/imdb_recorded.py's COVERAGE
       names, and recording fails when IMDb's answer has none of one.

ytdlp  Runs the real `yt-dlp -j` with trailers.py's own argv and format spec
       (no download) for a few trailers, keeps each format's selection-relevant
       fields, then lets the real yt-dlp pick from the *trimmed* list offline
       (`--load-info-json`, a dead proxy proves no request goes out) for every
       height trailers.py may ask for. Those picks are the oracle the fake's
       selector and `mse_video_codec` are tested against
       (tests/recorded/ytdlp/<id>.json).

Re-record when a query or the format spec changes: the replay tests fail
with a pointer here when the product no longer sends what was recorded.
"""

from __future__ import annotations

import asyncio
import datetime as dt
import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent / "recorded"
sys.path.insert(0, str(ROOT.parents[1]))  # backend/, for `tests.support` when run as a script

# Trailers with, between them: AV1 SDR + HDR10, VP9 profile 0 and VP9.2 HDR10,
# H.264, 2:1 "scope" 4K (3840x1920), DRC audio twins, Opus vs AAC.
TRAILERS = {
    "_YUzQa_1RCE": "Dune: Part Two, Official Trailer 3 (AV1/VP9/H.264 SDR to 2160p)",
    "QlDFSu3NSu8": "Furiosa trailer, 4K HDR upload (AV1 + VP9.2 HDR10, 3840x1920)",
    "zgGTVaG2UiQ": "Squid Game S3, Netflix (1080p max, no HDR)",
}
HEIGHTS = [2160, 1440, 1080, 720, 480, 360, 240, 144]

# Format fields yt-dlp's selection and trailers.py read; everything else
# (url, fragments, http_headers, signatures, the client's IP inside the URLs)
# is dropped.
FORMAT_KEYS = (
    "format_id", "format_note", "ext", "protocol", "vcodec", "acodec", "width", "height",
    "fps", "dynamic_range", "tbr", "vbr", "abr", "asr", "audio_channels", "filesize",
    "filesize_approx", "language", "language_preference", "quality", "source_preference",
    "preference", "has_drm", "container", "video_ext", "audio_ext",
)
INFO_KEYS = ("id", "title", "duration", "language", "_format_sort_fields", "extractor", "extractor_key")


# ---------------------------------------------------------------- IMDb


def _trim_dates(title: dict) -> None:
    """Unique release dates in their order, at most 8, the earliest full one always kept."""
    rd = title.get("releaseDates")
    if not rd:
        return
    seen, kept = set(), []
    for x in rd["edges"]:
        k = json.dumps(x["node"], sort_keys=True)
        if k not in seen:
            seen.add(k)
            kept.append(x)
    full = [x for x in kept if all(x["node"].get(f) for f in ("year", "month", "day"))]
    first = min(full, key=lambda x: (x["node"]["year"], x["node"]["month"], x["node"]["day"]), default=None)
    short = kept[:8]
    if first is not None and first not in short:
        short[-1] = first
    rd["edges"] = short


def _trim_imdb(body: dict, keep: int, kind: str | None = None, today: dt.date | None = None) -> dict:
    """The first `keep` edges; with `kind` (a trending answer) also the first edge
    of every COVERAGE case those lack, in IMDb's order."""
    from tests.support import imdb_recorded as ir

    out = json.loads(json.dumps(body))
    for root in (out.get("data") or {}).values():
        edges = root["edges"]
        for e in edges:
            _trim_dates(e["node"].get("title", e["node"]))
        picked = list(range(min(keep, len(edges))))
        if kind is not None:
            have = set().union(*(ir.edge_cases(kind, edges[i], today) for i in picked))
            for case in ir.COVERAGE[kind]:
                if case not in have:
                    i = next((i for i, e in enumerate(edges) if case in ir.edge_cases(kind, e, today)), None)
                    if i is not None:
                        picked.append(i)
                        have |= ir.edge_cases(kind, edges[i], today)
        root["edges"] = [edges[i] for i in sorted(set(picked))]
    if kind is not None:
        lacking = ir.missing(kind, out, today)
        if lacking:
            sys.exit(f"IMDb's trending-{kind} answer today has no {'; no '.join(lacking)} — the replay "
                     "tests need one (tests/support/imdb_recorded.py COVERAGE); try another day")
    return out


async def record_imdb(dest: Path | None = None) -> None:
    import httpx

    from reel_api import charts, trending

    got: list[dict] = []

    async def hook(resp: httpx.Response) -> None:
        await resp.aread()
        req = json.loads(resp.request.content)
        got.append({
            "headers": {k: v for k, v in resp.request.headers.items() if k.lower().startswith("x-imdb")},
            "query": req["query"], "variables": req["variables"],
            "status": resp.status_code, "body": resp.json(),
        })

    today_d = dt.date.today()
    t = trending.Trending({})
    t._client.event_hooks["response"].append(hook)
    c = charts.Charts({})
    c._client.event_hooks["response"].append(hook)
    names = []
    for kind in ("tv", "movie"):
        await t._imdb(kind, today_d)
        names.append((f"trending-{kind}", 8, kind))
    for kind in ("movie", "tv"):
        await c._fetch(charts._BY_KEY["top-" + kind], kind)
        names.append((f"chart-top-{kind}", 12, None))
        await c._fetch(charts._BY_KEY["genre-Sci-Fi"], kind)
        names.append((f"genre-scifi-{kind}", 8, None))
    await t._client.aclose()
    d = dest or ROOT / "imdb"
    d.mkdir(parents=True, exist_ok=True)
    today = today_d.isoformat()
    for (name, keep, kind), rec in zip(names, got):
        assert rec["status"] == 200 and not rec["body"].get("errors"), (name, rec["status"], rec["body"])
        rec = {"recorded": today, **rec, "body": _trim_imdb(rec["body"], keep, kind, today_d)}
        (d / f"{name}.json").write_text(json.dumps(rec, indent=1, ensure_ascii=False) + "\n")

    bad_q = ("query Bad { chartTitles(chart: {chartType: TOP_RATED_MOVIES}, first: 1) "
             "{ edges { node { id noSuchField } } } }")
    r = await c._client.post(trending.IMDB_GRAPHQL, json={"query": bad_q, "variables": {}})
    await c._client.aclose()
    (d / "error-unknown-field.json").write_text(json.dumps(
        {"recorded": today, "query": bad_q, "variables": {}, "status": r.status_code,
         "body": r.json()}, indent=1) + "\n")
    async with httpx.AsyncClient(timeout=20) as h:  # no x-imdb-client-name
        r = await h.post(trending.IMDB_GRAPHQL, json={"query": charts._CHART_QUERY,
                                                      "variables": {"chart": "TOP_RATED_MOVIES"}})
    (d / "error-no-client-name.json").write_text(json.dumps(
        {"recorded": today, "status": r.status_code, "content_type": r.headers.get("content-type"),
         "body": r.text}, indent=1) + "\n")
    print("imdb:", ", ".join(sorted(p.name for p in d.iterdir())))


# ---------------------------------------------------------------- yt-dlp


def _ytdlp() -> str:
    exe = shutil.which("yt-dlp")
    if not exe:
        sys.exit("yt-dlp not on PATH (nix shell nixpkgs#yt-dlp)")
    return exe


# Real uploads without AV1, or with H.264 only, exist (older ones; a 1080p
# upload in AVC alone): the same recorded list with codecs taken away, picked
# by the real yt-dlp, covers the VP9.2 / VP9 / H.264 branches of the choice.
VARIANTS = {
    "all": lambda f: True,
    "no_av1": lambda f: not (f.get("vcodec") or "").startswith("av01"),
    "avc_aac": lambda f: (f.get("vcodec") or "none").startswith(("avc1", "none"))
                         and (f.get("acodec") or "none").startswith(("mp4a", "none")),
}


def _spec_template() -> str:
    """trailers.py's -f spec with {h} for the height (the picks were made with it)."""
    from reel_api import trailers as tr

    return f"({tr.VIDEO_FMT})+({tr.AUDIO_FMT})"


def _picks(base: list[str], rec: dict, url: str) -> dict:
    """{variant: {height: [video_id, audio_id] | None}} chosen by the real yt-dlp, offline."""
    from reel_api import trailers as tr

    out: dict = {}
    with tempfile.TemporaryDirectory() as tmp:
        for name, keep in VARIANTS.items():
            p = Path(tmp) / f"{name}.json"
            p.write_text(json.dumps({**{k: rec.get(k) for k in INFO_KEYS}, "webpage_url": url,
                                     "formats": [f for f in rec["formats"] if keep(f)]}))
            out[name] = {}
            for h in HEIGHTS:
                s = f"({tr.VIDEO_FMT.format(h=h)})+({tr.AUDIO_FMT})"
                r = subprocess.run([*base, "--proxy", "http://127.0.0.1:9", "--load-info-json", str(p),
                                    "-f", s, "--print", "format_id"], capture_output=True, text=True, timeout=60)
                out[name][str(h)] = r.stdout.strip().split("+") if r.returncode == 0 else None
    return out


def repick_ytdlp() -> None:
    """Recompute the picks of the committed recordings (offline; after a VARIANTS change)."""
    exe = _ytdlp()
    base = [exe, "--no-cache-dir", "--no-warnings", "--no-playlist", "--quiet"]
    for p in sorted((ROOT / "ytdlp").glob("*.json")):
        rec = json.loads(p.read_text())
        rec["picks"] = _picks(base, rec, "https://www.youtube.com/watch?v=" + rec["id"])
        rec["spec"] = _spec_template()
        p.write_text(json.dumps(rec, indent=1, ensure_ascii=False) + "\n")
        print(p.name, rec["picks"])


def record_ytdlp(ids: list[str]) -> None:
    from reel_api import trailers as tr

    exe = _ytdlp()
    base = [exe, "--no-cache-dir", "--no-warnings", "--no-playlist", "--quiet"]
    assert tr.Trailers._ytdlp(tr.Trailers.__new__(tr.Trailers))[1:] == base[1:], "trailers.py's argv changed"
    version = subprocess.run([exe, "--version"], capture_output=True, text=True, check=True).stdout.strip()
    d = ROOT / "ytdlp"
    d.mkdir(parents=True, exist_ok=True)
    for yt_id in ids:
        spec = f"({tr.VIDEO_FMT.format(h=tr.MAX_HEIGHT)})+({tr.AUDIO_FMT})"
        url = "https://www.youtube.com/watch?v=" + yt_id
        info = json.loads(subprocess.run([*base, "-j", "-f", spec, url], capture_output=True,
                                         text=True, check=True, timeout=120).stdout)
        formats = []
        for f in info["formats"]:
            kept = {k: f[k] for k in FORMAT_KEYS if k in f}
            kept["url"] = f"https://rr.googlevideo.invalid/{yt_id}/{f['format_id']}"  # selection wants one
            formats.append(kept)
        rec = {k: info.get(k) for k in INFO_KEYS}
        rec["subtitles"] = {k: [x.get("ext") for x in v] for k, v in (info.get("subtitles") or {}).items()}
        rec["automatic_captions"] = sorted((info.get("automatic_captions") or {}))[:6]
        rec["formats"] = formats
        live_pick = [f["format_id"] for f in info["requested_formats"]]

        rec["picks"] = _picks(base, rec, url)
        rec["spec"] = _spec_template()
        assert rec["picks"]["all"][str(tr.MAX_HEIGHT)] == live_pick, (yt_id, rec["picks"], live_pick)
        rec["recorded"] = dt.date.today().isoformat()
        rec["yt_dlp"] = version
        rec["note"] = TRAILERS.get(yt_id, "")
        (d / f"{yt_id}.json").write_text(json.dumps(rec, indent=1, ensure_ascii=False) + "\n")
        print(f"ytdlp {yt_id}: {len(formats)} formats, picks {picks}")


if __name__ == "__main__":
    what, *rest = sys.argv[1:] or ["?"]
    if what == "imdb":
        asyncio.run(record_imdb())
    elif what == "ytdlp-repick":
        repick_ytdlp()
    elif what == "ytdlp":
        record_ytdlp(rest or list(TRAILERS))
    else:
        sys.exit(__doc__)
