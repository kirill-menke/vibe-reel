from enum import Enum

from pydantic import BaseModel


class Category(str, Enum):
    movies = "movies"
    tv = "tv"
    games = "games"
    music = "music"
    apps = "apps"
    documentaries = "documentaries"
    anime = "anime"
    other = "other"
    xxx = "xxx"

    @property
    def site_value(self) -> str:
        return {
            Category.movies: "Movies",
            Category.tv: "TV",
            Category.games: "Games",
            Category.music: "Music",
            Category.apps: "Apps",
            Category.documentaries: "Documentaries",
            Category.anime: "Anime",
            Category.other: "Other",
            Category.xxx: "XXX",
        }[self]


class Sort(str, Enum):
    time = "time"
    size = "size"
    seeders = "seeders"
    leechers = "leechers"


class Order(str, Enum):
    asc = "asc"
    desc = "desc"


class SearchResult(BaseModel):
    id: str
    title: str
    seeders: int
    leechers: int
    size_bytes: int | None
    size: str
    uploaded_at: str | None  # ISO 8601 date, best-effort parse


class SearchResponse(BaseModel):
    query: str
    page: int
    total_pages: int
    results: list[SearchResult]


class MagnetResponse(BaseModel):
    id: str
    magnet: str
    info_hash: str | None


class DownloadRequest(BaseModel):
    magnet: str


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


class LibraryAddRequest(BaseModel):
    id: str
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
    status: str  # "removed" | "removing" (deleted once its running searches end) | "already_removed"
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
    id: str  # tvdb id
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


class ActivityResponse(BaseModel):
    items: list[ActivityItem]


class Download(BaseModel):
    id: str
    status: str  # queued | downloading | paused | complete | error | removed
    name: str | None
    progress: float  # 0.0 - 1.0
    size_bytes: int | None
    downloaded_bytes: int
    download_speed: int  # bytes/sec
    eta_s: int | None
    error_detail: str | None = None


class ApiError(BaseModel):
    error: str
    detail: str


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
