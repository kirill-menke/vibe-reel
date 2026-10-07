/* Jellyfin-shaped test data: MediaStreams, MediaSources and items, as the
 * 12.1 API returns them (BaseItemDto / MediaSourceInfo / MediaStream). Only the
 * fields src/lib reads are filled in; pass overrides for anything else.
 *
 *   const src = source([
 *     video({ Width: 3840, Height: 2160, VideoRange: 'HDR', VideoRangeType: 'DOVIWithHDR10' }),
 *     audio({ Codec: 'truehd', Profile: 'Dolby TrueHD + Dolby Atmos', IsDefault: true }),
 *     audio({ Codec: 'eac3', Profile: 'Dolby Digital Plus + Dolby Atmos' }),
 *     sub({ Codec: 'subrip', Language: 'eng', IsForced: true }),
 *   ]);
 *   const ep = episode({ SeriesId: 's1', MediaSources: [src] });
 *
 * Stream Index values are assigned in order (0, 1, 2 …) unless given, like
 * ffprobe's. Ids are deterministic per call order within a test file; use
 * resetIds() in a beforeEach if a test depends on exact ids. */
import { TICKS_PER_SECOND } from './time.js';

let n = 0;
export function resetIds() {
  n = 0;
}
const nextId = (p) => p + (++n).toString(16).padStart(8, '0');

export function video(o = {}) {
  return {
    Type: 'Video',
    Codec: 'hevc',
    Width: 1920,
    Height: 1080,
    VideoRange: 'SDR',
    VideoRangeType: 'SDR',
    BitRate: 20000000,
    IsDefault: true,
    ...o
  };
}

export function audio(o = {}) {
  const codec = o.Codec || 'eac3';
  return {
    Type: 'Audio',
    Codec: codec,
    Language: 'eng',
    Channels: 6,
    ChannelLayout: '5.1',
    IsDefault: false,
    DisplayTitle: '',
    ...o
  };
}

export function sub(o = {}) {
  return {
    Type: 'Subtitle',
    Codec: 'subrip',
    Language: 'eng',
    IsForced: false,
    IsDefault: false,
    IsExternal: false,
    IsTextSubtitleStream: !/pgs|dvd|dvb|vobsub|xsub/i.test(o.Codec || 'subrip'),
    DisplayTitle: '',
    ...o
  };
}

/* Common real-world tracks (the cases CLAUDE.md documents). */
export const tracks = {
  truehdAtmos: (o) => audio({ Codec: 'truehd', Profile: 'Dolby TrueHD + Dolby Atmos', Channels: 8, ChannelLayout: '7.1', Title: 'TrueHD Atmos 7.1', ...o }),
  eac3Atmos: (o) => audio({ Codec: 'eac3', Profile: 'Dolby Digital Plus + Dolby Atmos', Channels: 6, Title: 'DD+ Atmos 5.1', ...o }),
  eac3: (o) => audio({ Codec: 'eac3', Channels: 6, ...o }),
  ac3: (o) => audio({ Codec: 'ac3', Channels: 6, ...o }),
  dtsHdMa: (o) => audio({ Codec: 'dts', Profile: 'DTS-HD MA', Channels: 6, ...o }),
  aacStereo: (o) => audio({ Codec: 'aac', Channels: 2, ChannelLayout: 'stereo', ...o }),
  commentary: (o) => audio({ Codec: 'ac3', Channels: 2, ChannelLayout: 'stereo', Title: 'Commentary with the director', ...o }),
  pgs: (o) => sub({ Codec: 'PGSSUB', IsTextSubtitleStream: false, ...o }),
  vobsub: (o) => sub({ Codec: 'dvd_subtitle', IsTextSubtitleStream: false, ...o }),
  dvbsub: (o) => sub({ Codec: 'dvb_subtitle', IsTextSubtitleStream: false, ...o }),
  sdh: (o) => sub({ Title: 'English SDH', IsHearingImpaired: true, ...o })
};

/** A MediaSourceInfo. `streams` get Index 0..n-1 unless they carry one. */
export function source(streams = [video(), audio()], o = {}) {
  const MediaStreams = streams.map((s, i) => ({ Index: i, ...s }));
  return {
    Id: o.Id || nextId('src'),
    Protocol: 'File',
    Container: 'mkv',
    Path: '/media/test.mkv',
    Bitrate: 25000000,
    RunTimeTicks: 60 * 60 * TICKS_PER_SECOND,
    SupportsDirectPlay: true,
    SupportsDirectStream: true,
    SupportsTranscoding: true,
    MediaStreams,
    DefaultAudioStreamIndex: MediaStreams.find((s) => s.Type === 'Audio' && s.IsDefault)?.Index,
    ...o
  };
}

function base(type, o) {
  const id = o.Id || nextId(type.toLowerCase());
  return {
    Id: id,
    Name: type + ' ' + id,
    Type: type,
    RunTimeTicks: 45 * 60 * TICKS_PER_SECOND,
    UserData: { PlaybackPositionTicks: 0, Played: false, PlayCount: 0, IsFavorite: false },
    ImageTags: { Primary: 'tag-' + id },
    BackdropImageTags: [],
    ...o
  };
}

export function movie(o = {}) {
  return base('Movie', { ProductionYear: 2024, ProviderIds: {}, MediaSources: [source()], ...o });
}

export function episode(o = {}) {
  return base('Episode', {
    SeriesId: o.SeriesId || 'series-1',
    SeriesName: 'Test Series',
    SeasonId: 'season-1',
    ParentIndexNumber: 1,
    IndexNumber: 1,
    MediaSources: [source()],
    ...o
  });
}

export function series(o = {}) {
  return base('Series', { ProviderIds: {}, Genres: [], ...o });
}

/** Jellyfin MediaSegmentDto (seconds in, ticks out). */
export function segment(type, startSec, endSec, o = {}) {
  return { Id: nextId('seg'), Type: type, StartTicks: Math.round(startSec * TICKS_PER_SECOND), EndTicks: Math.round(endSec * TICKS_PER_SECOND), ...o };
}

/** ChapterInfo list from [[name, startSec], …]. */
export function chapters(list) {
  return list.map(([Name, sec]) => ({ Name, StartPositionTicks: Math.round(sec * TICKS_PER_SECOND) }));
}

/** A PlaybackInfo answer for one source. */
export function playbackInfo(src, o = {}) {
  return { MediaSources: [src], PlaySessionId: o.PlaySessionId || nextId('ps'), ...o };
}
