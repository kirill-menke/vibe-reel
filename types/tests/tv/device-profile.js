/* Type test: the device profile and media-source shapes (types/jellyfin.d.ts, T02).
 *
 * The no-transcode contract (CLAUDE.md: "empty TranscodingProfiles so Jellyfin has no
 * choice but DirectPlay"; one HLS profile only when burning in VobSub/DVB) lives in the
 * VALUE deviceProfile(false) returns — `[]` — which a type cannot express. What the
 * types do pin down: deviceProfile() returns a Jf.DeviceProfile (not any), its
 * TranscodingProfiles is an array of TranscodingProfile, and the profile pieces are
 * closed shapes, so a misspelt key in tracks.js is a type error rather than a field the
 * server silently ignores. */
import { deviceProfile } from '../../../src/lib/tracks.js';

const TICKS = 10_000_000;

/** @typedef {ReturnType<typeof deviceProfile>} Profile */

/** @type {TypeTest.Assert<TypeTest.Not<TypeTest.IsAny<Profile>>>} */
export const profileNotAny = true;

/** @type {TypeTest.Assert<Profile extends Jf.DeviceProfile ? true : false>} */
export const profileIsDeviceProfile = true;

/** @type {TypeTest.Assert<Profile['TranscodingProfiles'] extends Jf.TranscodingProfile[] ? true : false>} */
export const transcodingIsArray = true;

/** @type {Jf.TranscodingProfile[]} */
export const tvTranscoding = deviceProfile(false).TranscodingProfiles;

/** A remux with the three audio/subtitle cases the TV's score()/libpgs paths care about:
 * a container-default TrueHD Atmos, an E-AC3 (DD+) Atmos that should win, and a PGS sub. */
/** @type {Jf.MediaSourceInfo} */
export const remux = {
  Id: 'ccccddddeeeeffff0000111122223333',
  Protocol: 'File',
  Type: 'Default',
  Container: 'mkv',
  Size: 61_000_000_000,
  Bitrate: 68_000_000,
  RunTimeTicks: 131 * 60 * TICKS,
  SupportsDirectPlay: true,
  SupportsDirectStream: true,
  SupportsTranscoding: true,
  DefaultAudioStreamIndex: 1,
  MediaStreams: [
    {
      Index: 0, Type: 'Video', Codec: 'hevc', Profile: 'Main 10', Width: 3840, Height: 2160, BitDepth: 10,
      VideoRange: 'HDR', VideoRangeType: 'DOVIWithHDR10', DvProfile: 7, DvBlSignalCompatibilityId: 6,
      RealFrameRate: 23.976, AverageFrameRate: 23.976, IsInterlaced: false, IsDefault: true
    },
    {
      Index: 1, Type: 'Audio', Codec: 'truehd', Profile: 'Dolby TrueHD + Dolby Atmos', Language: 'eng',
      Channels: 8, ChannelLayout: '7.1', DisplayTitle: 'English - Dolby TrueHD + Dolby Atmos - 7.1 - Default',
      IsDefault: true, IsForced: false, AudioSpatialFormat: 'DolbyAtmos'
    },
    {
      Index: 2, Type: 'Audio', Codec: 'eac3', Profile: 'Dolby Digital Plus + Dolby Atmos', Language: 'eng',
      Channels: 6, ChannelLayout: '5.1', Title: 'DD+ Atmos', IsDefault: false
    },
    {
      Index: 3, Type: 'Subtitle', Codec: 'PGSSUB', Language: 'eng', IsForced: false, IsExternal: false,
      IsTextSubtitleStream: false, DeliveryMethod: 'External',
      DeliveryUrl: '/Videos/ccccddddeeeeffff0000111122223333/ccccddddeeeeffff0000111122223333/Subtitles/3/0/Stream.sup'
    }
  ]
};

/** PlaybackInfo answer for the burn-in case (TranscodingUrl present). */
/** @type {Jf.PlaybackInfoResponse} */
export const playbackInfo = {
  MediaSources: [{ ...remux, TranscodingUrl: '/videos/x/master.m3u8?PlaySessionId=y', TranscodingSubProtocol: 'hls', TranscodingContainer: 'ts' }],
  PlaySessionId: '0123456789abcdef0123456789abcdef'
};

/** @type {Jf.PlaybackInfoDto} */
export const playbackInfoBody = {
  UserId: 'u1', DeviceProfile: deviceProfile(true), MediaSourceId: remux.Id, AudioStreamIndex: 2, SubtitleStreamIndex: 3, StartTimeTicks: 0
};

/** Sessions/Playing/Progress — what baseReport() sends. */
/** @type {Jf.PlaybackProgressInfo} */
export const progress = {
  ItemId: 'x', MediaSourceId: remux.Id, PlaySessionId: playbackInfo.PlaySessionId, PositionTicks: 600 * TICKS,
  IsPaused: false, PlayMethod: 'DirectPlay', CanSeek: true, VolumeLevel: 100, AudioStreamIndex: 2, SubtitleStreamIndex: -1
};

/** @type {Jf.PlaybackStopInfo} */
export const stopped = { ItemId: 'x', MediaSourceId: remux.Id, PlaySessionId: playbackInfo.PlaySessionId, PositionTicks: 600 * TICKS };

/* ---- negatives ---- */

// @ts-expect-error 'Burn' is not a SubtitleDeliveryMethod: proves SubtitleProfile.Method is closed.
/** @type {Jf.SubtitleProfile} */ export const badMethod = { Format: 'dvdsub', Method: 'Burn' };

// @ts-expect-error a misspelt key (VideoCodecs) in a DirectPlay profile must not pass silently.
/** @type {Jf.DirectPlayProfile} */ export const badDirect = { Type: 'Video', Container: 'mkv', VideoCodecs: 'hevc' };

// @ts-expect-error 'Matroska' is not a MediaStreamType (Type is required and closed).
/** @type {Jf.MediaStream} */ export const badStream = { Index: 0, Type: 'Matroska' };

// @ts-expect-error a DeviceProfile without TranscodingProfiles is rejected: the field is the contract.
/** @type {Jf.DeviceProfile} */ export const noTranscoding = { DirectPlayProfiles: [], SubtitleProfiles: [] };

// @ts-expect-error ProfileCondition.Property is a closed enum ('VideoHeight' is not one).
/** @type {Jf.ProfileCondition} */ export const badCond = { Condition: 'LessThanEqual', Property: 'VideoHeight', Value: '1080' };
