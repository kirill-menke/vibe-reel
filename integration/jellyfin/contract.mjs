/* The direct-call half of the contract: requests built by the apps' own src/lib
 * modules (client.mjs loads them through Vite) sent to the real server through
 * the recording proxy, so the spec diff sees them too. This covers what the
 * browser scenarios can't reach: the HEVC + E-AC3 MKV (headless Chrome decodes
 * neither), the phone's HLS answer for it, burn-in profiles, Quick Connect, and
 * the documented 12.x breakages pinned one by one.
 *
 * Where a URL is built inside player.svelte.js (not importable into Node: it
 * owns the <video> element), the probe copies that one expression and names its
 * source line; the TV scenario then exercises the real one on the MP4.
 *
 * Each check → { id, title, status: 'pass' | 'fail' | 'warn' | 'info', detail }.
 * 'warn' = the server behaves differently from what CLAUDE.md records, but the
 * client doesn't depend on it (e.g. the legacy header being accepted again);
 * 'info' = recorded for the report. Only 'fail' fails the run. */
import { loadClient } from './client.mjs';
import { call, TICKS, USER } from './setup.mjs';

export class Fail extends Error {}
const must = (cond, msg) => {
  if (!cond) throw new Fail(msg);
};

export async function runContract({ jf, proxy, setupInfo, log = () => {} }) {
  const out = [];
  const { items, admin } = setupInfo;
  const res = (id, title, status, detail = '') => out.push({ id, title, status, detail });
  async function check(id, title, fn) {
    try {
      const r = await fn();
      if (r && typeof r === 'object' && r.status) res(id, title, r.status, r.detail || '');
      else res(id, title, 'pass', r || '');
    } catch (e) {
      res(id, title, 'fail', e instanceof Fail ? e.message : String(e.stack || e).split('\n').slice(0, 4).join(' | '));
    }
  }

  const tv = await loadClient('tv', { server: proxy, deviceId: 'reel-it-tv' });
  const phone = await loadClient('phone', { server: proxy, deviceId: 'reelphone-it' });
  const A = tv.api;
  const ctx = { tvToken: null, userId: null };

  try {
    // ---------------- auth ----------------
    await check('auth-header', "sign-in with api()'s `Authorization: MediaBrowser …` header", async () => {
      const r = await A.api('/Users/AuthenticateByName', { method: 'POST', body: { Username: USER.name, Pw: USER.password } });
      must(r && r.AccessToken && r.User && r.User.Id, 'AuthenticateByName answered without AccessToken/User.Id: ' + JSON.stringify(r).slice(0, 200));
      ctx.tvToken = r.AccessToken;
      ctx.userId = r.User.Id;
      Object.assign(tv.cfg, { token: r.AccessToken, userId: r.User.Id, userName: r.User.Name });
      const p = await phone.api.api('/Users/AuthenticateByName', { method: 'POST', body: { Username: USER.name, Pw: USER.password } });
      Object.assign(phone.cfg, { token: p.AccessToken, userId: p.User.Id, userName: p.User.Name });
      return `token for ${r.User.Name}; ServerId ${r.ServerId ? 'present' : 'absent'}`;
    });
    if (!ctx.tvToken) return out; // nothing else can work

    await check('auth-legacy-header', 'the same sign-in with only X-Emby-Authorization → 400 (why api() uses Authorization)', async () => {
      const h = `MediaBrowser Client="Reel", Device="LG webOS TV", DeviceId="reel-it-legacy", Version="0.1.0"`;
      const r = await fetch(jf + '/Users/AuthenticateByName', { method: 'POST', headers: { 'X-Emby-Authorization': h, 'Content-Type': 'application/json' }, body: JSON.stringify({ Username: USER.name, Pw: USER.password }), signal: AbortSignal.timeout(15000) });
      const text = (await r.text()).slice(0, 120);
      if (r.status === 400) return `400 ${text}`;
      return { status: 'warn', detail: `answered ${r.status} (12.1 answers 400) — this version accepts the legacy header; harmless for api() (it sends Authorization), but CLAUDE.md's note no longer describes this server` };
    });

    await check('auth-guard-users-me', "reel-api's request guard: GET /Users/Me with a Token-only header → 200 {Id}; a bad token → 401", async () => {
      // backend/src/reel_api/security.py JellyfinAuth._ask: Token only, so Jellyfin keeps the
      // token's own device record; 400/401/403/404 = rejected, anything else = Jellyfin unavailable
      const me = (token) => fetch(jf + '/Users/Me', { headers: { Authorization: `MediaBrowser Token="${token}"` }, signal: AbortSignal.timeout(15000) });
      const good = await me(ctx.tvToken);
      const body = good.status === 200 ? await good.json() : null;
      must(good.status === 200 && body?.Id === ctx.userId, `Token-only /Users/Me answered ${good.status} ${JSON.stringify(body)?.slice(0, 120)} — the guard would refuse every signed-in client`);
      const bad = await me('0'.repeat(32));
      must([400, 401, 403, 404].includes(bad.status), `an unknown token answered ${bad.status} — the guard reads that as "Jellyfin unavailable", not a rejection`);
      return `200 for the user's token, ${bad.status} for an unknown one`;
    });

    // ---------------- library reads ----------------
    let movieItem, browserItem;
    await check('items-grid-fields', 'Library grid: /Items with GRID_FIELDS + ProviderIds, paged like Library.svelte', async () => {
      const q = { IncludeItemTypes: 'Movie', Recursive: true, SortBy: 'SortName', SortOrder: 'Ascending', Fields: A.GRID_FIELDS + ',ProviderIds', StartIndex: 0, Limit: 126 };
      const r = await A.api(A.itemsPath(q));
      must(Array.isArray(r.Items) && r.Items.length === 2, `2 movies expected, got ${r.Items?.length}`);
      must(typeof r.TotalRecordCount === 'number', 'TotalRecordCount missing');
      for (const it of r.Items) {
        must(it.UserData && typeof it.UserData.Played === 'boolean', `${it.Name}: UserData.Played missing`);
        must(typeof it.ProductionYear === 'number', `${it.Name}: ProductionYear missing (folder year)`);
        must(it.MediaSources?.[0]?.MediaStreams?.length, `${it.Name}: MediaSources[0].MediaStreams missing`);
        must(it.ImageTags && typeof it.ImageTags === 'object', `${it.Name}: ImageTags missing`);
      }
      const badge = tv.tracks.tileTechBadge(r.Items.find((i) => i.Id === items.movie.Id));
      return `2 tiles; tileTechBadge(Contract Movie) = ${JSON.stringify(badge)}`;
    });

    await check('item-detail-tracks', "Detail: /Items/{id} → describeTracks()/heroBadges() read the MKV's streams", async () => {
      movieItem = await A.api(A.itemPath(items.movie.Id));
      browserItem = await A.api(A.itemPath(items.browser.Id));
      const src = tv.tracks.pickSource(movieItem);
      must(src && src.Id && src.Container, 'pickSource(): no MediaSource with Id/Container');
      const d = tv.tracks.describeTracks(src, movieItem);
      must(d.audio.length === 2, `2 audio tracks expected, got ${d.audio.length}`);
      const def = src.MediaStreams.find((s) => s.Index === d.defaultAudio);
      must(def && def.Codec === 'eac3' && def.Channels === 6, `default audio should be the E-AC3 5.1 track, got ${def?.Codec} ${def?.Channels}ch`);
      must(d.subs.length === 3, `None + 2 subtitle tracks expected, got ${d.subs.length}`);
      must(d.subs.some((s) => s.codec === 'subrip') && d.subs.some((s) => s.codec === 'ass'), 'subrip + ass expected: ' + d.subs.map((s) => s.codec).join(','));
      must(/HEVC/.test(d.video), 'video line should name HEVC: ' + d.video);
      const badges = tv.tracks.heroBadges(movieItem);
      must(Array.isArray(movieItem.Chapters) || movieItem.Chapters === undefined, 'Chapters has an odd shape');
      return `audio ${d.audio.map((a) => a.label || a.codec).join(' / ')}; subs ${d.subs.slice(1).map((s) => s.label || s.codec).join(' / ')}; video ${d.video}; heroBadges ${JSON.stringify(badges)}`;
    });

    await check('series-paths', 'SeriesDetail: seasonsPath() / episodesPaths() / nextUpPath()', async () => {
      const seasons = await A.api(A.seasonsPath(items.series.Id));
      must(seasons.Items?.length === 1, 'one season expected, got ' + seasons.Items?.length);
      const paths = A.episodesPaths(items.series.Id, seasons.Items[0].Id);
      const list = Array.isArray(paths) ? paths : [paths];
      const r = await A.api(list[0]);
      must(r.Items?.length === 2, 'two episodes expected, got ' + r.Items?.length);
      must(r.Items[0].UserData?.Played === true, 'S01E01 should come back Played (setup marked it)');
      const first = await A.api(list[1]);
      must(first.Items?.[0]?.MediaSources?.length, 'the first-episode path should carry MediaSources');
      // nextUpPath() is phone-only (tree-shaken from the TV build)
      const nu = await phone.api.api(phone.api.nextUpPath(items.series.Id));
      must(nu.Items?.[0]?.Id === items.ep2.Id, 'Next Up should be S01E02, got ' + (nu.Items?.[0]?.Name || 'nothing'));
      return `${list.length} episode path(s); Next Up = ${nu.Items[0].Name}`;
    });

    // ---------------- PlaybackInfo ----------------
    const tvBody = (profile, extra = {}) => ({ UserId: ctx.userId, DeviceProfile: profile, AutoOpenLiveStream: true, MaxStreamingBitrate: 400000000, StartTimeTicks: 0, ...extra });
    const pinfo = (api, id, body) => api.api('/Items/' + id + '/PlaybackInfo', { method: 'POST', body });
    let tvSession = null;
    await check('playbackinfo-tv', 'PlaybackInfo with deviceProfile(false) → DirectPlay, no TranscodingUrl (MKV, MP4, episode)', async () => {
      const rows = [];
      for (const it of [items.movie, items.browser, items.ep1]) {
        const r = await pinfo(A, it.Id, tvBody(tv.deviceProfile(false)));
        const s = r.MediaSources?.[0];
        must(s, `${it.Name}: no MediaSources`);
        must(!r.ErrorCode, `${it.Name}: ErrorCode ${r.ErrorCode}`);
        must(s.SupportsDirectPlay === true, `${it.Name}: SupportsDirectPlay=${s.SupportsDirectPlay} (TranscodeReasons ${s.TranscodeReasons})`);
        must(!s.TranscodingUrl, `${it.Name}: TranscodingUrl present: ${String(s.TranscodingUrl).slice(0, 100)}`);
        must(r.PlaySessionId, `${it.Name}: no PlaySessionId`);
        if (it.Id === items.movie.Id) tvSession = { id: r.PlaySessionId, source: s };
        rows.push(`${it.Name}: DirectPlay`);
      }
      return rows.join('; ');
    });

    await check('playbackinfo-tv-burn', 'PlaybackInfo with deviceProfile(true) on a VobSub-free MKV (text sub picked) → still DirectPlay', async () => {
      const src = movieItem ? tv.tracks.pickSource(movieItem) : items.movie.MediaSources[0];
      const srt = src.MediaStreams.find((s) => s.Type === 'Subtitle' && s.Codec === 'subrip');
      const aud = src.MediaStreams.find((s) => s.Type === 'Audio' && s.Codec === 'eac3');
      // player.svelte.js play(): the burn branch sends MediaSourceId + SubtitleStreamIndex (+ AudioStreamIndex), no StartTimeTicks
      const body = { UserId: ctx.userId, DeviceProfile: tv.deviceProfile(true), AutoOpenLiveStream: true, MaxStreamingBitrate: 400000000, MediaSourceId: src.Id, SubtitleStreamIndex: srt.Index, AudioStreamIndex: aud.Index };
      const r = await pinfo(A, items.movie.Id, body);
      const s = r.MediaSources[0];
      must(s.SupportsDirectPlay === true && !s.TranscodingUrl, `burn profile turned a text sub into a transcode: DirectPlay=${s.SupportsDirectPlay} TranscodingUrl=${String(s.TranscodingUrl).slice(0, 100)}`);
      const sub = s.MediaStreams.find((x) => x.Index === srt.Index);
      return `DirectPlay; the SRT is delivered ${sub?.DeliveryMethod}`;
    });

    let phoneJob = null;
    await check('playbackinfo-phone', 'PlaybackInfo with the phone profile → MKV: HLS TranscodingUrl (video copied); MP4: DirectPlay', async () => {
      const src = items.movie.MediaSources[0];
      const aud = src.MediaStreams.find((s) => s.Type === 'Audio' && s.Codec === 'eac3');
      // player.svelte.js play(), __PHONE__ branch
      const body = { UserId: phone.cfg.userId, DeviceProfile: phone.deviceProfile(false, 200000000), AutoOpenLiveStream: true, MaxStreamingBitrate: 200000000, MediaSourceId: src.Id, AudioStreamIndex: aud.Index, SubtitleStreamIndex: -1, StartTimeTicks: 0 };
      const r = await pinfo(phone.api, items.movie.Id, body);
      const s = r.MediaSources[0];
      must(s.SupportsDirectPlay === false, 'an MKV must not DirectPlay on the phone');
      must(s.TranscodingUrl && /\/master\.m3u8\?/i.test(s.TranscodingUrl), 'TranscodingUrl should be a master.m3u8: ' + s.TranscodingUrl);
      const q = new URLSearchParams(s.TranscodingUrl.split('?')[1]);
      const lc = Object.fromEntries([...q].map(([k, v]) => [k.toLowerCase(), v]));
      must(lc.allowvideostreamcopy !== 'false', 'AllowVideoStreamCopy=false: the HEVC video would be re-encoded');
      must(/hevc/i.test(lc.videocodec || ''), 'VideoCodec should allow hevc (copy): ' + lc.videocodec);
      phoneJob = { url: s.TranscodingUrl, session: r.PlaySessionId, device: phone.cfg.deviceId };
      const r2 = await pinfo(phone.api, items.browser.Id, { ...body, MediaSourceId: items.browser.MediaSources[0].Id, AudioStreamIndex: undefined });
      const s2 = r2.MediaSources[0];
      must(s2.SupportsDirectPlay === true && !s2.TranscodingUrl, 'a progressive H.264/AAC MP4 should DirectPlay on the phone');
      return `MKV → ${s.TranscodingUrl.split('?')[0]} (container ${lc.segmentcontainer || '?'}, VideoCodec ${lc.videocodec}, AudioCodec ${lc.audiocodec}); MP4 → DirectPlay`;
    });

    await check('phone-hls-main', "the phone's main.m3u8 (master's query) answers a playlist; the job is stopped with DELETE /Videos/ActiveEncodings", async () => {
      must(phoneJob, 'no TranscodingUrl from the previous check');
      // player.svelte.js:379 — the media playlist, not master.m3u8
      const url = proxy + phoneJob.url.replace('/master.m3u8', '/main.m3u8');
      const r = await fetch(url, { headers: { Authorization: `MediaBrowser Client="Reel", Device="iPhone", DeviceId="${phoneJob.device}", Version="0.1.0", Token="${phone.cfg.token}"` }, signal: AbortSignal.timeout(60000) });
      const text = await r.text();
      must(r.status === 200, `main.m3u8 → ${r.status} ${text.slice(0, 120)}`);
      must(/^#EXTM3U/.test(text) && /#EXTINF/.test(text), 'not a media playlist: ' + text.slice(0, 120));
      const seg = text.split('\n').find((l) => l && !l.startsWith('#'));
      const stop = await phone.api.api('/Videos/ActiveEncodings' + phone.api.qs({ deviceId: phoneJob.device, playSessionId: phoneJob.session }), { method: 'DELETE' }).then(() => 'stopped', (e) => 'DELETE → ' + e.status);
      return `${text.split('\n').filter((l) => l.startsWith('#EXTINF')).length} segments listed (first ${seg?.split('?')[0]}); job ${stop}`;
    });

    // ---------------- the file itself ----------------
    await check('static-stream-range', 'the static=true stream (directUrl(), api_key=) with Range → 206 + Content-Range', async () => {
      const s = tvSession?.source || items.movie.MediaSources[0];
      // player.svelte.js directUrl()
      const url = tv.cfg.server + '/Videos/' + items.movie.Id + '/stream.' + (s.Container || 'mkv') + A.qs({ static: 'true', mediaSourceId: s.Id, api_key: tv.cfg.token, PlaySessionId: tvSession?.id, deviceId: tv.cfg.deviceId });
      const r = await fetch(url, { headers: { Range: 'bytes=0-65535' }, signal: AbortSignal.timeout(15000) });
      const b = Buffer.from(await r.arrayBuffer());
      must(r.status === 206, `Range request → ${r.status}`);
      must(/^bytes 0-65535\/\d+$/.test(r.headers.get('content-range') || ''), 'Content-Range: ' + r.headers.get('content-range'));
      must(b.length === 65536 && b.readUInt32BE(0) === 0x1a45dfa3, 'not the first 64 KiB of the Matroska file');
      const total = Number(r.headers.get('content-range').split('/')[1]);
      const r2 = await fetch(url, { headers: { Range: `bytes=${total - 1024}-` }, signal: AbortSignal.timeout(15000) });
      await r2.arrayBuffer();
      must(r2.status === 206, 'tail Range → ' + r2.status);
      return `206, ${r.headers.get('content-type')}, ${total} bytes, Accept-Ranges ${r.headers.get('accept-ranges')}`;
    });

    await check('subtitle-vtt', "text subtitles as VTT (attachSubtitles()'s URL, api_key=): SRT and ASS", async () => {
      const s = items.movie.MediaSources[0];
      const rows = [];
      for (const codec of ['subrip', 'ass']) {
        const st = s.MediaStreams.find((x) => x.Type === 'Subtitle' && x.Codec === codec);
        // player.svelte.js attachSubtitles()
        const url = tv.cfg.server + '/Videos/' + items.movie.Id + '/' + s.Id + '/Subtitles/' + st.Index + '/0/Stream.vtt' + A.qs({ api_key: tv.cfg.token });
        const r = await fetch(url, { signal: AbortSignal.timeout(30000) });
        const text = await r.text();
        must(r.status === 200 && /^WEBVTT/.test(text.replace(/^﻿/, '')), `${codec} → ${r.status} ${text.slice(0, 80)}`);
        must(/Fixture subtitle|Untertitel/.test(text), `${codec}: cue text missing`);
        rows.push(`${codec} ${r.headers.get('content-type')}`);
      }
      return rows.join('; ');
    });

    // ---------------- segments, chapters, trickplay ----------------
    await check('media-segments', '/MediaSegments/{id} → 200 { Items, TotalRecordCount } (empty without Intro Skipper)', async () => {
      const r = await A.api('/MediaSegments/' + items.movie.Id);
      must(r && Array.isArray(r.Items), '/MediaSegments answer has no Items array: ' + JSON.stringify(r).slice(0, 120));
      for (const seg of r.Items) must(seg.Type && typeof seg.StartTicks === 'number' && typeof seg.EndTicks === 'number', 'segment shape: ' + JSON.stringify(seg));
      return `${r.Items.length} segment(s)`;
    });

    await check('find-markers', 'findMarkers() (segments.js) → intro 5–20 s and credits 45–60 s from the chapters named Intro / Credits', async () => {
      const m = await tv.segments.findMarkers(items.movie.Id, { RunTimeTicks: items.movie.RunTimeTicks }, null);
      const intro = m.skips.find((s) => s.kind === 'intro');
      must(intro && Math.round(intro.start) === 5 && Math.round(intro.end) === 20, 'intro: ' + JSON.stringify(m.skips));
      must(m.credits && Math.round(m.credits.start) === 45 && Math.round(m.credits.end) === 60, 'credits: ' + JSON.stringify(m.credits));
      return `intro ${intro.start}–${intro.end} (${intro.from}), credits ${m.credits.start}–${m.credits.end} (${m.credits.from})`;
    });

    await check('trickplay-apikey', 'Trickplay: the item field shape, and a sheet with ApiKey= (trickAt()) → 200 image/jpeg', async () => {
      const r = await A.api(A.itemsPath({ Ids: items.movie.Id, Fields: 'Trickplay', Recursive: true, Limit: 1 }));
      const tp = r.Items?.[0]?.Trickplay;
      must(tp && typeof tp === 'object', 'no Trickplay field (setup generates it)');
      const [sourceId, byRes] = Object.entries(tp)[0];
      const [res, info] = Object.entries(byRes)[0];
      for (const k of ['Width', 'Height', 'TileWidth', 'TileHeight', 'ThumbnailCount', 'Interval']) must(typeof info[k] === 'number', `Trickplay.${k} missing`);
      // player.svelte.js trickAt()
      const url = tv.cfg.server + '/Videos/' + items.movie.Id + '/Trickplay/' + res + '/0.jpg' + A.qs({ MediaSourceId: sourceId, ApiKey: tv.cfg.token });
      const s = await fetch(url, { signal: AbortSignal.timeout(15000) });
      const b = Buffer.from(await s.arrayBuffer());
      must(s.status === 200 && b[0] === 0xff && b[1] === 0xd8, `sheet → ${s.status} ${s.headers.get('content-type')}`);
      ctx.trick = { url: tv.cfg.server.replace(proxy, jf) + url.slice(tv.cfg.server.length) };
      return `${res}px, ${info.ThumbnailCount} thumbs, ${info.TileWidth}×${info.TileHeight} tiles, ${info.Interval} ms; sheet 0 ${b.length} bytes`;
    });

    await check('trickplay-api-key-legacy', 'Trickplay with the legacy api_key= (recorded; 12.1 answers 401)', async () => {
      must(ctx.trick, 'no sheet URL');
      // straight to the server: the proxy flags api_key= on Trickplay as a client violation
      const r = await fetch(ctx.trick.url.replace('ApiKey=', 'api_key='), { signal: AbortSignal.timeout(15000) });
      await r.arrayBuffer();
      if (r.status === 401) return '401, as documented for 12.1 (the client must keep ApiKey=)';
      return { status: 'warn', detail: `answered ${r.status} — differs from 12.1's 401; harmless for the client (it sends ApiKey=)` };
    });

    // ---------------- writes: played, reports ----------------
    await check('played-toggle', 'setPlayed() (played.js) → POST/DELETE /UserPlayedItems/{id} and the UserData it returns', async () => {
      const on = await tv.played.setPlayed(items.movie.Id, true);
      must(on && on.Played === true, 'POST answered ' + JSON.stringify(on).slice(0, 160));
      const it = await A.api(A.itemPath(items.movie.Id));
      must(it.UserData?.Played === true, 'the item does not read back Played');
      const off = await tv.played.setPlayed(items.movie.Id, false);
      must(off && off.Played === false, 'DELETE answered ' + JSON.stringify(off).slice(0, 160));
      return 'Played true → false';
    });

    await check('session-reports', 'Sessions/Playing, /Progress, /Stopped (baseReport() shape) accepted; Stopped saves the position', async () => {
      const s = tvSession?.source || items.movie.MediaSources[0];
      const aud = s.MediaStreams.find((x) => x.Type === 'Audio' && x.IsDefault) || s.MediaStreams.find((x) => x.Type === 'Audio');
      // player.svelte.js baseReport()
      const base = (sec, paused = false) => ({ ItemId: items.movie.Id, MediaSourceId: s.Id, PlaySessionId: tvSession?.id, PositionTicks: Math.floor(sec * TICKS), IsPaused: paused, PlayMethod: 'DirectPlay', CanSeek: true, VolumeLevel: 100, AudioStreamIndex: aud.Index, SubtitleStreamIndex: -1 });
      // reportStop(): Stopped carries only these four
      const stopped = (sec) => { const b = base(sec); return { ItemId: b.ItemId, MediaSourceId: b.MediaSourceId, PlaySessionId: b.PlaySessionId, PositionTicks: b.PositionTicks }; };
      for (const [path, b] of [['/Sessions/Playing', base(0)], ['/Sessions/Playing/Progress', base(12)], ['/Sessions/Playing/Progress', base(20, true)], ['/Sessions/Playing/Stopped', stopped(25)]]) {
        const r = await A.api(path, { method: 'POST', body: b });
        must(r === null || r === '', `${path} answered a body: ${JSON.stringify(r).slice(0, 80)}`);
      }
      const it = await A.api(A.itemPath(items.movie.Id));
      const pos = (it.UserData?.PlaybackPositionTicks || 0) / TICKS;
      must(Math.abs(pos - 25) < 1, `resume point should be ~25 s, is ${pos}`);
      // put the item back (the browser scenarios expect it unwatched at 0)
      await call(jf, 'POST', `/UserItems/${items.movie.Id}/UserData?userId=${admin.userId}`, { token: admin.token, body: { PlaybackPositionTicks: 0, Played: false } });
      return `204 ×4; resume point ${pos.toFixed(1)} s (restored to 0)`;
    });

    // ---------------- account ----------------
    await check('user-image', 'avatarUrl() → /UserImage?userId=… (maxHeight/quality ride along) → 200 image', async () => {
      if (tv.account.loadError) throw new Fail('account.svelte.js did not load: ' + tv.account.loadError);
      const url = tv.account.avatarUrl({ server: tv.cfg.server, userId: ctx.userId });
      const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
      await r.arrayBuffer();
      must(r.status === 200 && /^image\//.test(r.headers.get('content-type') || ''), `→ ${r.status} ${r.headers.get('content-type')}`);
      return `${r.status} ${r.headers.get('content-type')}`;
    });

    await check('quick-connect', 'Quick Connect: Enabled → Initiate → Connect → Authorize (admin) → AuthenticateWithQuickConnect', async () => {
      const en = await A.api('/QuickConnect/Enabled');
      if (en !== true) return { status: 'warn', detail: 'Quick Connect is disabled on a fresh server (' + JSON.stringify(en) + ') — Login.svelte then hides the code' };
      const keep = tv.cfg.token;
      tv.cfg.token = ''; // Login runs signed out
      try {
        const init = await A.api('/QuickConnect/Initiate', { method: 'POST' });
        must(init && /^\d{6}$/.test(init.Code) && init.Secret, 'Initiate: ' + JSON.stringify(init).slice(0, 160));
        const st = await A.api('/QuickConnect/Connect' + A.qs({ Secret: init.Secret }));
        must(st.Authenticated === false, 'Connect before approval: ' + JSON.stringify(st).slice(0, 120));
        const ap = await call(jf, 'POST', `/QuickConnect/Authorize?code=${init.Code}&userId=${admin.userId}`, { token: admin.token });
        must(ap.status === 200, 'Authorize → ' + ap.status + ' ' + ap.text);
        const st2 = await A.api('/QuickConnect/Connect' + A.qs({ Secret: init.Secret }));
        must(st2.Authenticated === true, 'Connect after approval: ' + JSON.stringify(st2).slice(0, 120));
        const auth = await A.api('/Users/AuthenticateWithQuickConnect', { method: 'POST', body: { Secret: init.Secret } });
        must(auth.AccessToken && auth.User?.Id === ctx.userId, 'AuthenticateWithQuickConnect: ' + JSON.stringify(auth).slice(0, 120));
        return 'code ' + init.Code + ' → token';
      } finally {
        tv.cfg.token = keep;
      }
    });

    // ---------------- recorded only ----------------
    await check('legacy-routes', 'routes the client stopped using: still served? (recorded, never used)', async () => {
      const rows = [];
      for (const [m, p] of [['GET', `/Users/${ctx.userId}/Images/Primary`], ['GET', `/Users/${ctx.userId}/Items/${items.movie.Id}`], ['POST', `/Users/${ctx.userId}/PlayedItems/${items.movie.Id}`]]) {
        // the admin token: it was issued to the harness's own DeviceId, which call() sends (a token used
        // under another DeviceId is refused with 401 whatever the route)
        const r = await call(jf, m, p, { token: admin.token });
        rows.push(`${m} ${p.replace(ctx.userId, '{uid}').replace(items.movie.Id, '{id}')} → ${r.status}`);
      }
      await call(jf, 'DELETE', `/UserPlayedItems/${items.movie.Id}?userId=${ctx.userId}`, { token: admin.token }); // undo the POST above
      return { status: 'info', detail: rows.join('; ') };
    });
  } finally {
    await tv.close();
    await phone.close();
  }
  return out;
}
