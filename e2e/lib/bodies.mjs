/* The JSON bodies the apps POST to Jellyfin, copied shape-for-shape from the
 * product code (it can't be imported into Node: tracks.js pulls in runes
 * state). Used by the oracle self-test to prove the body validator accepts
 * exactly what the apps send. The player scenarios send the real thing through
 * the same validator, so a drift between these copies and the source shows up
 * there as well.
 *
 *   tvProfile(burn)            src/lib/tracks.js deviceProfile() (TV branch)
 *   phoneProfile({cap, av1})   src/lib/tracks.js phoneProfile()
 *   tvPlaybackInfo / phonePlaybackInfo / offlinePlaybackInfo
 *                              src/lib/player.svelte.js play(), phone/src/lib/offline.svelte.js resolve()
 *   baseReport()               src/lib/player.svelte.js baseReport()
 *   offlineUserData()          phone/src/lib/offline.svelte.js sync */

export function tvProfile(burn = false) {
  const p = {
    MaxStreamingBitrate: 400000000,
    MaxStaticBitrate: 400000000,
    DirectPlayProfiles: [
      { Type: 'Video', Container: 'mkv,mp4,m4v,mov,ts,webm,avi', VideoCodec: 'h264,hevc,av1,vp9,mpeg2video,vc1', AudioCodec: 'aac,ac3,eac3,dts,truehd,mp3,flac,opus,pcm,mp2' },
      { Type: 'Audio' }
    ],
    TranscodingProfiles: [],
    ContainerProfiles: [],
    CodecProfiles: [],
    SubtitleProfiles: ['srt', 'subrip', 'ass', 'ssa', 'vtt', 'pgssub', 'pgs'].map((Format) => ({ Format, Method: 'External' }))
  };
  if (burn) {
    p.TranscodingProfiles = [
      { Type: 'Video', Container: 'ts', Protocol: 'hls', VideoCodec: 'h264', AudioCodec: 'aac,ac3,eac3', Context: 'Streaming', MaxAudioChannels: '8', MinSegments: '1', BreakOnNonKeyFrames: true }
    ];
  }
  return p;
}

const cond = (Condition, Property, Value, IsRequired = false) => ({ Condition, Property, Value, IsRequired });

export function phoneProfile({ cap = 0, av1 = false, dv5 = false } = {}) {
  const box = { 8000000: [1920, 1080], 4000000: [1280, 720] }[cap] || null;
  const br = cap || 200000000;
  let ranges = 'SDR|HDR10|HDR10Plus|HLG|DOVIWithHDR10|DOVIWithHLG|DOVIWithSDR|DOVIWithHDR10Plus';
  if (dv5) ranges += '|DOVI';
  const vcodecs = (av1 ? 'av1,' : '') + 'hevc,h264';
  const acodecs = 'eac3,ac3,aac,flac,alac' + (av1 ? ',opus' : '');
  const stereo = !!box && br <= 4000000;
  const codecProfiles = [
    { Type: 'Video', Codec: 'h264', Conditions: [cond('EqualsAny', 'VideoProfile', 'high|main|baseline|constrained baseline'), cond('EqualsAny', 'VideoRangeType', 'SDR'), cond('LessThanEqual', 'VideoLevel', '52'), cond('NotEquals', 'IsInterlaced', 'true')] },
    {
      Type: 'Video',
      Codec: 'hevc',
      Conditions: [
        cond('EqualsAny', 'VideoProfile', 'main|main 10'),
        cond('EqualsAny', 'VideoRangeType', ranges),
        cond('LessThanEqual', 'VideoLevel', '186'),
        cond('NotEquals', 'IsInterlaced', 'true'),
        cond('LessThanEqual', 'VideoFramerate', '60', true)
      ]
    },
    { Type: 'Video', Codec: 'hevc', Container: 'mp4,m4v,mov', Conditions: [cond('EqualsAny', 'VideoCodecTag', 'hvc1|dvh1', true)] }
  ];
  if (av1) codecProfiles.push({ Type: 'Video', Codec: 'av1', Conditions: [cond('EqualsAny', 'VideoRangeType', ranges)] });
  return {
    Name: 'VibeReel Phone (iOS Safari)',
    MaxStreamingBitrate: br,
    MaxStaticBitrate: br,
    MusicStreamingTranscodingBitrate: 384000,
    DirectPlayProfiles: [
      { Type: 'Video', Container: 'mp4,m4v,mov', VideoCodec: 'h264,hevc', AudioCodec: 'aac,ac3,eac3,flac,alac,mp3' },
      { Type: 'Video', Container: 'hls', VideoCodec: vcodecs, AudioCodec: acodecs }
    ],
    TranscodingProfiles: [
      {
        Type: 'Video',
        Container: 'mp4',
        Protocol: 'hls',
        Context: 'Streaming',
        VideoCodec: box ? 'h264,' + (av1 ? 'av1,' : '') + 'hevc' : vcodecs,
        AudioCodec: stereo ? 'aac' : acodecs,
        MaxAudioChannels: stereo ? '2' : '8',
        MinSegments: 2,
        BreakOnNonKeyFrames: true,
        ...(box ? { Conditions: [cond('LessThanEqual', 'Width', String(box[0])), cond('LessThanEqual', 'Height', String(box[1]))] } : {})
      },
      { Type: 'Video', Container: 'mp4', Protocol: 'http', Context: 'Static', VideoCodec: 'h264', AudioCodec: 'aac' }
    ],
    ContainerProfiles: [],
    CodecProfiles: codecProfiles,
    SubtitleProfiles: ['vtt', 'srt', 'subrip', 'mov_text', 'pgssub', 'pgs'].map((Format) => ({ Format, Method: 'External' })),
    ResponseProfiles: [{ Type: 'Video', Container: 'm4v', MimeType: 'video/mp4' }]
  };
}

const TICKS = 10000000;

export function tvPlaybackInfo(userId, { burn = false, sourceId, subIndex = 3, audioIndex = 1, resumeSec = 0 } = {}) {
  const body = { UserId: userId, DeviceProfile: tvProfile(burn), AutoOpenLiveStream: true, MaxStreamingBitrate: 400000000 };
  if (burn) {
    body.MediaSourceId = sourceId;
    body.SubtitleStreamIndex = subIndex;
    if (audioIndex >= 0) body.AudioStreamIndex = audioIndex;
  } else body.StartTimeTicks = Math.floor(resumeSec * TICKS);
  return body;
}

export function phonePlaybackInfo(userId, { sourceId, cap = 0, av1 = false, audioIndex = 1, resumeSec = 0 } = {}) {
  return {
    UserId: userId,
    DeviceProfile: phoneProfile({ cap, av1 }),
    AutoOpenLiveStream: true,
    MaxStreamingBitrate: cap || 200000000,
    MediaSourceId: sourceId,
    AudioStreamIndex: audioIndex,
    SubtitleStreamIndex: -1,
    StartTimeTicks: Math.floor(resumeSec * TICKS)
  };
}

export function offlinePlaybackInfo(userId, { sourceId, bitrate = 200000000, audioIndex = 1 } = {}) {
  const prof = phoneProfile({ cap: bitrate === 200000000 ? 0 : bitrate });
  prof.DirectPlayProfiles = [];
  return { UserId: userId, DeviceProfile: prof, MaxStreamingBitrate: bitrate, AutoOpenLiveStream: true, EnableDirectPlay: false, MediaSourceId: sourceId, SubtitleStreamIndex: -1, StartTimeTicks: 0, AudioStreamIndex: audioIndex };
}

export function baseReport(itemId, { sourceId = itemId, session = 'ps' + itemId.slice(0, 8), pos = 61.5, paused = false, method = 'DirectPlay', audio = 1, sub = -1 } = {}) {
  return {
    ItemId: itemId,
    MediaSourceId: sourceId,
    PlaySessionId: session,
    PositionTicks: Math.floor(pos * TICKS),
    IsPaused: paused,
    PlayMethod: method,
    CanSeek: true,
    VolumeLevel: 100,
    AudioStreamIndex: audio,
    SubtitleStreamIndex: sub
  };
}

export function offlineUserData({ pos = 1234.5, played = false, at = Date.UTC(2026, 8, 30, 20, 0) } = {}) {
  return { PlaybackPositionTicks: Math.floor(pos * TICKS), Played: played, LastPlayedDate: new Date(at).toISOString() };
}
