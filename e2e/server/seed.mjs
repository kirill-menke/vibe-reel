/* Synthetic, deterministic seed data for the fake Jellyfin + reel-api.
 *
 * createWorld(opts) → a fresh in-memory world. Every test gets its own (the
 * runner calls server.reset()), and tests mutate it directly to set up their
 * case (world.ml.activity.push(...), world.userData…).
 *
 * Shapes follow Jellyfin 12.1's BaseItemDto (only what the apps read, plus the
 * always-present basics) and reel-api's pydantic models (backend/src/reel_api/
 * models.py). Ids are 32-hex GUIDs ("N" format, as Jellyfin hands them out),
 * derived from names, so they are stable across runs and tests can address
 * items by name: world.byName('Movie', 'The Silent Harbor').
 *
 * Options: movies (library size, default 140), now (ms), bigCharts (a
 * 250-entry Top 250 Movies chart; topped up with "Chart Film N", 910001…),
 * preset (below). A test picks them with test(name, { seed: {…} }).
 *
 * Presets — each deterministic (same names, ids, order on every run):
 *   (none)   the default world: alice (password, admin) + bob (none, no
 *            avatar, normal user) + kirill (kirill-pw, admin) + nicole
 *            (nicole-pw, no avatar, normal user),
 *            140 movies, 6 series, alice's Continue Watching (2 movies + NL
 *            S1E3) and Next Up (Paper Kingdom S2E1, Electric Orchard E5), an
 *            activity feed (a downloading movie, a queued new show, a
 *            downloading NL episode), 2 news items, 60-entry charts.
 *   'empty'  a new account on the same library: no play state for anyone (no
 *            Continue Watching / Next Up), an empty activity feed, no news.
 *   'big'    400 movies (titles past the 360 two-word combinations get a
 *            " II" suffix) and bigCharts (250-entry Top 250 Movies).
 * Explicit options win over a preset's (e.g. { preset: 'big', movies: 300 }).
 *
 * Scenario builders over a world (ep, movie, setPosition, addPending,
 * landImport …) live in e2e/lib/world.mjs.
 *
 * Dates are relative to the moment the world is created. */
import { createHash } from 'node:crypto';

export const TICKS = 10_000_000;
const DAY = 86_400_000;

export function gid(...parts) {
  return createHash('md5').update(parts.join(':')).digest('hex');
}
const tag = (...p) => gid('tag', ...p).slice(0, 16);

const ADJ = ['Silent', 'Crimson', 'Northern', 'Hollow', 'Golden', 'Paper', 'Iron', 'Velvet', 'Distant', 'Broken', 'Electric', 'Quiet', 'Wild', 'Glass', 'Last', 'Hidden', 'Burning', 'Pale', 'Restless', 'Secret'];
const NOUN = ['Harbor', 'Meridian', 'Orchard', 'Signal', 'Frontier', 'Lantern', 'Tide', 'Kingdom', 'Garden', 'Engine', 'Archive', 'Summit', 'Canyon', 'Mirror', 'Station', 'Comet', 'River', 'Atlas'];
export const GENRES = ['Drama', 'Comedy', 'Thriller', 'Science Fiction', 'Animation', 'Documentary', 'Crime', 'Adventure'];
const FIRST = ['Ava', 'Ben', 'Clara', 'Dev', 'Elena', 'Felix', 'Greta', 'Hugo', 'Iris', 'Jonas', 'Kira', 'Liam', 'Mara', 'Nico', 'Olga', 'Paul'];
const LAST = ['Archer', 'Brandt', 'Castillo', 'Dorsey', 'Ellison', 'Fischer', 'Gallo', 'Hart'];

/* deterministic small PRNG */
function rng(seed) {
  let s = parseInt(gid('rng', seed).slice(0, 8), 16) >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

function title(i) {
  // 360 distinct two-word titles, "The" on every third; then " II", " III"…
  const a = ADJ[i % ADJ.length];
  const n = NOUN[Math.floor(i / ADJ.length) % NOUN.length];
  const round = Math.floor(i / (ADJ.length * NOUN.length));
  return (i % 3 === 0 ? 'The ' : '') + a + ' ' + n + (round ? ' ' + 'I'.repeat(round + 1) : '');
}

export const PRESETS = {
  empty: { playState: false, activity: false, news: false },
  big: { movies: 400, bigCharts: true }
};

function sortName(name) {
  return name.replace(/^(the|a|an) /i, '').toLowerCase();
}

/* A Jellyfin MediaSource for a video file. kind: '4k-dv' | '4k-hdr' | '1080p' */
export function mediaSource(id, name, runtimeTicks, kind = '1080p', opts = {}) {
  const uhd = kind.startsWith('4k');
  const video = {
    Index: 0, Type: 'Video', Codec: uhd ? 'hevc' : 'h264', Width: uhd ? 3840 : 1920, Height: uhd ? 2160 : 1080,
    BitRate: uhd ? 36_000_000 : 8_000_000, IsDefault: true, IsForced: false, IsExternal: false,
    VideoRange: kind === '1080p' ? 'SDR' : 'HDR', VideoRangeType: kind === '4k-dv' ? 'DOVIWithHDR10' : kind === '4k-hdr' ? 'HDR10' : 'SDR',
    DisplayTitle: (uhd ? '4K' : '1080p') + ' ' + (uhd ? 'HEVC' : 'H.264') + (kind === '1080p' ? ' SDR' : ' HDR'),
    AverageFrameRate: 23.976, RealFrameRate: 23.976, Profile: uhd ? 'Main 10' : 'High', Level: 150,
    ...(kind === '4k-dv' ? { DvProfile: 8, DvLevel: 6, DvBlSignalCompatibilityId: 1, RpuPresentFlag: 1, ElPresentFlag: 0, BlPresentFlag: 1 } : {})
  };
  const audio = [
    { Index: 1, Type: 'Audio', Codec: 'truehd', Channels: 8, ChannelLayout: '7.1', Language: 'eng', Title: 'TrueHD Atmos 7.1', DisplayTitle: 'English - TRUEHD - 7.1 - Default', IsDefault: true, IsForced: false, IsExternal: false, Profile: 'Dolby TrueHD + Dolby Atmos' },
    { Index: 2, Type: 'Audio', Codec: 'eac3', Channels: 6, ChannelLayout: '5.1', Language: 'eng', Title: 'DD+ 5.1', DisplayTitle: 'English - Dolby Digital+ - 5.1', IsDefault: false, IsForced: false, IsExternal: false },
    { Index: 3, Type: 'Audio', Codec: 'ac3', Channels: 2, ChannelLayout: 'stereo', Language: 'eng', Title: 'Commentary', DisplayTitle: 'English - Dolby Digital - Stereo (Commentary)', IsDefault: false, IsForced: false, IsExternal: false },
    { Index: 4, Type: 'Audio', Codec: 'eac3', Channels: 6, ChannelLayout: '5.1', Language: 'ger', Title: 'DD+ 5.1', DisplayTitle: 'German - Dolby Digital+ - 5.1', IsDefault: false, IsForced: false, IsExternal: false }
  ];
  if (opts.simpleAudio) audio.splice(0, audio.length, { Index: 1, Type: 'Audio', Codec: 'aac', Channels: 2, ChannelLayout: 'stereo', Language: 'eng', DisplayTitle: 'English - AAC - Stereo - Default', IsDefault: true, IsForced: false, IsExternal: false });
  const n = audio.length + 1;
  const subs = [
    { Index: n, Type: 'Subtitle', Codec: 'subrip', Language: 'eng', DisplayTitle: 'English - SUBRIP', IsDefault: false, IsForced: false, IsExternal: false, IsTextSubtitleStream: true, SupportsExternalStream: true, DeliveryMethod: 'External', DeliveryUrl: `/Videos/${id}/${id}/Subtitles/${n}/0/Stream.vtt` },
    { Index: n + 1, Type: 'Subtitle', Codec: 'PGSSUB', Language: 'ger', DisplayTitle: 'German - PGSSUB', IsDefault: false, IsForced: false, IsExternal: false, IsTextSubtitleStream: false, SupportsExternalStream: true },
    { Index: n + 2, Type: 'Subtitle', Codec: 'subrip', Language: 'eng', Title: 'Forced', DisplayTitle: 'English Forced - SUBRIP', IsDefault: false, IsForced: true, IsExternal: false, IsTextSubtitleStream: true, SupportsExternalStream: true }
  ];
  if (opts.vobsub) subs.push({ Index: n + 3, Type: 'Subtitle', Codec: 'dvd_subtitle', Language: 'fre', DisplayTitle: 'French - DVD_SUBTITLE', IsDefault: false, IsForced: false, IsExternal: false, IsTextSubtitleStream: false, SupportsExternalStream: false });
  const streams = [video, ...audio, ...subs];
  return {
    Protocol: 'File', Id: id, Path: `/media/${uhd ? 'uhd' : 'hd'}/${name.replace(/\W+/g, '.')}.mkv`, Type: 'Default',
    Container: 'mkv', Size: Math.round((runtimeTicks / TICKS) * (video.BitRate / 8)), Name: name,
    IsRemote: false, RunTimeTicks: runtimeTicks, ReadAtNativeFramerate: false, IgnoreDts: false, IgnoreIndex: false, GenPtsInput: false,
    SupportsTranscoding: true, SupportsDirectStream: true, SupportsDirectPlay: true, IsInfiniteStream: false,
    RequiresOpening: false, RequiresClosing: false, RequiresLooping: false, SupportsProbing: true,
    VideoType: 'VideoFile', MediaStreams: streams, MediaAttachments: [], Formats: [], Bitrate: video.BitRate + 1_500_000,
    DefaultAudioStreamIndex: 1, DefaultSubtitleStreamIndex: -1, HasSegments: true
  };
}

export function createWorld(opts = {}) {
  if (opts.preset) {
    if (!PRESETS[opts.preset]) throw new Error('unknown seed preset ' + opts.preset);
    opts = { ...PRESETS[opts.preset], ...opts };
  }
  const now = opts.now ?? Date.now();
  const iso = (ms) => new Date(ms).toISOString().replace(/\.\d+Z$/, '.0000000Z');
  const date = (ms) => new Date(ms).toISOString().slice(0, 10);
  const nMovies = opts.movies ?? 140;
  const r = rng('world');

  const world = {
    now,
    serverId: gid('server'),
    serverName: 'Fake Jellyfin',
    version: '12.1.0',
    users: new Map(),
    tokens: new Map(),        // token → { userId, deviceId, client }
    items: new Map(),         // id → internal item record
    userData: new Map(),      // userId:itemId → { PlaybackPositionTicks, Played, PlayCount, LastPlayedDate, IsFavorite }
    segments: new Map(),      // itemId → MediaSegmentDto[]
    // the TV's picture-mode companion service (server/index.mjs `pic` origin): per test, like everything else
    pic: { current: 'filmMaker', modes: ['filmMaker', 'cinema', 'standard', 'vivid', 'expert1'] },
    quickConnect: new Map(),  // secret → { Code, Secret, Authenticated, userId, born }
    quickConnectEnabled: true,
    sessions: [],             // every Sessions/Playing* report, in order
    playSessions: new Map(),
    // { free, bps, tail? }: throttle / hold the Jellyfin static stream (http.mjs sendFileShaped); null = full speed
    streamShape: null,
    ml: {},
    byName(type, name) {
      for (const it of world.items.values()) if (it.Type === type && it.Name === name) return it;
      return null;
    },
    list(type) {
      return [...world.items.values()].filter((it) => it.Type === type);
    }
  };

  /* ---------------- users ---------------- */
  /* admin: Jellyfin's Policy.IsAdministrator — what reel-api's guard reads for
   * the role (no quota, may delete/cancel/undo anything; design §0) */
  const addUser = (name, password, hasImage, admin) => {
    const u = { Id: gid('user', name), Name: name, password, hasImage, admin, HasPassword: !!password, LastLoginDate: iso(now - DAY) };
    world.users.set(u.Id, u);
    return u;
  };
  world.alice = addUser('alice', 'alice-pw', true, true);
  world.bob = addUser('bob', '', false, false);
  // the ownership/quota scenarios' cast (the real server's admin and one normal user)
  world.kirill = addUser('kirill', 'kirill-pw', true, true);
  world.nicole = addUser('nicole', 'nicole-pw', false, false);

  /* ---------------- people ---------------- */
  const people = [];
  for (let i = 0; i < 16; i++) {
    const name = FIRST[i] + ' ' + LAST[i % LAST.length];
    const p = { Id: gid('person', name), Name: name, SortName: name.toLowerCase(), Type: 'Person', ServerId: world.serverId, ImageTags: i % 4 === 3 ? {} : { Primary: tag('person', name) }, BackdropImageTags: [], IsFolder: false, LocationType: 'FileSystem', Overview: `${name} is a fictional actor born in the test fixtures.`, PremiereDate: iso(Date.UTC(1960 + i, i % 12, 1 + i)), ProductionYear: 1960 + i };
    world.items.set(p.Id, p);
    people.push(p);
  }
  const castFor = (seed) => {
    const rr = rng(seed);
    const pick = new Set();
    while (pick.size < 5) pick.add(Math.floor(rr() * people.length));
    return [...pick].map((i, k) => ({ Name: people[i].Name, Id: people[i].Id, Role: 'Role ' + (k + 1), Type: k === 4 ? 'Director' : 'Actor', PrimaryImageTag: people[i].ImageTags.Primary }));
  };

  const base = (Type, Name, extra = {}) => ({
    Name, OriginalTitle: Name, ServerId: world.serverId, Id: gid(Type, Name), Etag: tag('etag', Type, Name), SortName: sortName(Name),
    Type, IsFolder: Type !== 'Movie' && Type !== 'Episode', LocationType: 'FileSystem', MediaType: Type === 'Movie' || Type === 'Episode' ? 'Video' : 'Unknown',
    ImageTags: { Primary: tag('primary', Type, Name) }, BackdropImageTags: [tag('backdrop', Type, Name)], ImageBlurHashes: {},
    Studios: [], Taglines: [], Tags: [], People: [], RemoteTrailers: [], ...extra
  });

  /* ---------------- movies ---------------- */
  const kinds = ['4k-dv', '4k-hdr', '1080p'];
  for (let i = 0; i < nMovies; i++) {
    const name = title(i);
    const year = 1990 + ((i * 7) % 35);
    const rt = Math.round((80 + ((i * 13) % 80)) * 60 * TICKS);
    const g = [GENRES[i % GENRES.length], ...(i % 2 ? [GENRES[(i + 3) % GENRES.length]] : [])];
    const m = base('Movie', name, {
      ProductionYear: year, PremiereDate: iso(Date.UTC(year, i % 12, 1 + (i % 27))), DateCreated: iso(now - i * DAY - 3600_000),
      RunTimeTicks: rt, Overview: `${name} — a synthetic film (#${i + 1}) made for the end-to-end fixtures.`, Genres: g,
      CommunityRating: Math.round((5.5 + r() * 3.5) * 10) / 10, OfficialRating: ['PG', 'PG-13', 'R', 'FSK-12'][i % 4],
      ProviderIds: { Tmdb: String(500000 + i), Imdb: 'tt' + String(9000000 + i) },
      Studios: [{ Name: 'Fixture Pictures', Id: gid('studio', 'fixture') }], Taglines: ['Every frame is fake.'],
      People: castFor('movie' + i), Chapters: [
        { StartPositionTicks: 0, Name: 'Chapter 01' }, { StartPositionTicks: 10 * 60 * TICKS, Name: 'Chapter 02' }, { StartPositionTicks: 30 * 60 * TICKS, Name: 'Chapter 03' }
      ],
      RemoteTrailers: i % 5 === 0 ? [{ Url: 'https://www.youtube.com/watch?v=fxTrailr' + String(i).padStart(3, '0'), Name: 'Official Trailer' }] : [] // 11-char YouTube ids, as TMDB's are
    });
    if (i === 0) m.ProviderIds.TmdbCollection = '7001';
    m.MediaSources = [mediaSource(m.Id, name, rt, kinds[i % 3], { vobsub: i === 7 })];
    m.Trickplay = { [m.Id]: { 320: { Width: 320, Height: 180, TileWidth: 10, TileHeight: 10, ThumbnailCount: Math.ceil(rt / TICKS / 10), Interval: 10000, Bandwidth: 120000 } } };
    world.items.set(m.Id, m);
  }

  /* ---------------- series ---------------- */
  const SERIES = [
    { name: 'Northern Line', seasons: [8, 8, 6], genres: ['Drama', 'Crime'] },
    { name: 'Paper Kingdom', seasons: [6, 6], genres: ['Comedy'] },
    { name: 'Electric Orchard', seasons: [10], genres: ['Science Fiction', 'Drama'] },
    { name: 'The Hollow Signal', seasons: [6, 6, 6, 6], genres: ['Thriller'] },
    { name: 'Velvet Archive', seasons: [8, 8], genres: ['Documentary'] },
    { name: 'Restless Comet', seasons: [12], genres: ['Animation', 'Adventure'] }
  ];
  SERIES.forEach((S, si) => {
    const year = 2008 + si * 2;
    const s = base('Series', S.name, {
      ProductionYear: year, PremiereDate: iso(Date.UTC(year, 2, 3)), DateCreated: iso(now - (40 + si) * DAY), DateLastMediaAdded: iso(now - si * 2 * DAY),
      Overview: `${S.name} — a synthetic series for the fixtures.`, Genres: S.genres, CommunityRating: 7 + si * 0.3, OfficialRating: 'TV-14',
      ProviderIds: { Tvdb: String(300000 + si), Imdb: 'tt' + String(8000000 + si), Tmdb: String(60000 + si) }, Status: si % 2 ? 'Ended' : 'Continuing',
      People: castFor('series' + si), Studios: [{ Name: 'Fixture TV', Id: gid('studio', 'fixturetv') }],
      ImageTags: { Primary: tag('primary', 'Series', S.name), Thumb: tag('thumb', S.name) },
      RemoteTrailers: si === 0 ? [{ Url: 'https://www.youtube.com/watch?v=fxTrailrS00', Name: 'Official Trailer' }] : []
    });
    world.items.set(s.Id, s);
    s.childIds = [];
    S.seasons.forEach((nEp, k) => {
      const sn = k + 1;
      const season = base('Season', `Season ${sn}`, {
        Id: gid('Season', S.name, sn), SeriesId: s.Id, SeriesName: s.Name, ParentId: s.Id, IndexNumber: sn, ProductionYear: year + k,
        PremiereDate: iso(Date.UTC(year + k, 2, 3)), DateCreated: iso(now - (30 - k) * DAY), ImageTags: { Primary: tag('primary', 'Season', S.name, sn) },
        BackdropImageTags: [], ParentBackdropItemId: s.Id, ParentBackdropImageTags: s.BackdropImageTags, SeriesPrimaryImageTag: s.ImageTags.Primary
      });
      world.items.set(season.Id, season);
      s.childIds.push(season.Id);
      season.childIds = [];
      for (let e = 1; e <= nEp; e++) {
        const name = `${ADJ[(si * 7 + k * 3 + e) % ADJ.length]} ${NOUN[(si + e) % NOUN.length]}`;
        const rt = (42 + ((e * 5) % 15)) * 60 * TICKS;
        const ep = base('Episode', name, {
          Id: gid('Episode', S.name, sn, e), SeriesId: s.Id, SeriesName: s.Name, SeasonId: season.Id, SeasonName: season.Name, ParentId: season.Id,
          IndexNumber: e, ParentIndexNumber: sn, ProductionYear: year + k, PremiereDate: iso(Date.UTC(year + k, 2, 3 + e * 7)),
          DateCreated: iso(now - (30 - k) * DAY + e * 60_000), RunTimeTicks: rt, Overview: `S${sn}E${e} of ${S.name}.`,
          ImageTags: { Primary: tag('still', S.name, sn, e) }, BackdropImageTags: [], ParentBackdropItemId: s.Id, ParentBackdropImageTags: s.BackdropImageTags,
          SeriesPrimaryImageTag: s.ImageTags.Primary, ParentThumbItemId: s.Id, ParentThumbImageTag: tag('thumb', S.name),
          ProviderIds: { Tvdb: String(7000000 + si * 1000 + sn * 100 + e) }, Genres: S.genres, CommunityRating: 7.5, OfficialRating: 'TV-14',
          Chapters: [{ StartPositionTicks: 0, Name: 'Chapter 01' }, { StartPositionTicks: 5 * 60 * TICKS, Name: 'Chapter 02' }]
        });
        ep.MediaSources = [mediaSource(ep.Id, `${S.name} S${sn}E${e}`, rt, si === 0 ? '4k-hdr' : '1080p')];
        ep.Trickplay = { [ep.Id]: { 320: { Width: 320, Height: 180, TileWidth: 10, TileHeight: 10, ThumbnailCount: Math.ceil(rt / TICKS / 10), Interval: 10000, Bandwidth: 120000 } } };
        world.items.set(ep.Id, ep);
        season.childIds.push(ep.Id);
        // Intro + credits segments (Intro Skipper's output)
        world.segments.set(ep.Id, [
          { Id: gid('seg', ep.Id, 'intro'), ItemId: ep.Id, Type: 'Intro', StartTicks: 60 * TICKS, EndTicks: 150 * TICKS },
          { Id: gid('seg', ep.Id, 'outro'), ItemId: ep.Id, Type: 'Outro', StartTicks: rt - 90 * TICKS, EndTicks: rt }
        ]);
      }
    });
  });

  /* ---------------- play state (alice) ---------------- */
  if (opts.playState !== false) seedPlayState();
  function seedPlayState() {
  const ud = (user, item, v) => world.userData.set(user.Id + ':' + item.Id, { PlaybackPositionTicks: 0, PlayCount: 0, IsFavorite: false, Played: false, ...v });
  const ep = (series, s, e) => world.items.get(gid('Episode', series, s, e));
  const A = world.alice;
  const movies = world.list('Movie');
  // Continue Watching: two movies and one episode mid-way
  ud(A, movies[2], { PlaybackPositionTicks: Math.round(movies[2].RunTimeTicks * 0.4), LastPlayedDate: iso(now - 2 * 3600_000), PlayCount: 1 });
  ud(A, movies[5], { PlaybackPositionTicks: Math.round(movies[5].RunTimeTicks * 0.15), LastPlayedDate: iso(now - 26 * 3600_000), PlayCount: 1 });
  ud(A, ep('Northern Line', 1, 1), { Played: true, PlayCount: 1, LastPlayedDate: iso(now - 5 * DAY) });
  ud(A, ep('Northern Line', 1, 2), { Played: true, PlayCount: 1, LastPlayedDate: iso(now - 4 * DAY) });
  ud(A, ep('Northern Line', 1, 3), { PlaybackPositionTicks: 20 * 60 * TICKS, PlayCount: 1, LastPlayedDate: iso(now - 3600_000) });
  // Next Up: Paper Kingdom season 1 watched → S2E1; Electric Orchard E1-4 → E5
  for (let e = 1; e <= 6; e++) ud(A, ep('Paper Kingdom', 1, e), { Played: true, PlayCount: 1, LastPlayedDate: iso(now - (10 - e) * DAY) });
  for (let e = 1; e <= 4; e++) ud(A, ep('Electric Orchard', 1, e), { Played: true, PlayCount: 1, LastPlayedDate: iso(now - (20 - e) * DAY) });
  // a few watched movies
  for (const i of [10, 11, 12, 20]) ud(A, movies[i], { Played: true, PlayCount: 1, LastPlayedDate: iso(now - (30 + i) * DAY) });
  }

  /* ---------------- reel-api ---------------- */
  world.ml = createMl(world, { now, iso, date, bigCharts: !!opts.bigCharts });
  if (opts.activity === false) world.ml.activity.length = 0;
  if (opts.news === false) world.ml.news.length = 0;
  return world;
}

/* reel-api's side: lookup catalog, activity, news, charts, trending,
 * collections, metadata, probes. Remote artwork URLs point at the fake
 * reel-api's own /__fixture/img/…: the seed stores { __img: key } and the
 * server turns it into an absolute URL when it serves the answer, so the seed
 * stays port-free. */
function createMl(world, { now, iso, date, bigCharts }) {
  const img = (k) => ({ __img: k }); // resolved to a URL when served
  const catalog = new Map(); // `${type}:${id}` → lookup result + extras

  const add = (o) => {
    const e = {
      id: String(o.id), type: o.type, title: o.title, year: o.year ?? null, overview: o.overview ?? `${o.title} — a lookup fixture.`,
      poster: img('poster-' + o.type + '-' + o.id), added: !!o.added, votes: o.votes ?? 20000, original_title: null,
      imdb_id: o.imdb_id || 'tt' + String(7000000 + Number(o.id) % 1000000), rating: o.rating ?? 7.8, genres: o.genres || ['Drama'],
      runtime_min: o.runtime_min ?? (o.type === 'tv' ? 45 : 112), certification: o.certification ?? 'PG-13', status: o.status ?? (o.type === 'tv' ? 'continuing' : 'released'),
      seasons: o.seasons || (o.type === 'tv' ? [6] : null), trailer: o.trailer ?? null, collection: o.collection ?? null
    };
    catalog.set(e.type + ':' + e.id, e);
    return e;
  };

  // everything already in Jellyfin is known to the arrs, added: true
  for (const it of world.items.values()) {
    if (it.Type === 'Movie') add({ id: it.ProviderIds.Tmdb, type: 'movie', title: it.Name, year: it.ProductionYear, added: true, imdb_id: it.ProviderIds.Imdb, genres: it.Genres, collection: it.ProviderIds.TmdbCollection ? { id: it.ProviderIds.TmdbCollection, title: 'Harbor Collection' } : null });
    if (it.Type === 'Series') add({ id: it.ProviderIds.Tvdb, type: 'tv', title: it.Name, year: it.ProductionYear, added: true, imdb_id: it.ProviderIds.Imdb, genres: it.Genres, seasons: it.childIds.map((sid) => world.items.get(sid).childIds.length) });
  }
  // titles the library doesn't have
  const extraMovies = ['Glass Meridian Rising', 'Iron Tide', 'Quiet Summit', 'Wild Atlas', 'Pale Comet', 'Secret Canyon', 'Burning Mirror', 'Harbor Lights', 'Harbor Nights'];
  extraMovies.forEach((t, i) => add({ id: 900001 + i, type: 'movie', title: t, year: 2024 - i, votes: 150000 - i * 9000, rating: 8.4 - i * 0.1, trailer: i === 0 ? 'ytFixture01' : null, collection: t.startsWith('Harbor') ? { id: '7001', title: 'Harbor Collection' } : null }));
  const extraShows = ['Paper Lanterns', 'Golden Frontier', 'Hidden Station', 'Distant River', 'Last Engine'];
  extraShows.forEach((t, i) => add({ id: 400001 + i, type: 'tv', title: t, year: 2025 - i, votes: 90000 - i * 5000, seasons: [8, 8].slice(0, 1 + (i % 2)) }));
  const lk = (type, id) => catalog.get(type + ':' + id);

  const nl = world.byName('Series', 'Northern Line');
  const hs = world.byName('Series', 'The Hollow Signal');
  const glass = lk('movie', 900001);
  const lanterns = lk('tv', 400001);

  const activity = [
    { id: 'q-movie-900001', type: 'movie', title: glass.title, subtitle: String(glass.year), status: 'downloading', progress: 0.43, size_bytes: 8_400_000_000, timeleft: '01:11:24', quality: 'Bluray-2160p', download_speed: 7_400_000, message: null, media_id: glass.id, season: null, episode: null, episode_title: null, poster: glass.poster, year: glass.year, download_id: 'a'.repeat(40) },
    { id: 'q-tv-400001-1-1', type: 'tv', title: lanterns.title, subtitle: 'S01E01 · Pilot', status: 'queued', progress: 0, size_bytes: null, timeleft: null, quality: 'WEBDL-1080p', download_speed: 0, message: null, media_id: lanterns.id, season: 1, episode: 1, episode_title: 'Pilot', poster: lanterns.poster, year: lanterns.year, download_id: null },
    { id: 'q-tv-300000-3-7', type: 'tv', title: nl.Name, subtitle: 'S03E07 · New Arrival', status: 'downloading', progress: 0.71, size_bytes: 2_100_000_000, timeleft: '00:04:10', quality: 'WEBDL-2160p', download_speed: 5_200_000, message: null, media_id: nl.ProviderIds.Tvdb, season: 3, episode: 7, episode_title: 'New Arrival', poster: img('poster-tv-' + nl.ProviderIds.Tvdb), year: nl.ProductionYear, download_id: 'b'.repeat(40) }
  ];

  // Sonarr's metadata lists every episode it knows, including the ones still downloading
  for (const a of activity) {
    const e = a.type === 'tv' && a.season && lk('tv', a.media_id);
    if (e && (e.seasons[a.season - 1] || 0) < a.episode) e.seasons[a.season - 1] = a.episode;
  }

  const news = [
    { id: `${hs.ProviderIds.Tvdb}:5:aired`, kind: 'aired', media_id: hs.ProviderIds.Tvdb, title: hs.Name, year: hs.ProductionYear, poster: img('poster-tv-' + hs.ProviderIds.Tvdb), fanart: img('fanart-tv-' + hs.ProviderIds.Tvdb), season: 5, premiere: iso(now - 20 * 86_400_000), last_aired: iso(now - 2 * 86_400_000), episodes_aired: 4, episodes_total: 8, monitored: false },
    { id: `${nl.ProviderIds.Tvdb}:4:upcoming`, kind: 'upcoming', media_id: nl.ProviderIds.Tvdb, title: nl.Name, year: nl.ProductionYear, poster: img('poster-tv-' + nl.ProviderIds.Tvdb), fanart: img('fanart-tv-' + nl.ProviderIds.Tvdb), season: 4, premiere: iso(now + 40 * 86_400_000), last_aired: null, episodes_aired: 0, episodes_total: 10, monitored: true }
  ];

  // seed option bigCharts: a full Top 250 Movies (Browse's windowed grid) — the
  // catalog is topped up with movies the library doesn't have (ids 910001…)
  if (bigCharts) {
    const have = [...catalog.values()].filter((e) => e.type === 'movie').length;
    for (let i = 0; have + i < 250; i++) add({ id: 910001 + i, type: 'movie', title: 'Chart Film ' + (i + 1), year: 1950 + (i % 70), votes: 900000 - i * 1000, rating: 9.2 - i * 0.004 });
  }
  const allMovies = [...catalog.values()].filter((e) => e.type === 'movie');
  const allShows = [...catalog.values()].filter((e) => e.type === 'tv');
  /* Charts, trending and collections hold catalog *entries*; the server shapes
   * them per request, so `added` is re-derived every time (as reel-api does). */
  const charts = {
    'top-movie': { key: 'top-movie', title: 'Top 250 Movies', sections: [{ type: 'movie', title: 'Movies', entries: allMovies.slice(0, bigCharts ? 250 : 60) }] },
    'top-tv': { key: 'top-tv', title: 'Top 250 Shows', sections: [{ type: 'tv', title: 'Shows', entries: allShows }] }
  };
  for (const g of ['Drama', 'Comedy', 'Thriller']) {
    const mv = allMovies.filter((e) => e.genres.includes(g)).slice(0, 20);
    const tv = allShows.filter((e) => e.genres.includes(g)).slice(0, 20);
    charts['genre-' + g] = { key: 'genre-' + g, title: g, sections: [{ type: 'movie', title: 'Movies', entries: mv }, { type: 'tv', title: 'Shows', entries: tv }].filter((s) => s.entries.length) };
  }
  const trending = {
    movie: [lk('movie', 900001), lk('movie', 900002), lk('movie', 900003), allMovies[1], lk('movie', 900004), lk('movie', 900005)],
    tv: [lk('tv', 400001), lk('tv', 400002), allShows[0], lk('tv', 400003), lk('tv', 400004)]
  };
  const collections = {
    7001: { id: '7001', title: 'Harbor Collection', overview: 'Three films about harbors.', poster: img('poster-coll-7001'), fanart: img('fanart-coll-7001'), entries: [allMovies.find((e) => e.collection?.id === '7001' && e.added), lk('movie', 900008), lk('movie', 900009)] }
  };

  const probes = {
    ['a'.repeat(40)]: { container: 'matroska,webm', duration_s: 6720, bitrate: 36_000_000, size_bytes: 8_400_000_000, video: { index: 0, codec: 'hevc', width: 3840, height: 2160, hdr: 'DV', fps: 23.976 }, audio: [{ index: 1, codec: 'eac3', channels: 6, layout: '5.1(side)', lang: 'eng', title: 'DD+ Atmos', atmos: true, default: true }], subtitles: [{ index: 2, codec: 'subrip', lang: 'eng', title: null, forced: false, default: false }] },
    ['b'.repeat(40)]: { container: 'matroska,webm', duration_s: 2700, bitrate: 12_000_000, size_bytes: 2_100_000_000, video: { index: 0, codec: 'hevc', width: 3840, height: 2160, hdr: 'HDR10', fps: 23.976 }, audio: [{ index: 1, codec: 'eac3', channels: 6, layout: '5.1', lang: 'eng', title: null, atmos: false, default: true }], subtitles: [] }
  };

  /* Ownership (reel-api's owners.json, design §2): title key → { owner (user
   * id), at (UTC ISO, second precision) }, season requests 'tv:<id>:<n>' → the
   * same. Every seeded title is legacy (no record = the admins'). */
  const owners = new Map();
  const seasons = new Map();
  const stamp = (ms) => new Date(ms).toISOString().replace(/\.\d+Z$/, 'Z');
  const userId = (name) => {
    const u = [...world.users.values()].find((x) => x.Name === name || x.Id === name);
    if (!u) throw new Error('no user ' + name);
    return u.Id;
  };
  /* own('movie', '900002', 'nicole', { at }) — the catalog entry is in the arr
   * (added) and recorded as that user's, as if they had added it here */
  const own = (type, id, user, { at } = {}) => {
    const e = lk(type, String(id));
    if (!e) throw new Error(`own: ${type}:${id} is not in the lookup catalog`);
    e.added = true;
    owners.set(type + ':' + e.id, { owner: userId(user), at: at || stamp(Date.now()) });
    return e;
  };
  /* fill('nicole', 'movie', 10) — n more titles of that type owned by the user,
   * each a fresh catalog entry ("Owned Film 01…", tmdb 920001… / "Owned Show
   * 01…", tvdb 420001…), so the seed's un-added titles stay available to the
   * scenario; nothing grabbed, not in Jellyfin (status "waiting"). Their `at`
   * are a minute apart, oldest first. Returns the entries. */
  let filled = 0;
  const fill = (user, type, n) => {
    const out = [];
    for (let i = 0; i < n; i++) {
      const k = ++filled;
      const e = add({ id: (type === 'tv' ? 420000 : 920000) + k, type, title: (type === 'tv' ? 'Owned Show ' : 'Owned Film ') + String(k).padStart(2, '0'), year: 2020 + (k % 5), votes: 5000 });
      out.push(own(type, e.id, user, { at: stamp(Date.now() - (n - i) * 60_000) }));
    }
    return out;
  };

  return {
    catalog, lookup: lk, lookupShape, date,
    owners, seasons, own, fill,
    quota: { movie: 10, tv: 10 }, // REEL_API_QUOTA_MOVIES / _SERIES; admins have none
    deletes: [], // { type, id, user (name) } of every delete with files
    oldBackend: false, // true: a reel-api from before ownership (no /api/me, no activity flags, no checks)
    activity, news, charts, trending, collections, probes,
    segments: new Map(), // `${imdb}:${s}:${e}` → { intro, recap, outro }
    trailers: new Map(), // YouTube key → { subs?, title? }: a ready trailer job serving the fixture HLS (reelapi.mjs)
    trailerFiles: [], // { key, name } of every trailer file served, in order
    liveHls: new Map(), // download id → { probing? }: a live-HLS job for the phone (reelapi.mjs)
    liveFiles: [], // { gid, audio, name } of every live-HLS file served, in order
    cutStreams: new Set(), // download ids whose /stream ends at 0:20 (media.mjs `cut`): the download stopped there
    adds: [], undos: [], cancels: [], searches: []
  };

  function lookupShape(e) {
    return { id: e.id, type: e.type, title: e.title, year: e.year, overview: e.overview, poster: e.poster, added: e.added, votes: e.votes, original_title: e.original_title };
  }
}
