/* Jellyfin 12.1 DTOs — only the subset VibeReel reads/sends. Global namespace `Jf`,
 * usable from JSDoc without an import: `/** @param {Jf.BaseItemDto} item *\/`.
 *
 * Rules: every field optional unless the server always sends it for the request the
 * app makes (then say which request). PascalCase exactly as on the wire. Add a field
 * only when some code reads it; cite the quirk (CLAUDE.md) when shape is surprising.
 *
 * Source of truth: Jellyfin 12.1.0 OpenAPI (api.jellyfin.org, jellyfin-openapi-stable.json).
 * No interface has an index signature except ProviderIds (an open map on the wire). */

declare namespace Jf {
  /** BaseItemKind (12.1 OpenAPI enum). The app branches on Movie/Series/Season/Episode/Person. */
  type ItemKind =
    | 'AggregateFolder' | 'Audio' | 'AudioBook' | 'BasePluginFolder' | 'Book' | 'BoxSet' | 'Channel'
    | 'ChannelFolderItem' | 'CollectionFolder' | 'Episode' | 'Folder' | 'Genre' | 'ManualPlaylistsFolder'
    | 'Movie' | 'LiveTvChannel' | 'LiveTvProgram' | 'MusicAlbum' | 'MusicArtist' | 'MusicGenre'
    | 'MusicVideo' | 'Person' | 'Photo' | 'PhotoAlbum' | 'Playlist' | 'PlaylistsFolder' | 'Program'
    | 'Recording' | 'Season' | 'Series' | 'Studio' | 'Trailer' | 'TvChannel' | 'TvProgram'
    | 'UserRootFolder' | 'UserView' | 'Video' | 'Year';

  /** PersonKind (12.1). Detail screens filter Actor / Director / Writer / Creator. */
  type PersonKind =
    | 'Unknown' | 'Actor' | 'Director' | 'Composer' | 'Writer' | 'GuestStar' | 'Producer' | 'Conductor'
    | 'Lyricist' | 'Arranger' | 'Engineer' | 'Mixer' | 'Remixer' | 'Creator' | 'Artist' | 'AlbumArtist'
    | 'Author' | 'Illustrator' | 'Penciller' | 'Inker' | 'Colorist' | 'Letterer' | 'CoverArtist'
    | 'Editor' | 'Translator' | 'Narrator';

  /** ISO 8601 date-time string as Jellyfin sends it (`2024-05-01T00:00:00.0000000Z`). */
  type DateTime = string;

  /** `ProviderIds`: provider name → id. Matching against Sonarr/Radarr uses Tvdb/Tmdb
   * (activity merge, findJellyfin()); Imdb feeds IntroDB; TmdbCollection the CollectionRail.
   * On the wire this is an open string map, hence the index signature. */
  interface ProviderIds {
    Tmdb?: string;
    Tvdb?: string;
    Imdb?: string;
    /** Movie → its TMDB collection (CollectionRail). */
    TmdbCollection?: string;
    [provider: string]: string | undefined;
  }

  /** UserItemDataDto. Always present on items fetched with a UserId (Fields=UserData). */
  interface UserItemData {
    PlaybackPositionTicks?: number;
    PlayCount?: number;
    IsFavorite?: boolean;
    Played?: boolean;
    /** null after an un-watch; `POST …/UserData` cannot null it (CLAUDE.md, phone testing). */
    LastPlayedDate?: DateTime | null;
    PlayedPercentage?: number | null;
    /** Series/Season only. */
    UnplayedItemCount?: number | null;
    Rating?: number | null;
    Likes?: boolean | null;
    Key?: string;
    ItemId?: string;
  }

  /** `ImageTags`: image type → tag. `Primary` is the poster/still; `Thumb`/`Logo`/`Banner` exist too. */
  interface ImageTags {
    Primary?: string;
    Thumb?: string;
    Logo?: string;
    Banner?: string;
    Art?: string;
    Disc?: string;
    Backdrop?: string;
  }

  /** `ImageBlurHashes`: image type → (tag → blurhash). The phone paints them under posters. */
  interface ImageBlurHashes {
    Primary?: Record<string, string>;
    Backdrop?: Record<string, string>;
    Thumb?: Record<string, string>;
    Logo?: Record<string, string>;
    Art?: Record<string, string>;
    Banner?: Record<string, string>;
    Disc?: Record<string, string>;
    Box?: Record<string, string>;
    Screenshot?: Record<string, string>;
    Menu?: Record<string, string>;
    Chapter?: Record<string, string>;
    BoxRear?: Record<string, string>;
    Profile?: Record<string, string>;
  }

  /** `People[]` (Fields=People; MovieDetail/SeriesDetail cast, phone Person roles). */
  interface BaseItemPerson {
    Id: string;
    Name?: string | null;
    Role?: string | null;
    Type?: PersonKind;
    PrimaryImageTag?: string | null;
    ImageBlurHashes?: ImageBlurHashes;
  }

  /** `Studios[]`. */
  interface NameGuidPair {
    Id: string;
    Name?: string | null;
  }

  /** `RemoteTrailers[]` — TMDB's YouTube links (trailer.js picks the best "Official Trailer"). */
  interface MediaUrl {
    Url?: string | null;
    Name?: string | null;
  }

  /** `Chapters[]` (Fields=Chapters). A chapter has a start and no end (segments.js). */
  interface ChapterInfo {
    StartPositionTicks: number;
    Name?: string | null;
    ImagePath?: string | null;
    ImageDateModified?: DateTime;
    ImageTag?: string | null;
  }

  /** One trickplay resolution (TrickplayInfoDto). Sheets are TileWidth × TileHeight thumbnails
   * of Width × Height px; `Interval` is in **ms** (player.svelte.js lookUpTrickplay). */
  interface TrickplayInfo {
    Width: number;
    Height: number;
    TileWidth: number;
    TileHeight: number;
    ThumbnailCount: number;
    Interval: number;
    Bandwidth: number;
  }

  /** The item's `Trickplay` field (Fields=Trickplay): media source id → (width → info). */
  type TrickplayManifest = Record<string, Record<string, TrickplayInfo>>;

  /** MediaSegmentType (12.1). Intro Skipper writes Intro/Outro (and Recap — which the app
   * deliberately ignores, CLAUDE.md "Skip Recap"). */
  type MediaSegmentType = 'Unknown' | 'Commercial' | 'Preview' | 'Recap' | 'Outro' | 'Intro';

  /** One entry of `GET /MediaSegments/{itemId}`. Ticks are 100 ns. */
  interface MediaSegmentDto {
    Id: string;
    ItemId: string;
    Type: MediaSegmentType;
    StartTicks: number;
    EndTicks: number;
  }

  /** Subset of BaseItemDto — every field some client code reads. Grids request it with
   * GRID_FIELDS (api.js); Id/Name/Type/ImageTags/BackdropImageTags come back unasked. */
  interface BaseItemDto {
    Id: string;
    Name?: string | null;
    Type?: ItemKind;
    ServerId?: string | null;
    SortName?: string | null;
    Path?: string | null;
    IsFolder?: boolean | null;
    CollectionType?: string | null;
    LocationType?: string;

    Overview?: string | null;
    Taglines?: string[];
    Genres?: string[];
    Studios?: NameGuidPair[];
    People?: BaseItemPerson[];
    /** Person: birthplace first. */
    ProductionLocations?: string[];
    OfficialRating?: string | null;
    CommunityRating?: number | null;
    /** NOT a Jellyfin 12.1 field (removed from BaseItemDto long ago): always undefined.
     * MovieDetail still reads it — run/findings.md F02. */
    VoteCount?: undefined;
    ProductionYear?: number | null;
    /** Person: date of birth. */
    PremiereDate?: DateTime | null;
    /** Series: last aired; Person: date of death. */
    EndDate?: DateTime | null;
    DateCreated?: DateTime | null;
    /** Series: 'Continuing' | 'Ended' | … */
    Status?: string | null;
    RunTimeTicks?: number | null;

    /** Episode / Season numbering; IndexNumberEnd for double episodes (S1E1–2). */
    IndexNumber?: number | null;
    IndexNumberEnd?: number | null;
    ParentIndexNumber?: number | null;
    SeriesId?: string | null;
    SeriesName?: string | null;
    SeasonId?: string | null;
    SeasonName?: string | null;
    /** Season/Series: number of children (Fields=ChildCount). */
    ChildCount?: number | null;
    /** NOT a Jellyfin 12.1 field: always undefined (Tile's seriesSub falls back to it) — F02. */
    SeasonCount?: undefined;
    RecursiveItemCount?: number | null;

    ImageTags?: ImageTags;
    BackdropImageTags?: string[];
    ImageBlurHashes?: ImageBlurHashes;
    ParentBackdropItemId?: string | null;
    ParentBackdropImageTags?: string[];
    ParentThumbItemId?: string | null;
    ParentThumbImageTag?: string | null;
    SeriesPrimaryImageTag?: string | null;

    ProviderIds?: ProviderIds;
    UserData?: UserItemData;
    RemoteTrailers?: MediaUrl[];
    Chapters?: ChapterInfo[];
    Trickplay?: TrickplayManifest | null;
    MediaSources?: MediaSourceInfo[];
    /** Duplicate of MediaSources[0].MediaStreams (ITEM_FIELDS doesn't ask for it, api.js). */
    MediaStreams?: MediaStream[];
  }

  /** Subset of UserDto (`GET /Users/{id}`, `AuthenticationResult.User`). */
  interface UserDto {
    Id: string;
    Name?: string | null;
    ServerId?: string | null;
    PrimaryImageTag?: string | null;
    HasPassword?: boolean;
  }

  /** `POST /Users/AuthenticateByName` (Login). */
  interface AuthenticationResult {
    User?: UserDto;
    AccessToken?: string | null;
    ServerId?: string | null;
  }

  /** `POST /QuickConnect/Initiate` and `GET /QuickConnect/Connect?Secret=` (Login's code). */
  interface QuickConnectResult {
    Authenticated: boolean;
    Secret: string;
    Code: string;
    DeviceId?: string;
    DeviceName?: string;
    AppName?: string;
    AppVersion?: string;
    DateAdded?: DateTime;
  }

  /* ================= media sources & streams (T02) ================= */

  type MediaStreamType = 'Audio' | 'Video' | 'Subtitle' | 'EmbeddedImage' | 'Data' | 'Lyric';
  type VideoRange = 'Unknown' | 'SDR' | 'HDR';
  /** VideoRangeType (12.1) — plus `''`: sourceFromProbe() (pendingplay.js) emits an empty
   * string for an SDR probe of a pending download. */
  type VideoRangeType =
    | 'Unknown' | 'SDR' | 'HDR10' | 'HLG' | 'DOVI' | 'DOVIWithHDR10' | 'DOVIWithHLG' | 'DOVIWithSDR'
    | 'DOVIWithEL' | 'DOVIWithHDR10Plus' | 'DOVIWithELHDR10Plus' | 'DOVIInvalid' | 'HDR10Plus' | '';
  type SubtitleDeliveryMethod = 'Encode' | 'Embed' | 'External' | 'Hls' | 'Drop';
  type PlayMethod = 'Transcode' | 'DirectStream' | 'DirectPlay';

  /** One stream of a MediaSourceInfo. Only `Index` and `Type` are always present; a
   * synthetic source (sourceFromProbe, the trailer feeder) carries just a few fields. */
  interface MediaStream {
    Index: number;
    Type: MediaStreamType;
    Codec?: string | null;
    CodecTag?: string | null;
    /** e.g. 'Main 10', 'High', 'DTS-HD MA', 'Dolby TrueHD + Dolby Atmos' — isAtmos() sniffs it. */
    Profile?: string | null;
    Language?: string | null;
    Title?: string | null;
    DisplayTitle?: string | null;
    Comment?: string | null;
    IsDefault?: boolean;
    IsForced?: boolean;
    IsHearingImpaired?: boolean;
    IsOriginal?: boolean;
    IsExternal?: boolean;
    IsTextSubtitleStream?: boolean;
    SupportsExternalStream?: boolean;
    /** Subtitles: how PlaybackInfo decided to deliver this stream for the profile sent. */
    DeliveryMethod?: SubtitleDeliveryMethod;
    /** Subtitles: server-relative URL (`/Videos/…/Subtitles/…/Stream.vtt?…`). Wrong upstream for
     * `.mks` (CLAUDE.md VobSub note) — that URL is built by hand. */
    DeliveryUrl?: string | null;
    IsExternalUrl?: boolean | null;
    Path?: string | null;

    // audio
    Channels?: number | null;
    /** e.g. '5.1', '7.1', 'stereo'. */
    ChannelLayout?: string | null;
    SampleRate?: number | null;
    AudioSpatialFormat?: 'None' | 'DolbyAtmos' | 'DTSX';
    BitRate?: number | null;

    // video
    Width?: number | null;
    Height?: number | null;
    BitDepth?: number | null;
    Level?: number | null;
    AverageFrameRate?: number | null;
    RealFrameRate?: number | null;
    ReferenceFrameRate?: number | null;
    IsInterlaced?: boolean;
    IsAVC?: boolean | null;
    PixelFormat?: string | null;
    AspectRatio?: string | null;
    ColorRange?: string | null;
    ColorSpace?: string | null;
    ColorTransfer?: string | null;
    ColorPrimaries?: string | null;
    VideoRange?: VideoRange;
    VideoRangeType?: VideoRangeType;
    VideoDoViTitle?: string | null;
    Hdr10PlusPresentFlag?: boolean | null;
    DvVersionMajor?: number | null;
    DvVersionMinor?: number | null;
    /** Dolby Vision profile (5, 7, 8). */
    DvProfile?: number | null;
    DvLevel?: number | null;
    RpuPresentFlag?: number | null;
    ElPresentFlag?: number | null;
    BlPresentFlag?: number | null;
    /** DV base-layer compatibility (1 = HDR10, 4 = HLG, 2 = SDR, 0 = none — profile 5). */
    DvBlSignalCompatibilityId?: number | null;
  }

  /** MediaSourceInfo — `item.MediaSources[i]` and `PlaybackInfoResponse.MediaSources[i]`.
   * Also built synthetically: sourceFromProbe() (pending streams: Id 'pending'). */
  interface MediaSourceInfo {
    Id?: string | null;
    Name?: string | null;
    Path?: string | null;
    Protocol?: 'File' | 'Http' | 'Rtmp' | 'Rtsp' | 'Udp' | 'Rtp' | 'Ftp';
    Type?: 'Default' | 'Grouping' | 'Placeholder';
    /** 'mkv', 'mp4', … (Jellyfin may send a comma list such as 'mov,mp4,m4a,3gp,3g2,mj2'). */
    Container?: string | null;
    Size?: number | null;
    /** Total bitrate in bit/s — the slow-link hint compares the measured rate against it. */
    Bitrate?: number | null;
    RunTimeTicks?: number | null;
    SupportsDirectPlay?: boolean;
    SupportsDirectStream?: boolean;
    SupportsTranscoding?: boolean;
    IsRemote?: boolean;
    /** PlaybackInfo only, when the profile forces a transcode/remux (burn-in, the phone's HLS). */
    TranscodingUrl?: string | null;
    TranscodingSubProtocol?: 'http' | 'hls';
    TranscodingContainer?: string | null;
    DefaultAudioStreamIndex?: number | null;
    DefaultSubtitleStreamIndex?: number | null;
    HasSegments?: boolean;
    MediaStreams?: MediaStream[];
    Formats?: string[];
  }

  /* ================= device profile (T02) ================= */

  type DlnaProfileType = 'Audio' | 'Video' | 'Photo' | 'Subtitle' | 'Lyric';
  type ProfileConditionType = 'Equals' | 'NotEquals' | 'LessThanEqual' | 'GreaterThanEqual' | 'EqualsAny';
  type ProfileConditionValue =
    | 'AudioChannels' | 'AudioBitrate' | 'AudioProfile' | 'Width' | 'Height' | 'Has64BitOffsets'
    | 'PacketLength' | 'VideoBitDepth' | 'VideoBitrate' | 'VideoFramerate' | 'VideoLevel' | 'VideoProfile'
    | 'VideoTimestamp' | 'IsAnamorphic' | 'RefFrames' | 'NumAudioStreams' | 'NumVideoStreams'
    | 'IsSecondaryAudio' | 'VideoCodecTag' | 'IsAvc' | 'IsInterlaced' | 'AudioSampleRate'
    | 'AudioBitDepth' | 'VideoRangeType' | 'NumStreams' | 'VideoRotation';

  interface ProfileCondition {
    Condition: ProfileConditionType;
    Property: ProfileConditionValue;
    /** Always a string on the wire, lists '|'-separated ('main|main 10'). */
    Value?: string | null;
    IsRequired?: boolean;
  }

  interface DirectPlayProfile {
    Type: DlnaProfileType;
    /** Comma list. The TV's `{ Type: 'Audio' }` entry omits it (= any container). */
    Container?: string;
    VideoCodec?: string | null;
    AudioCodec?: string | null;
  }

  interface TranscodingProfile {
    Type: DlnaProfileType;
    Container: string;
    Protocol?: 'http' | 'hls';
    Context?: 'Streaming' | 'Static';
    VideoCodec?: string;
    AudioCodec?: string;
    /** A string in the 12.1 schema ('8'). */
    MaxAudioChannels?: string | null;
    /** int32 in the schema; the TV sends the string '1' (Jellyfin's JSON reads numbers from
     * strings), the phone the number 2 — both reach the server as a number. */
    MinSegments?: number | string;
    SegmentLength?: number;
    BreakOnNonKeyFrames?: boolean | null;
    CopyTimestamps?: boolean;
    EnableSubtitlesInManifest?: boolean;
    EstimateContentLength?: boolean;
    EnableMpegtsM2TsMode?: boolean;
    EnableAudioVbrEncoding?: boolean;
    Conditions?: ProfileCondition[];
  }

  interface ContainerProfile {
    Type: DlnaProfileType;
    Container?: string | null;
    SubContainer?: string | null;
    Conditions?: ProfileCondition[];
  }

  interface CodecProfile {
    Type: 'Video' | 'VideoAudio' | 'Audio';
    Codec?: string | null;
    Container?: string | null;
    SubContainer?: string | null;
    Conditions?: ProfileCondition[];
    ApplyConditions?: ProfileCondition[];
  }

  interface SubtitleProfile {
    /** 'srt', 'subrip', 'ass', 'ssa', 'vtt', 'pgssub', 'pgs', 'mov_text'. VobSub/DVB are
     * deliberately absent so Jellyfin burns them in (the no-transcode contract). */
    Format?: string | null;
    Method: SubtitleDeliveryMethod;
    Container?: string | null;
    Language?: string | null;
    DidlMode?: string | null;
  }

  /** NOT part of DeviceProfile in 12.1 (the server ignores it); phoneProfile() still sends one
   * — run/findings.md F03. */
  interface ResponseProfile {
    Type: DlnaProfileType;
    Container?: string;
    MimeType?: string;
  }

  /** DeviceProfile as deviceProfile(burn) / phoneProfile() build it. The TV's
   * `TranscodingProfiles` is `[]` unless `burn` — the no-transcode contract is a VALUE
   * (an empty array), not something a type can carry. */
  interface DeviceProfile {
    Name?: string | null;
    Id?: string | null;
    MaxStreamingBitrate?: number | null;
    MaxStaticBitrate?: number | null;
    MusicStreamingTranscodingBitrate?: number | null;
    MaxStaticMusicBitrate?: number | null;
    DirectPlayProfiles: DirectPlayProfile[];
    TranscodingProfiles: TranscodingProfile[];
    ContainerProfiles?: ContainerProfile[];
    CodecProfiles?: CodecProfile[];
    SubtitleProfiles: SubtitleProfile[];
    /** See ResponseProfile — ignored by 12.1. */
    ResponseProfiles?: ResponseProfile[];
  }

  /* ================= playback (T02) ================= */

  /** `POST /Items/{id}/PlaybackInfo` body (PlaybackInfoDto). UserId rides in the body. */
  interface PlaybackInfoDto {
    UserId?: string | null;
    DeviceProfile?: DeviceProfile;
    MaxStreamingBitrate?: number | null;
    StartTimeTicks?: number | null;
    /** Only honoured together with MediaSourceId (measured on 12.1). */
    AudioStreamIndex?: number | null;
    /** -1 = none (the phone: subs never ride in the HLS); a VobSub/DVB index = burn in. */
    SubtitleStreamIndex?: number | null;
    MaxAudioChannels?: number | null;
    MediaSourceId?: string | null;
    LiveStreamId?: string | null;
    EnableDirectPlay?: boolean | null;
    EnableDirectStream?: boolean | null;
    EnableTranscoding?: boolean | null;
    AllowVideoStreamCopy?: boolean | null;
    AllowAudioStreamCopy?: boolean | null;
    AutoOpenLiveStream?: boolean | null;
    AlwaysBurnInSubtitleWhenTranscoding?: boolean | null;
  }

  /** `POST /Items/{id}/PlaybackInfo` answer. */
  interface PlaybackInfoResponse {
    MediaSources: MediaSourceInfo[];
    PlaySessionId?: string | null;
    ErrorCode?: 'NotAllowed' | 'NoCompatibleStream' | 'RateLimitExceeded' | null;
  }

  /** `POST /Sessions/Playing` and `/Sessions/Playing/Progress` body (PlaybackStartInfo /
   * PlaybackProgressInfo share their fields) — player.svelte.js baseReport(). */
  interface PlaybackProgressInfo {
    ItemId: string;
    MediaSourceId?: string | null;
    PlaySessionId?: string | null;
    SessionId?: string | null;
    PositionTicks?: number | null;
    PlaybackStartTimeTicks?: number | null;
    IsPaused?: boolean;
    IsMuted?: boolean;
    CanSeek?: boolean;
    VolumeLevel?: number | null;
    AudioStreamIndex?: number | null;
    SubtitleStreamIndex?: number | null;
    PlayMethod?: PlayMethod;
    LiveStreamId?: string | null;
    PlaylistItemId?: string | null;
  }

  /** `POST /Sessions/Playing/Stopped` body (PlaybackStopInfo) — postStopped(). Goes out
   * with `keepalive` and is retried on a network error / 5xx. */
  interface PlaybackStopInfo {
    ItemId: string;
    MediaSourceId?: string | null;
    PlaySessionId?: string | null;
    SessionId?: string | null;
    PositionTicks?: number | null;
    LiveStreamId?: string | null;
    Failed?: boolean;
    NextMediaType?: string | null;
    PlaylistItemId?: string | null;
  }

  /** `GET /Items`, `/Users/{id}/Items`, `/Shows/NextUp`, `/Shows/{id}/Episodes`,
   * `/MediaSegments/{id}` (`QueryResult<MediaSegmentDto>`), … */
  interface QueryResult<T = BaseItemDto> {
    Items: T[];
    TotalRecordCount: number;
    StartIndex: number;
  }
}
