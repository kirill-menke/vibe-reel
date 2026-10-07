from pydantic import BaseModel, Field


class LookupResult(BaseModel):
    id: str
    type: str  # "tv" | "movie"
    title: str
    year: int | None
    overview: str
    poster: str | None
    added: bool
    votes: int = 0  # popularity signal (IMDb-scale vote count) for ranking
    original_title: str | None = None  # Radarr's original-language title, when it differs


class LookupResponse(BaseModel):
    query: str
    type: str
    results: list[LookupResult]


class TrendingResult(LookupResult):
    """A lookup result that also carries why it is on the trending rail."""

    imdb_id: str
    rating: float  # IMDb rating
    rating_votes: int  # IMDb vote count
    rank: int  # IMDb popularity rank (MOVIEmeter/TVmeter), 1 = most popular
    released: str  # ISO date: primary release (movie) / first episode (show)
    digital_release: str | None = None  # ISO date, movies only, when Radarr knows it


class TrendingResponse(BaseModel):
    type: str
    results: list[TrendingResult]


# A tvdb/tmdb id as the lookups hand it out: canonical decimal, no sign, no
# leading zero. The arrs parse the lookup term with int.TryParse, so "0603"
# would add 603 under an owner record keyed "0603" that no listing matches.
MEDIA_ID = r"^[1-9][0-9]{0,9}$"


class LibraryAddRequest(BaseModel):
    id: str = Field(pattern=MEDIA_ID)
    type: str  # "tv" | "movie"


class LibraryAddResult(BaseModel):
    id: str
    type: str
    title: str
    status: str
    # Hand back to DELETE /api/library/{type}/{id}?undo= to undo this add
    # (valid ~10 min, in-memory). None when the arr didn't say what it created.
    undo: str | None = None


class LibraryUndoResult(BaseModel):
    id: str
    type: str
    title: str
    # undo:   "removed" | "removing" (deleted once its running searches end) | "already_removed"
    # delete: "deleted" | "deleting" (deleted with its files once its running searches end)
    #         | "already_removed"
    status: str
    downloads_removed: int  # grabs removed from the queue + qBittorrent


class EpisodeMetadata(BaseModel):
    season: int | None
    episode: int | None
    title: str
    overview: str
    air_date: str | None  # ISO date
    still: str | None  # remote https episode still, when TheTVDB has one
    has_file: bool


class CollectionRef(BaseModel):
    id: str  # TMDB collection id — what /api/collection/{id} takes
    title: str


class TitleMetadata(BaseModel):
    """Everything Sonarr/Radarr know about a title, downloaded or not — lets a
    client render a queued/pending title like a finished one. `id` is the same
    opaque lookup id (tvdbId/tmdbId); `episodes` is tv-only (empty for movies
    and for a series not yet added)."""

    id: str
    type: str  # "tv" | "movie"
    title: str
    year: int | None
    overview: str
    poster: str | None
    fanart: str | None  # remote https backdrop
    runtime_min: int | None
    genres: list[str]
    rating: float | None
    certification: str | None
    status: str | None  # continuing/ended (tv), released/inCinemas… (movie)
    episodes: list[EpisodeMetadata]
    trailer: str | None = None  # YouTube video id (Radarr's youTubeTrailerId; movies only)
    collection: CollectionRef | None = None  # the TMDB collection a movie belongs to
    digital_release: str | None = None  # ISO date of Radarr's digital release (movies only)


class CollectionMovie(LookupResult):
    """One film of a collection, lookup-shaped (id = tmdb id)."""

    rating: float | None = None  # IMDb rating, else TMDB
    released: str | None = None  # ISO date of the primary release, when known


class Collection(BaseModel):
    """A TMDB movie collection, its films in release order."""

    id: str
    title: str
    overview: str
    poster: str | None
    fanart: str | None
    movies: list[CollectionMovie]


class NewsItem(BaseModel):
    """A new season of a show already in Sonarr, with no file yet. `kind`:
    "aired" (episodes are out, latest within a year) or "upcoming" (on TheTVDB,
    nothing aired). `id` is stable per season *and* kind, so a season that
    goes from upcoming to aired reads as a fresh notification."""

    id: str  # "{tvdb}:{season}:{kind}"
    kind: str  # "aired" | "upcoming"
    media_id: str  # tvdb id — the same opaque id /api/lookup hands out
    title: str
    year: int | None
    poster: str | None
    fanart: str | None
    season: int
    premiere: str | None  # ISO UTC: first episode's air time (None = date not announced)
    last_aired: str | None  # ISO UTC, aired only
    episodes_aired: int
    episodes_total: int
    monitored: bool  # series + season monitored: Sonarr will grab it by itself


class NewsResponse(BaseModel):
    items: list[NewsItem]


class SeasonSearchRequest(BaseModel):
    id: str = Field(pattern=MEDIA_ID)  # tvdb id
    season: int


class SeasonSearchResult(BaseModel):
    id: str
    season: int
    title: str
    status: str  # "searching"
    # Hand back to DELETE /api/news/search/{undo} to undo this search.
    undo: str | None = None


class SeasonSearchUndoResult(BaseModel):
    id: str
    season: int
    title: str
    status: str  # "reverted"
    downloads_removed: int
    kept: int  # grabs already importing, left alone


class CancelledEpisode(BaseModel):
    season: int | None
    episode: int | None


class CancelResult(BaseModel):
    id: str
    type: str
    status: str  # "cancelled"
    downloads_removed: int
    # every episode the cancelled torrents covered (a season pack is all of
    # them, even when one episode was asked for); empty for a movie
    episodes: list[CancelledEpisode]
    unmonitored: int  # episodes (tv) / movies (movie) now unmonitored
    kept: int  # downloads skipped because they were already importing


class ActivityItem(BaseModel):
    id: str
    type: str  # "tv" | "movie"
    title: str
    subtitle: str
    status: str  # queued | downloading | importing | completed | paused | warning
    progress: float  # 0.0 - 1.0
    size_bytes: int | None
    timeleft: str | None
    quality: str | None
    download_speed: int  # bytes/sec, live from qBittorrent (0 if stalled/queued)
    # Sonarr/Radarr's reason when a row needs attention (errorMessage or the
    # statusMessages, e.g. "No files found are eligible for import"), one line,
    # ≤160 chars; None when there is none.
    message: str | None = None
    # Structured identity/metadata for clients that merge activity into their
    # own library UI. media_id is the same opaque id /api/lookup returns
    # (tvdbId for tv, tmdbId for movies); season/episode/episode_title are
    # tv-only; poster is a remote https image URL straight from Sonarr/Radarr.
    media_id: str | None = None
    season: int | None = None
    episode: int | None = None
    episode_title: str | None = None
    poster: str | None = None
    year: int | None = None
    # The grab's info-hash — the handle for /api/downloads/{id}/stream and
    # /probe, i.e. watch-while-downloading. None until the grab reaches the
    # download client.
    download_id: str | None = None
    # The row belongs to the caller: their title, or (tv) a season they asked
    # for with "Get" (ownership.py).
    mine: bool = False
    # The caller may cancel it (DELETE /api/activity/...): an admin, or mine.
    can_cancel: bool = True


class ActivityResponse(BaseModel):
    items: list[ActivityItem]


class ApiError(BaseModel):
    error: str
    detail: str


class QuotaError(BaseModel):
    """The 409 body of POST /api/library over the quota (ownership.py)."""

    error: str  # "quota_exceeded"
    detail: str  # a sentence for the user ("You already have 10 of 10 movies. …")
    type: str  # "movie" | "tv"
    used: int
    limit: int


class MeUser(BaseModel):
    id: str  # Jellyfin user id, 32 lowercase hex
    name: str


class QuotaUse(BaseModel):
    used: int  # titles of this kind the user added that still exist
    limit: int | None  # None = no limit (an admin)


class Quota(BaseModel):
    movie: QuotaUse
    tv: QuotaUse


class OwnedTitle(BaseModel):
    type: str  # "movie" | "tv"
    id: str  # tmdb / tvdb id, as /api/lookup hands it out
    title: str
    year: int | None
    poster: str | None
    added_at: str  # UTC ISO, when it was added here
    # downloading | queued | importing | paused | warning (grabs in flight, the
    # most active one) | waiting (nothing grabbed, no files) | in_library
    status: str
    progress: float | None  # 0..1 over its grabs in flight, else None
    has_files: bool  # anything of it on disk (a series can be downloading too)


class MeResponse(BaseModel):
    """GET /api/me — the caller, their quota and the titles they own."""

    user: MeUser
    admin: bool  # Jellyfin's Policy.IsAdministrator: may do everything, no quota
    quota: Quota
    titles: list[OwnedTitle]


class ChartCategory(BaseModel):
    key: str  # "top-movie" | "top-tv" | "genre-<Genre>"
    title: str
    types: list[str]  # the kinds its titles come in ("movie", "tv")
    count: int
    posters: list[str]  # a few IMDb poster thumbnails for the category tile


class ChartIndex(BaseModel):
    categories: list[ChartCategory]


class ChartResult(LookupResult):
    imdb_id: str
    rating: float | None  # IMDb rating
    rating_votes: int  # IMDb vote count
    rank: int  # position in the chart, 1-based


class ChartSection(BaseModel):
    type: str
    title: str
    results: list[ChartResult]


class Chart(BaseModel):
    key: str
    title: str
    sections: list[ChartSection]


class CommunitySegment(BaseModel):
    start: float  # seconds
    end: float
    submissions: int  # how many people marked it (IntroDB's submission_count)


class CommunitySegments(BaseModel):
    """IntroDB's crowdsourced skip windows for one episode; null = not submitted."""

    intro: CommunitySegment | None
    recap: CommunitySegment | None
    outro: CommunitySegment | None
