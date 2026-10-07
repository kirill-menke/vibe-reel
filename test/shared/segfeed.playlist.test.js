/* segfeed.js: parsePlaylist, feedSupported, feedCanPlay.
 *
 * CLAUDE.md (iPhone app → Playback): streams Safari's HLS player can't take go
 * through MSE — ManagedMediaSource on iOS 17.1+ — via segfeed.js: reel-api's
 * livehls.py remuxes a growing file into an fMP4 *event* playlist (no ENDLIST
 * until it is done), and offline copies keep the same segments in Cache
 * Storage. `canWatchPending = !__PHONE__ || feedSupported()`.
 *
 * parsePlaylist (module comment): an HLS media playlist → segments on the media
 * timeline (cumulative #EXTINF), plus the init segment's URI and whether it is
 * complete. Pure; runs in both projects. */
import { describe, it, expect, vi } from 'vitest';
import { parsePlaylist, feedSupported, feedCanPlay } from '../../src/lib/segfeed.js';
import { installMSE } from '../helpers/mse.js';

const ev = (lines) => lines.join('\n');

describe('parsePlaylist', () => {
  it('an fMP4 event playlist: init URI, cumulative starts/ends, not complete without ENDLIST', () => {
    const r = parsePlaylist(
      ev([
        '#EXTM3U',
        '#EXT-X-VERSION:7',
        '#EXT-X-TARGETDURATION:6',
        '#EXT-X-PLAYLIST-TYPE:EVENT',
        '#EXT-X-MAP:URI="init.mp4"',
        '#EXTINF:6.000000,',
        'seg0.m4s',
        '#EXTINF:6.000000,',
        'seg1.m4s',
        '#EXTINF:4.5,',
        'seg2.m4s',
        ''
      ])
    );
    expect(r.init).toBe('init.mp4');
    expect(r.complete).toBe(false);
    expect(r.segs).toEqual([
      { start: 0, end: 6, name: 'seg0.m4s' },
      { start: 6, end: 12, name: 'seg1.m4s' },
      { start: 12, end: 16.5, name: 'seg2.m4s' }
    ]);
  });

  it('complete iff #EXT-X-ENDLIST is present', () => {
    const base = ['#EXTM3U', '#EXTINF:2,', 'a.m4s'];
    expect(parsePlaylist(ev([...base, '#EXT-X-ENDLIST'])).complete).toBe(true);
    expect(parsePlaylist(ev(base)).complete).toBe(false);
  });

  it('fractional durations accumulate (ends are the running sum)', () => {
    const lines = ['#EXTM3U'];
    for (let i = 0; i < 10; i++) lines.push('#EXTINF:6.006,', `s${i}.m4s`);
    const { segs } = parsePlaylist(ev(lines));
    expect(segs).toHaveLength(10);
    for (let i = 0; i < 10; i++) {
      expect(segs[i].start).toBeCloseTo(6.006 * i, 9);
      expect(segs[i].end).toBeCloseTo(6.006 * (i + 1), 9);
      if (i) expect(segs[i].start).toBe(segs[i - 1].end);
    }
  });

  it('blank lines and other tags between #EXTINF and its URI are skipped', () => {
    const { segs } = parsePlaylist(
      ev(['#EXTM3U', '#EXTINF:3,', '', '#EXT-X-PROGRAM-DATE-TIME:2026-01-01T00:00:00Z', '#EXT-X-BYTERANGE:100@0', '   ', 'a.m4s', '#EXTINF:2,', 'b.m4s'])
    );
    expect(segs).toEqual([
      { start: 0, end: 3, name: 'a.m4s' },
      { start: 3, end: 5, name: 'b.m4s' }
    ]);
  });

  it('a trailing #EXTINF without a URI (a playlist read mid-write) is ignored', () => {
    const { segs, complete } = parsePlaylist(ev(['#EXTM3U', '#EXTINF:6,', 'a.m4s', '#EXTINF:6,', '', '#EXT-X-DISCONTINUITY']));
    expect(segs).toEqual([{ start: 0, end: 6, name: 'a.m4s' }]);
    expect(complete).toBe(false);
  });

  it('CRLF line endings and surrounding whitespace are trimmed from names', () => {
    const r = parsePlaylist('#EXTM3U\r\n#EXT-X-MAP:URI="init.mp4"\r\n#EXTINF:5,\r\n  a.m4s  \r\n#EXTINF:5,\r\nb.m4s\r\n#EXT-X-ENDLIST\r\n');
    expect(r.init).toBe('init.mp4');
    expect(r.segs).toEqual([
      { start: 0, end: 5, name: 'a.m4s' },
      { start: 5, end: 10, name: 'b.m4s' }
    ]);
    expect(r.complete).toBe(true);
  });

  it('URIs with query strings are kept whole', () => {
    const { segs, init } = parsePlaylist(ev(['#EXT-X-MAP:URI="init.mp4?job=7&t=1"', '#EXTINF:6,', 'seg0.m4s?job=7&t=1']));
    expect(init).toBe('init.mp4?job=7&t=1');
    expect(segs[0].name).toBe('seg0.m4s?job=7&t=1');
  });

  it('no map → init null; the last #EXT-X-MAP wins; an empty text has nothing', () => {
    expect(parsePlaylist(ev(['#EXTINF:6,', 'a.ts'])).init).toBe(null);
    expect(parsePlaylist(ev(['#EXT-X-MAP:URI="i1.mp4"', '#EXT-X-MAP:URI="i2.mp4"'])).init).toBe('i2.mp4');
    expect(parsePlaylist('')).toEqual({ segs: [], init: null, complete: false });
  });

  it('URI lines without a preceding #EXTINF are not segments', () => {
    expect(parsePlaylist(ev(['#EXTM3U', 'orphan.m4s', '#EXTINF:2,', 'a.m4s'])).segs).toEqual([{ start: 0, end: 2, name: 'a.m4s' }]);
  });

  it('#EXTINF with a title after the comma; integer durations', () => {
    expect(parsePlaylist(ev(['#EXTINF:10,Some title', 'a.m4s'])).segs).toEqual([{ start: 0, end: 10, name: 'a.m4s' }]);
  });
});

describe('feedSupported', () => {
  it('false with neither MediaSource nor ManagedMediaSource', () => {
    vi.stubGlobal('MediaSource', undefined);
    vi.stubGlobal('ManagedMediaSource', undefined);
    expect(feedSupported()).toBe(false);
  });

  it('true with MediaSource (desktop)', () => {
    installMSE();
    vi.stubGlobal('ManagedMediaSource', undefined);
    expect(feedSupported()).toBe(true);
  });

  it('true with only ManagedMediaSource (iOS 17.1+)', () => {
    installMSE({ managed: 'only' });
    expect(window.MediaSource).toBeFalsy();
    expect(feedSupported()).toBe(true);
  });
});

describe('feedCanPlay', () => {
  it('false without any MediaSource class', () => {
    vi.stubGlobal('MediaSource', undefined);
    vi.stubGlobal('ManagedMediaSource', undefined);
    expect(feedCanPlay('avc1.640028')).toBe(false);
  });

  it("asks isTypeSupported with the full video/mp4 mime", () => {
    const seen = [];
    installMSE({ supported: (m) => (seen.push(m), m.includes('hvc1')) });
    vi.stubGlobal('ManagedMediaSource', undefined);
    expect(feedCanPlay('hvc1.2.4.L153.B0,ec-3')).toBe(true);
    expect(feedCanPlay('av01.0.12M.10')).toBe(false);
    expect(seen).toEqual(['video/mp4; codecs="hvc1.2.4.L153.B0,ec-3"', 'video/mp4; codecs="av01.0.12M.10"']);
  });

  it('only ManagedMediaSource: its isTypeSupported answers', () => {
    installMSE({ managed: 'only', supported: (m) => m.includes('avc1') });
    expect(feedCanPlay('avc1.640028,mp4a.40.2')).toBe(true);
    expect(feedCanPlay('vp09.02.51.10')).toBe(false);
  });

  it('both classes: MediaSource is preferred', () => {
    installMSE({ managed: true });
    const ms = vi.spyOn(window.MediaSource, 'isTypeSupported').mockReturnValue(false);
    const mms = vi.spyOn(window.ManagedMediaSource, 'isTypeSupported').mockReturnValue(true);
    expect(feedCanPlay('avc1.640028')).toBe(false);
    expect(ms).toHaveBeenCalledTimes(1);
    expect(mms).not.toHaveBeenCalled();
  });
});
