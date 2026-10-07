/* pendingplay.js: watch while downloading — canStream(), sourceFromProbe(),
 * canWatchPending and the playPending() start.
 *
 * CLAUDE.md (Download activity → Watch while downloading): "`GET …/{id}/probe`
 * ffprobes the partial file once its header is on disk (409 `not_ready` before
 * that) and returns the real track layout. The client turns that probe into a
 * synthetic Jellyfin-shaped MediaSource (`sourceFromProbe`) so `describeTracks`,
 * the audio menu and the OSD tech summary work unchanged" and "in-container subs
 * are unavailable until import — the menu honestly offers None". "The probe also
 * supplies PendingDetail's real file badges (4K · DV · DD+ Atmos)". iPhone:
 * "`canWatchPending = !__PHONE__ || feedSupported()`"; the phone plays through
 * playFeedStream + livefeed.js, the TV through playPendingStream + the Range URL.
 *
 * player.svelte.js is replaced by a stub (vi.doMock) — the start is what is
 * tested here, not the engine (player.* tests cover that). */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'node:path';
import { freshImport, TEST_MEDIALIB, TEST_TOKEN } from '../helpers/modules.js';
import { mockFetch } from '../helpers/fetch.js';
import { installMSE } from '../helpers/mse.js';
import { flushPromises } from '../helpers/time.js';

const PHONE = __PHONE__;
const ROOT = path.resolve(import.meta.dirname, '../..');
const PLAYER = path.resolve(ROOT, 'src/lib/player.svelte.js');
const DL = 'abcdef0123456789abcdef0123456789abcdef01';   // an info-hash

let stub, m, net;

/* a fresh graph with the player stubbed; `mse`: install a fake MediaSource first */
async function load({ mse = true, video = null } = {}) {
  if (mse) installMSE({ managed: 'only' });
  stub = {
    playPendingStream: vi.fn(),
    playFeedStream: vi.fn(),
    videoEl: vi.fn(() => video)
  };
  vi.doMock(PLAYER, () => stub);
  m = await freshImport({
    modules: {
      pp: 'src/lib/pendingplay.js',
      toast: 'src/lib/toast.svelte.js',
      nav: 'src/lib/nav.svelte.js',
      tracks: 'src/lib/tracks.js'
    }
  });
  net = mockFetch();
  return m;
}

afterEach(() => {
  vi.doUnmock(PLAYER);
});

/* reel-api's _shape_probe (backend streaming.py) for a 4K DV remux with DD+ Atmos */
const PROBE = {
  container: 'matroska',
  duration_s: 3125.5,
  bitrate: 36000000,
  size_bytes: 1,
  video: { index: 0, codec: 'hevc', width: 3840, height: 2160, hdr: 'DV', fps: 23.976 },
  audio: [
    { index: 1, codec: 'truehd', channels: 8, layout: '7.1', lang: 'eng', title: 'TrueHD Atmos 7.1', atmos: true, default: true },
    { index: 2, codec: 'eac3', channels: 6, layout: '5.1(side)', lang: 'eng', title: 'DD+ Atmos', atmos: true, default: false },
    { index: 3, codec: 'ac3', channels: 2, layout: 'stereo', lang: 'eng', title: 'Commentary', atmos: false, default: false }
  ],
  subtitles: [{ index: 4, codec: 'hdmv_pgs_subtitle', lang: 'eng', title: null, forced: false, default: false }]
};

describe('canStream', () => {
  beforeEach(() => load());

  it('needs a download_id (an older backend has none)', () => {
    expect(m.pp.canStream({ status: 'downloading', progress: 50 })).toBe(false);
    expect(m.pp.canStream(null)).toBe(false);
    expect(m.pp.canStream(undefined)).toBe(false);
  });

  it('downloading and importing stream', () => {
    expect(m.pp.canStream({ download_id: DL, status: 'downloading', progress: 0 })).toBe(true);
    expect(m.pp.canStream({ download_id: DL, status: 'importing' })).toBe(true);
  });

  it('queued or paused only once it has any progress (Play un-parks it)', () => {
    expect(m.pp.canStream({ download_id: DL, status: 'queued', progress: 0 })).toBe(false);
    expect(m.pp.canStream({ download_id: DL, status: 'queued' })).toBe(false);
    expect(m.pp.canStream({ download_id: DL, status: 'queued', progress: 0.1 })).toBe(true);
    expect(m.pp.canStream({ download_id: DL, status: 'paused', progress: 12 })).toBe(true);
    expect(m.pp.canStream({ download_id: DL, status: 'paused', progress: 0 })).toBe(false);
  });

  it('anything else does not', () => {
    for (const status of ['completed', 'failed', 'warning', 'delay', '']) {
      expect(m.pp.canStream({ download_id: DL, status, progress: 80 })).toBe(false);
    }
  });
});

describe('sourceFromProbe', () => {
  beforeEach(() => load());

  it('a Jellyfin-shaped MediaSource: container, runtime ticks, bitrate, video + audio streams, no subtitles', () => {
    const s = m.pp.sourceFromProbe(PROBE);
    expect(s).toMatchObject({ Id: 'pending', Container: 'mkv', RunTimeTicks: 31255000000, Bitrate: 36000000 });
    expect(s.MediaStreams.map((x) => x.Type)).toEqual(['Video', 'Audio', 'Audio', 'Audio']);
    expect(s.MediaStreams[0]).toEqual({ Type: 'Video', Index: 0, Codec: 'hevc', Width: 3840, Height: 2160, VideoRangeType: 'DOVI' });
    expect(s.MediaStreams[2]).toEqual({
      Type: 'Audio',
      Index: 2,
      Codec: 'eac3',
      Channels: 6,
      ChannelLayout: '5.1(side)',
      Language: 'eng',
      Title: 'DD+ Atmos',
      Profile: 'Atmos',
      IsDefault: false
    });
  });

  it('describeTracks reads it: DD+ Atmos beats the default TrueHD, the menu offers only None for subs', () => {
    const d = m.tracks.describeTracks(m.pp.sourceFromProbe(PROBE), { Type: 'Movie', Genres: [] });
    expect(d.defaultAudio).toBe(2);
    expect(d.audio.map((a) => a.index)).toEqual([2, 1, 3]);
    expect(d.audio[0]).toMatchObject({ codec: 'eac3', atmos: true, lang: 'eng' });
    expect(d.subs).toEqual([{ label: 'None', index: -1, lang: '' }]);
    expect(d.defaultSub).toBe(-1);
  });

  it("the server's Atmos verdict is carried in Profile (a track titled without 'Atmos')", () => {
    const s = m.pp.sourceFromProbe({ audio: [{ index: 1, codec: 'eac3', atmos: true, title: 'English' }] });
    expect(m.tracks.isAtmos(s.MediaStreams[0])).toBe(true);
    const n = m.pp.sourceFromProbe({ audio: [{ index: 1, codec: 'eac3', atmos: false, title: 'English' }] });
    expect(m.tracks.isAtmos(n.MediaStreams[0])).toBe(false);
  });

  it('gives the real file badges: 4K · Dolby Vision · DD+ Atmos', () => {
    const item = { Type: 'Movie', MediaSources: [m.pp.sourceFromProbe(PROBE)] };
    expect(m.tracks.heroBadges(item)).toEqual(['4K', 'Dolby Vision', 'DD+ Atmos']);
    expect(m.tracks.tileTechBadge(item)).toBe('4K · DV');
  });

  it('HDR10 / HLG pass through, no HDR is an empty range', () => {
    const v = (hdr) => m.pp.sourceFromProbe({ video: { codec: 'hevc', width: 1920, height: 1080, hdr } }).MediaStreams[0];
    expect(v('HDR10').VideoRangeType).toBe('HDR10');
    expect(v('HLG').VideoRangeType).toBe('HLG');
    expect(v(null).VideoRangeType).toBe('');
    expect(m.tracks.hdrLabel(v('HDR10'))).toBe('HDR10');
    expect(v(null).Index).toBe(0);   // a video without an index is stream 0
  });

  it('other containers keep their name; a missing probe is an empty mkv source', () => {
    expect(m.pp.sourceFromProbe({ container: 'mov' }).Container).toBe('mov');
    expect(m.pp.sourceFromProbe({ container: null }).Container).toBe('mkv');
    expect(m.pp.sourceFromProbe(null)).toEqual({ Id: 'pending', Container: 'mkv', RunTimeTicks: 0, Bitrate: 0, MediaStreams: [] });
  });
});

describe('canWatchPending', () => {
  it(PHONE ? 'phone: true only where MSE / ManagedMediaSource exists' : 'TV: always true (it plays the growing file directly)', async () => {
    vi.stubGlobal('MediaSource', undefined);
    vi.stubGlobal('ManagedMediaSource', undefined);
    await load({ mse: false });
    expect(m.pp.canWatchPending).toBe(!PHONE);
    await load({ mse: true });
    expect(m.pp.canWatchPending).toBe(true);
  });

  if (PHONE) {
    it('phone without MSE: Play only explains, nothing is requested', async () => {
      vi.stubGlobal('MediaSource', undefined);
      vi.stubGlobal('ManagedMediaSource', undefined);
      await load({ mse: false });
      await m.pp.playPending({ download_id: DL, status: 'downloading', type: 'movie', title: 'Dune' });
      expect(m.toast.toastState.msg).toBe('Watching while downloading needs iOS 17.1 or later');
      expect(net.calls).toEqual([]);
      expect(stub.playFeedStream).not.toHaveBeenCalled();
    });
  }
});

describe('playPending', () => {
  const probeUrl = TEST_MEDIALIB + '/api/downloads/' + DL + '/probe';
  const movie = { download_id: DL, status: 'downloading', type: 'movie', title: 'dune.part.two.2024' };
  const group = { type: 'movie', mediaId: 'tmdb-693134', title: 'Dune: Part Two' };
  let video;

  beforeEach(async () => {
    video = document.createElement('video');
    vi.spyOn(video, 'load');
    await load({ video });
    m.nav.S.screen = 'pending';
  });

  const started = () => (PHONE ? stub.playFeedStream : stub.playPendingStream);

  it('plays the probed source with the title, genres and runtime', async () => {
    net.on('GET', probeUrl, PROBE);
    net.on('GET', TEST_MEDIALIB + '/api/metadata/movie/tmdb-693134', { genres: ['Science Fiction'] });
    await m.pp.playPending(movie, group);
    expect(started()).toHaveBeenCalledTimes(1);
    const arg = started().mock.calls[0][0];
    expect(arg.item).toEqual({ Type: 'Movie', Name: 'Dune: Part Two', Genres: ['Science Fiction'], RunTimeTicks: 31255000000 });
    expect(arg.source).toEqual(m.pp.sourceFromProbe(PROBE));
    expect(arg.downloadId).toBe(DL);
    if (PHONE) {
      expect(typeof arg.open).toBe('function');   // liveOpener(download_id)
      expect(arg.url).toBeUndefined();
      expect(stub.playPendingStream).not.toHaveBeenCalled();
    } else {
      expect(arg.url).toBe(TEST_MEDIALIB + '/api/downloads/' + DL + '/stream?api_key=' + TEST_TOKEN);   // the <video> can't send a header
      expect(stub.playFeedStream).not.toHaveBeenCalled();
    }
  });

  it('an episode: Sonarr metadata title first, then the feed’s episode title; season/episode numbers', async () => {
    net.on('GET', probeUrl, PROBE);
    const ep = { download_id: DL, status: 'downloading', type: 'tv', title: 'Silo', season: 2, episode: 3, episode_title: 'Feed title' };
    await m.pp.playPending(ep, { title: 'Silo' }, { title: 'Solo', overview: 'Juliette meets Solo.' });
    expect(started().mock.calls[0][0].item).toEqual({
      Type: 'Episode',
      Name: 'Solo',
      SeriesName: 'Silo',
      ParentIndexNumber: 2,
      IndexNumber: 3,
      Overview: 'Juliette meets Solo.',
      Genres: [],
      RunTimeTicks: 31255000000
    });
    await m.pp.playPending(ep, null);
    expect(started().mock.calls[1][0].item).toMatchObject({ Name: 'Feed title', SeriesName: 'Silo', Overview: '' });
  });

  it('a metadata failure still plays, without genres', async () => {
    net.on('GET', probeUrl, PROBE);
    net.on('GET', TEST_MEDIALIB + '/api/metadata/movie/tmdb-693134', net.status(500));
    await m.pp.playPending(movie, group);
    expect(started().mock.calls[0][0].item.Genres).toEqual([]);
  });

  it('no download_id: an older backend — toast, no request', async () => {
    await m.pp.playPending({ status: 'downloading', type: 'movie', title: 'x' }, group);
    expect(m.toast.toastState.msg).toBe('Streaming needs the updated library service');
    expect(net.calls).toEqual([]);
    expect(started()).not.toHaveBeenCalled();
  });

  it.each([
    ['409 not_ready', () => net.status(409, { error: 'not_ready', detail: 'header not on disk yet' }), 'Not enough downloaded yet — try again in a moment'],
    ['404 not_found', () => net.status(404, { error: 'not_found', detail: 'no such download' }), 'This download is no longer in the queue'],
    ['503 (download client down)', () => net.status(503, { error: 'qbittorrent_unreachable', detail: 'qBittorrent unreachable' }), 'Download service unavailable — try again in a moment'],
    ['the service unreachable', () => net.networkError(), 'Download service unavailable — try again in a moment']
  ])('probe %s: toast, nothing played', async (_, answer, msg) => {
    net.on('GET', probeUrl, answer);
    await m.pp.playPending(movie, group);
    expect(m.toast.toastState.msg).toBe(msg);
    expect(started()).not.toHaveBeenCalled();
  });

  it.each([
    ['an old backend without /probe (bare 404 detail)', () => net.status(404, { detail: 'Not Found' })],
    ['no ffprobe (503 probing unavailable)', () => net.status(503, { error: 'unavailable', detail: 'probing unavailable' })]
  ])('%s: plays anyway with an empty source', async (_, answer) => {
    net.on('GET', probeUrl, answer);
    await m.pp.playPending(movie, null);
    expect(started()).toHaveBeenCalledTimes(1);
    expect(started().mock.calls[0][0].source).toEqual({ Id: 'pending', Container: 'mkv', MediaStreams: [] });
    expect(started().mock.calls[0][0].item).toMatchObject({ Name: 'dune.part.two.2024', RunTimeTicks: undefined });
  });

  it('Back during the probe (S.epoch changed): the start gives up', async () => {
    let answer;
    net.on('GET', probeUrl, () => new Promise((r) => (answer = r)));
    const p = m.pp.playPending(movie, null);
    await flushPromises();
    m.nav.S.epoch++;
    answer(PROBE);
    await p;
    expect(started()).not.toHaveBeenCalled();
  });

  it('already in the player when the probe lands: no second start', async () => {
    let answer;
    net.on('GET', probeUrl, () => new Promise((r) => (answer = r)));
    const p = m.pp.playPending(movie, null);
    await flushPromises();
    m.nav.S.screen = 'player';
    answer(PROBE);
    await p;
    expect(started()).not.toHaveBeenCalled();
  });

  it(PHONE ? 'phone: load() on the empty <video> inside the tap, before any await' : 'TV: the <video> is left alone', async () => {
    net.on('GET', probeUrl, () => new Promise(() => {}));
    m.pp.playPending(movie, null);
    expect(video.load).toHaveBeenCalledTimes(PHONE ? 1 : 0);
  });

  if (PHONE) {
    it('phone: a <video> that already has a src is not reloaded', async () => {
      video.setAttribute('src', 'blob:x');
      net.on('GET', probeUrl, () => new Promise(() => {}));
      m.pp.playPending(movie, null);
      expect(video.load).not.toHaveBeenCalled();
    });
  }
});
