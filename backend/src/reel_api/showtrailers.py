"""A YouTube trailer for a show — VibeReel's Trailer button where nothing else has one.

  GET /api/metadata/{type}/{id}/trailer  -> {trailer: <YouTube id> | null}

Movies have a trailer from Radarr (`youTubeTrailerId`, also in
/api/metadata/movie) and, in the library, from Jellyfin's TMDB
`RemoteTrailers`. Shows only ever had Jellyfin's: Sonarr's metadata carries
no trailer (nor does its SkyHook), and TMDB's own API needs a key reel-api
doesn't have. So a show opened from Search, Trending or a chart never had a
Trailer button, and neither has a library show TMDB lists no YouTube trailer
for (measured 2026-10-10: 6 of the NAS's 7 series have RemoteTrailers, all 16
movies do). For a show this searches YouTube instead — `yt-dlp
--flat-playlist ytsearch10:"<name> official trailer"`, one request, ~1.2 s,
the same yt-dlp trailers.py then plays the result with — and takes a result
only when everything says it is *this* show's trailer. A wrong trailer —
another show of the same name, a remake, the film, a fan edit, a reaction
video — is worse than no button, so a result must pass all of these
(`accept()`):

  * a verified channel uploaded it (studios, networks, trailer outlets; fan
    edits and re-uploads mostly come from unverified ones), not a channel for
    one country's dub (FOREIGN_CHANNEL), and it runs 20 s – 6 min;
  * its title starts with the show's name, articles included ("The House"
    is a film, not "House"), and between the name and the word
    "trailer"/"teaser" stand only words like official / season 2 / final /
    extended — "Planet Earth II: …", "Friends: The Reunion …", "Steins;Gate
    0 …" are other titles;
  * nothing after the name makes it something else: a reaction, review,
    recap, fan edit, parody, the movie, the game, a dub (JUNK);
  * every year it names is the premiere year ±1: "Fargo (1996) | Official
    Trailer" is the film, "Persona (2024)" another Persona, and a later
    season's "(2026)" isn't the trailer to start a show with either;
  * it isn't for the final (or last) season: that one shows how the story
    ends — Breaking Bad's only verified hit besides Sony's "Seasons 1-5
    Trailer" was Netflix's "The Final Season Teaser", Hank finding out;
  * the name is unambiguous: if Sonarr or Radarr know another show or film
    of the same name (CLASH_VOTES votes, or any if it is recent — an
    upcoming title has few votes and a trailer everywhere), the title has to
    name the premiere year, and none of the other's. "Avatar: The Last
    Airbender | Official Trailer | Netflix" is the 2024 remake, not the 2005
    series; "SHŌGUN Official Trailer (2024)" passes next to the 1980 one.

Of the results that pass, a first-season (or season-less, or "Seasons 1-5")
trailer beats a numbered later season's — someone about to start a show
shouldn't see where it goes — then a trailer beats a teaser, then YouTube's
order.

Measured 2026-10-10 on 247 shows (IMDb's Top 250 shows + trending): 109 get
a trailer, every one of them the right show on inspection; the rules above
are what it took to get there (title prefix + verified channel alone picked
the 2024 Avatar for the 2005 one, the 2017 film for "Life", A24's "Civil War"
for Ken Burns' "The Civil War"). The rest get no button — older shows have
no verified upload, an ambiguous name rarely gets a dated title.

Answers are cached per show (HIT_TTL, MISS_TTL). A failed search (yt-dlp
broken by a YouTube change, YouTube unreachable) answers null — the client
shows no button either way — and is retried after ERR_TTL; a Sonarr/Radarr
failure is the route's usual 503 and caches nothing.
"""

import asyncio
import json
import logging
import re
import shutil
import time
import unicodedata
from collections import OrderedDict
from datetime import datetime, timezone

from .arr import _when
from .trailers import _last_line, _run

log = logging.getLogger("reel_api")

SEARCH_RESULTS = 10
SEARCH_TIMEOUT = 20
MAX_SEARCHES = 2  # yt-dlp searches at once
MIN_DURATION = 20
MAX_DURATION = 6 * 60
# Another title of the same name with fewer votes than this doesn't make the
# name ambiguous (a 1950s short, an unknown local drama) — unless it is recent
# (clash_years). IMDb-scale: what Sonarr/Radarr's lookups report as votes.
# Measured on the 247 shows: a floor of 0 cost 22 right trailers (Succession,
# Sherlock, Andor: a same-named film from 1992 with 41 votes), 1000 let
# "Persona (2024)", a film with 111 votes, through.
CLASH_VOTES = 100
HIT_TTL = 7 * 24 * 3600
MISS_TTL = 24 * 3600
ERR_TTL = 10 * 60
CACHE_MAX = 2000

TRAILER_WORDS = {"trailer", "teaser"}
# Words that may stand between the show's name and "trailer"/"teaser".
LEAD_WORDS = {
    "official", "the", "new", "final", "first", "last", "extended", "main", "launch",
    "full", "complete", "limited", "series", "season", "seasons", "hd", "4k", "uhd", "us", "uk",
}
# ...and numbers may follow one of these ("Season 2", "Volume 1", "Seasons 1-5").
COUNT_WORDS = {"season", "seasons", "series", "volume", "vol", "chapter"}
NUMBER_WORDS = {"one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6, "seven": 7,
                "eight": 8, "nine": 9, "ten": 10}
LATER = {"final", "last", "new", "next"}  # "Final Season": not the one to start with
FINAL = {"final", "last"}  # ...and "Final Season" is never taken (accept())
ORDINALS = {"first": 1, "second": 2, "third": 3, "fourth": 4, "fifth": 5, "sixth": 6,
            "seventh": 7, "eighth": 8, "ninth": 9, "tenth": 10}
# Anywhere after the name: this video is not the show's own trailer (or not
# in its own language — a dubbed trailer only when nothing else is offered,
# like trailer.js pickTrailer() on Jellyfin's list).
JUNK = {
    "reaction", "reactions", "react", "reacts", "reacting", "review", "reviews", "recap", "recaps",
    "explained", "explainer", "breakdown", "analysis", "theory", "theories", "ending", "spoiler",
    "spoilers", "fan", "fans", "fanmade", "unofficial", "parody", "spoof", "honest", "comparison",
    "vs", "versus", "edit", "edits", "edited", "recut", "remix", "mashup", "ai", "concept", "fake",
    "lego", "minecraft", "roblox", "music", "song", "soundtrack", "ost", "theme", "opening", "intro",
    "credits", "behind", "bts", "featurette", "interview", "interviews", "clip", "clips", "scene",
    "scenes", "bloopers", "deleted", "sneak", "peek", "episode", "episodes", "movie", "film",
    "game", "gameplay", "cinematic", "ps4", "ps5", "xbox", "nintendo", "steam", "dlc", "live",
    "remake", "reboot", "musical", "broadway", "audiobook", "podcast", "tribute", "meme", "memes",
    "cosplay", "toy", "toys", "shorts", "dub", "dubbed", "deutsch", "german", "dublado", "legendado",
    "oficial", "subtitulado", "espanol", "latino", "castellano", "vostfr", "vf", "vost", "ita",
    "italiano", "hindi", "tamil", "telugu", "malayalam", "kannada", "french", "francais", "russian",
    "polski", "turkce", "portugues", "arabic",
}
# A channel for one country's audience dubs (Cartoon Network Deutschland,
# Netflix Latinoamérica) — the show's own channels and the international ones
# are the original.
FOREIGN_CHANNEL = {
    "deutschland", "germany", "deutsch", "france", "francais", "espana", "latino", "latinoamerica",
    "latam", "brasil", "brazil", "italia", "polska", "turkiye", "russia", "mexico",
}
_YOUTUBE_ID = re.compile(r"[A-Za-z0-9_-]{11}")
_YEAR = re.compile(r"(19|20)\d\d")
_SEASON_TAG = re.compile(r"s(\d{1,2})")
_COUNT = re.compile(r"(\d{1,2})(?:st|nd|rd|th)?")
# TVDB's disambiguation suffix in Sonarr's titles: "Doctor Who (2023)", "The Office (US)".
_SUFFIX = re.compile(r"(\s*\((\d{4}|[A-Za-z]{2,3})\))+\s*$")


def words(s: str | None) -> list[str]:
    """Accents folded, lowercase, apostrophes dropped, '&' read as 'and', split
    on everything else that isn't a letter or digit. Articles stay: "The
    House" (a film) is not "House", "Civil War" (a film) not "The Civil War"."""
    s = unicodedata.normalize("NFKD", s or "")
    s = "".join(c for c in s if not unicodedata.combining(c)).lower()
    s = re.sub(r"['’`]", "", s).replace("&", " and ")
    return re.sub(r"[^a-z0-9]+", " ", s).split()


def show_name(title: str) -> str:
    """The name a show is published under: TVDB's "(2023)"/"(US)" tag dropped."""
    return _SUFFIX.sub("", title or "").strip()


def premiere_year(obj: dict) -> int | None:
    """The year a show (a Sonarr series) started."""
    if obj.get("year"):
        return int(obj["year"])
    first = _when(obj.get("firstAired"))
    return first.year if first else None


def clash_years(name: str, tvdb_id: str, shows: list[dict], movies: list[dict],
                today: datetime | None = None) -> list[int]:
    """Start years of the *other* shows and films called `name`, from
    lookup-shaped Sonarr/Radarr results (0 for an unknown year)."""
    key = words(name)
    recent = (today or datetime.now(timezone.utc)).year - 1

    def known(r: dict) -> bool:
        # Few votes yet is what an upcoming title has — with its trailer on
        # every trailer channel. An older one few people rated has none worth
        # finding, and one without even a year is a metadata stub.
        return (r.get("votes") or 0) >= CLASH_VOTES or (r.get("year") or 0) >= recent

    out = []
    for r in shows:
        if r.get("id") != tvdb_id and known(r) and words(show_name(r.get("title") or "")) == key:
            out.append(r.get("year") or 0)
    for r in movies:
        if known(r) and key in (words(r.get("title")), words(r.get("original_title"))):
            out.append(r.get("year") or 0)
    return out


def _season(rest: list[str]) -> int:
    """The season a trailer is for, from the words after the show's name
    ("Season 2", "Series 5", "S3", "Second Season"; "Final/New Season": 99),
    or 0."""
    for i, t in enumerate(rest):
        nxt = rest[i + 1] if i + 1 < len(rest) else ""
        if t in ("season", "series") and (m := _COUNT.fullmatch(nxt)):
            return int(m.group(1))
        if t in ("season", "series") and nxt in NUMBER_WORDS:
            return NUMBER_WORDS[nxt]
        if nxt == "season" and t in ORDINALS:
            return ORDINALS[t]
        if nxt == "season" and t in LATER:
            return 99
        if m := _SEASON_TAG.fullmatch(t):
            return int(m.group(1))
    return 0


def accept(entry: dict, name: list[str], first: int, clashes: list[int]) -> tuple[int, int] | None:
    """(later_season, teaser_only) if this search result is the trailer of the
    show called `name` (words()) that premiered in `first` — the sort key among
    those that are — else None. See the module doc for the rules."""
    if entry.get("channel_is_verified") is not True:
        return None
    if any(t in FOREIGN_CHANNEL for t in words(entry.get("channel"))):
        return None
    dur = entry.get("duration")
    if not isinstance(dur, (int, float)) or not MIN_DURATION <= dur <= MAX_DURATION:
        return None
    w = words(entry.get("title"))
    if w[: len(name)] != name:
        return None
    rest = w[len(name):]
    if any(t in JUNK for t in rest):
        return None
    years = [int(t) for t in rest if _YEAR.fullmatch(t)]
    if any(abs(y - first) > 1 for y in years):
        return None
    if clashes and not any(all(abs(y - c) > 1 for c in clashes) for y in years):
        return None
    counting = False  # just after a COUNT_WORD or one of its numbers
    for t in rest:
        if t in TRAILER_WORDS:
            break
        if counting and (_COUNT.fullmatch(t) or t in NUMBER_WORDS):
            continue  # "Season 2", "Seasons 1-5" (the dash is gone: "seasons 1 5")
        counting = t in COUNT_WORDS
        if counting or t in LEAD_WORDS or t in ORDINALS or _YEAR.fullmatch(t) or _SEASON_TAG.fullmatch(t):
            continue
        return None  # another title ("Planet Earth II", "Friends: The Reunion")
    else:
        return None  # never says trailer/teaser
    if any(t in FINAL and nxt in ("season", "series") for t, nxt in zip(rest, rest[1:])):
        return None  # the ending
    return int(_season(rest) > 1), int("trailer" not in rest)


def pick(entries: list[dict], name: str, first: int, clashes: list[int]) -> dict | None:
    """The best search result that is the show's trailer, or None."""
    key = words(name)
    if not key:
        return None
    ok = []
    for rank, e in enumerate(entries):
        if not isinstance(e, dict) or not _YOUTUBE_ID.fullmatch(str(e.get("id") or "")):
            continue
        k = accept(e, key, first, clashes)
        if k is not None:
            ok.append((k, rank, e))
    return min(ok, key=lambda x: (x[0], x[1]))[2] if ok else None


def search_argv(exe: str, query: str) -> list[str]:
    """The YouTube search: the first SEARCH_RESULTS hits as one JSON
    playlist, each a flat entry (id, title, duration, channel,
    channel_is_verified, … — no per-video request)."""
    return [exe, "--no-cache-dir", "--no-warnings", "--quiet", "--flat-playlist", "-J",
            f"ytsearch{SEARCH_RESULTS}:{query}"]


class SearchFailed(Exception):
    """yt-dlp couldn't search YouTube (broken, missing, timed out)."""


class ShowTrailers:
    """GET /api/metadata/tv/{id}/trailer: see the module doc."""

    def __init__(self, arr_clients: dict):
        self.arr = arr_clients
        # tvdb id -> (fetched_at, "hit" | "miss" | "err", YouTube id or None)
        self._cache: OrderedDict[str, tuple[float, str, str | None]] = OrderedDict()
        self._inflight: dict[str, asyncio.Task] = {}
        self._sem = asyncio.Semaphore(MAX_SEARCHES)

    async def get(self, tvdb_id: str) -> str | None:
        """The show's YouTube trailer id, or None. Raises NoSuchTitle for an id
        Sonarr doesn't know and ArrError when Sonarr/Radarr can't answer."""
        hit = self._cache.get(tvdb_id)
        if hit and time.monotonic() - hit[0] < {"hit": HIT_TTL, "miss": MISS_TTL, "err": ERR_TTL}[hit[1]]:
            self._cache.move_to_end(tvdb_id)
            return hit[2]
        task = self._inflight.get(tvdb_id)
        if task is None:
            task = self._inflight[tvdb_id] = asyncio.create_task(self._fill(tvdb_id))
        # shield: one waiter going away must not cancel the others' search
        return await asyncio.shield(task)

    async def _fill(self, tvdb_id: str) -> str | None:
        try:
            try:
                found = await self._find(tvdb_id)
                kind = "hit" if found else "miss"
            except SearchFailed as e:
                log.warning("show trailer %s: %s", tvdb_id, e)
                found, kind = None, "err"
            self._cache[tvdb_id] = (time.monotonic(), kind, found)
            self._cache.move_to_end(tvdb_id)
            while len(self._cache) > CACHE_MAX:
                self._cache.popitem(last=False)
            return found
        finally:
            self._inflight.pop(tvdb_id, None)

    async def _find(self, tvdb_id: str) -> str | None:
        sonarr, radarr = self.arr["tv"], self.arr.get("movie")
        obj = await sonarr.lookup_record(tvdb_id)
        name, first = show_name(obj.get("title") or ""), premiere_year(obj)
        if not words(name) or not first:
            return None

        async def no_films() -> list[dict]:
            return []

        shows, films, entries = await asyncio.gather(
            sonarr.title_lookup(name),
            radarr.title_lookup(name) if radarr else no_films(),
            self._search(name + " official trailer"),
            return_exceptions=True,
        )
        for r in (shows, films, entries):  # an arr failure first: it is the route's 503
            if isinstance(r, BaseException) and not isinstance(r, SearchFailed):
                raise r
        if isinstance(entries, SearchFailed):
            raise entries
        best = pick(entries, name, first, clash_years(name, tvdb_id, shows, films))
        log.info("show trailer %s (%s, %d): %s", tvdb_id, name, first,
                 f"{best['id']} \"{best.get('title')}\" ({best.get('channel')})" if best else "none")
        return best["id"] if best else None

    async def _search(self, query: str) -> list[dict]:
        exe = shutil.which("yt-dlp")
        if exe is None:
            raise SearchFailed("yt-dlp not on PATH")
        async with self._sem:
            try:
                rc, out, err = await _run(*search_argv(exe, query), timeout=SEARCH_TIMEOUT)
            except asyncio.TimeoutError:
                raise SearchFailed("search timed out") from None
            except OSError as e:
                raise SearchFailed(f"yt-dlp: {e}") from None
        if rc != 0:
            raise SearchFailed("yt-dlp: " + _last_line(err))
        try:
            entries = json.loads(out).get("entries")
        except (ValueError, AttributeError):
            raise SearchFailed("yt-dlp: unreadable answer") from None
        if not isinstance(entries, list):
            raise SearchFailed("yt-dlp: no search results list")
        return entries
