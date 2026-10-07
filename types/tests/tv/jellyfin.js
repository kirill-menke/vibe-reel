/* Type test: the Jf.* item shapes (types/jellyfin.d.ts) accept hand-written fixtures
 * shaped like real Jellyfin 12.1 answers, and reject what the server never sends.
 * Every title, id and tag below is invented — no real library data. */

const TICKS = 10_000_000;

/** An episode from `/Shows/NextUp` with UserData + ProviderIds (Fields=ProviderIds). */
/** @type {Jf.BaseItemDto} */
export const episode = {
  Id: '0a1b2c3d4e5f60718293a4b5c6d7e8f9',
  Name: 'The Lighthouse Keeper',
  Type: 'Episode',
  ServerId: 'f00df00df00df00df00df00df00df00d',
  SeriesId: '11112222333344445555666677778888',
  SeriesName: 'Harbour Lights',
  SeasonId: '99990000aaaabbbbccccddddeeeeffff',
  SeasonName: 'Season 2',
  IndexNumber: 3,
  IndexNumberEnd: null,
  ParentIndexNumber: 2,
  RunTimeTicks: 52 * 60 * TICKS,
  PremiereDate: '2023-04-09T00:00:00.0000000Z',
  ProductionYear: 2023,
  SeriesPrimaryImageTag: 'abc123',
  ParentBackdropItemId: '11112222333344445555666677778888',
  ParentBackdropImageTags: ['bd01'],
  ParentThumbItemId: '11112222333344445555666677778888',
  ParentThumbImageTag: 'th01',
  ImageTags: { Primary: 'still01' },
  BackdropImageTags: [],
  ImageBlurHashes: { Primary: { still01: 'LEHV6nWB2yk8pyo0adR*.7kCMdnj' } },
  ProviderIds: { Tvdb: '7654321', Imdb: 'tt0000001' },
  UserData: {
    PlaybackPositionTicks: 0,
    PlayCount: 0,
    IsFavorite: false,
    Played: false,
    LastPlayedDate: null,
    Key: '7654321002003',
    ItemId: '00000000000000000000000000000000'
  }
};

/** A movie from `/Users/{id}/Items/{id}` (ITEM_FIELDS) with MediaSources and People. */
/** @type {Jf.BaseItemDto} */
export const movie = {
  Id: 'aaaabbbbccccddddeeeeffff00001111',
  Name: 'Glass Orchard',
  Type: 'Movie',
  Overview: 'A gardener grows a forest that is not there.',
  Taglines: ['Some things grow in the dark.'],
  Genres: ['Drama', 'Fantasy'],
  Studios: [{ Name: 'Nowhere Pictures', Id: '12121212121212121212121212121212' }],
  People: [
    { Id: '34343434343434343434343434343434', Name: 'Ada Example', Role: 'Mira', Type: 'Actor', PrimaryImageTag: 'p1' },
    { Id: '56565656565656565656565656565656', Name: 'Ben Placeholder', Type: 'Director' }
  ],
  OfficialRating: 'FSK-12',
  CommunityRating: 7.4,
  ProductionYear: 2021,
  PremiereDate: '2021-10-01T00:00:00.0000000Z',
  DateCreated: '2024-02-11T19:20:31.1234567Z',
  RunTimeTicks: 118 * 60 * TICKS,
  ProviderIds: { Tmdb: '424242', Imdb: 'tt0000002', TmdbCollection: '999' },
  RemoteTrailers: [{ Url: 'https://www.youtube.com/watch?v=xxxxxxxxxxx', Name: 'Official Trailer' }],
  ImageTags: { Primary: 'poster01', Logo: 'logo01' },
  BackdropImageTags: ['bd01', 'bd02'],
  UserData: { PlaybackPositionTicks: 31 * 60 * TICKS, PlayCount: 1, IsFavorite: false, Played: false, PlayedPercentage: 26.3 },
  MediaSources: [{ Id: 'aaaabbbbccccddddeeeeffff00001111', Container: 'mkv', Bitrate: 36_000_000, MediaStreams: [] }]
};

/** A movie's `Trickplay` field (Fields=Trickplay): source id → width → sheet layout. */
/** @type {Jf.TrickplayManifest} */
export const trickplay = {
  aaaabbbbccccddddeeeeffff00001111: {
    320: { Width: 320, Height: 180, TileWidth: 10, TileHeight: 10, ThumbnailCount: 708, Interval: 10000, Bandwidth: 120000 }
  }
};

/** @type {Jf.BaseItemDto} */
export const movieWithTrickplay = { ...movie, Trickplay: trickplay, Chapters: [{ StartPositionTicks: 0, Name: 'Intro' }, { StartPositionTicks: 95 * TICKS, Name: 'Chapter 02' }] };

/** `GET /MediaSegments/{id}` — Intro Skipper's intro + credits. */
/** @type {Jf.QueryResult<Jf.MediaSegmentDto>} */
export const segments = {
  Items: [
    { Id: '1', ItemId: '0a1b2c3d4e5f60718293a4b5c6d7e8f9', Type: 'Intro', StartTicks: 62 * TICKS, EndTicks: 151 * TICKS },
    { Id: '2', ItemId: '0a1b2c3d4e5f60718293a4b5c6d7e8f9', Type: 'Outro', StartTicks: 3011 * TICKS, EndTicks: 3120 * TICKS }
  ],
  TotalRecordCount: 2,
  StartIndex: 0
};

/** `GET /Shows/NextUp` answer. */
/** @type {Jf.QueryResult} */
export const nextUp = { Items: [episode], TotalRecordCount: 1, StartIndex: 0 };

/** A Person (`/Users/{id}/Items/{personId}`): birth/death in PremiereDate/EndDate. */
/** @type {Jf.BaseItemDto} */
export const person = {
  Id: '34343434343434343434343434343434',
  Name: 'Ada Example',
  Type: 'Person',
  Overview: 'An actor who does not exist.',
  PremiereDate: '1970-01-01T00:00:00.0000000Z',
  EndDate: null,
  ProductionLocations: ['Somewhere, Nowhere'],
  ImageTags: { Primary: 'face01' }
};

/** A season from `/Shows/{id}/Seasons` (Fields=UserData,ChildCount). */
/** @type {Jf.BaseItemDto} */
export const season = { Id: 's1', Name: 'Season 1', Type: 'Season', IndexNumber: 1, ChildCount: 8, UserData: { Played: true, UnplayedItemCount: 0 } };

/** `POST /Users/AuthenticateByName`. */
/** @type {Jf.AuthenticationResult} */
export const auth = { AccessToken: 'deadbeef', ServerId: 'f00d', User: { Id: 'u1', Name: 'viewer' } };

/* ---- the shapes are real types, not any ---- */
/** @type {TypeTest.Assert<TypeTest.Not<TypeTest.IsAny<Jf.BaseItemDto['UserData']>>>} */
export const userDataNotAny = true;
/** @type {TypeTest.Assert<TypeTest.Not<TypeTest.IsAny<Jf.BaseItemDto['People']>>>} */
export const peopleNotAny = true;

/* ---- negatives: the item interfaces are closed ---- */

// @ts-expect-error misspelt field (ProductionYaer): BaseItemDto has no index signature any more.
/** @type {Jf.BaseItemDto} */ export const misspelt = { Id: 'x', ProductionYaer: 2020 };

// @ts-expect-error IndexNumber is a number on the wire, never a string.
/** @type {Jf.BaseItemDto} */ export const stringIndex = { Id: 'x', IndexNumber: '3' };

// @ts-expect-error 'Tv' is not a BaseItemKind: proves Type is a closed union.
/** @type {Jf.BaseItemDto} */ export const badKind = { Id: 'x', Type: 'Tv' };

// @ts-expect-error 'Credits' is not a MediaSegmentType (Jellyfin calls credits 'Outro').
/** @type {Jf.MediaSegmentDto} */ export const badSegment = { Id: '1', ItemId: 'x', Type: 'Credits', StartTicks: 0, EndTicks: 1 };

// @ts-expect-error a trickplay sheet layout needs ThumbnailCount (and the rest): no partial infos.
/** @type {Jf.TrickplayInfo} */ export const partialTrick = { Width: 320, Height: 180, TileWidth: 10, TileHeight: 10, Interval: 10000, Bandwidth: 1 };

// @ts-expect-error UserData.Played is a boolean, not the string the old web client stored.
/** @type {Jf.UserItemData} */ export const stringPlayed = { Played: 'true' };
