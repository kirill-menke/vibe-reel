/* Self-test of the fixture media (server/media.mjs) and the routes that serve
 * it: the stream answers Range requests like Jellyfin's static stream (206 /
 * Content-Range / 416), the TV player's exact static=true URL validates against
 * 12.1, the trickplay sheets are real JPEGs of the seeded 10×10 × 320×180 grid
 * whose thumbnail i is the fixture's frame at i·10 s, and the served VTT's cues
 * run on the same clock. No browser. */
import { test, assert } from '../lib/runner.mjs';
import { statSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { TICKS } from '../server/seed.mjs';

async function get(srv, path, headers = {}, method = 'GET') {
  const before = srv.violations.length;
  const r = await fetch(srv.urls.jf + path, { method, headers });
  const body = Buffer.from(await r.arrayBuffer());
  return { status: r.status, h: r.headers, body, violations: srv.violations.slice(before).map((v) => v.msg) };
}

/* width/height from a baseline or progressive JPEG's SOF segment */
function jpegSize(b) {
  assert(b[0] === 0xff && b[1] === 0xd8, 'JPEG SOI');
  let i = 2;
  while (i < b.length) {
    if (b[i] !== 0xff) throw new Error('bad JPEG marker at ' + i);
    const m = b[i + 1];
    const len = b.readUInt16BE(i + 2);
    if (m >= 0xc0 && m <= 0xc2) return { w: b.readUInt16BE(i + 7), h: b.readUInt16BE(i + 5) };
    i += 2 + len;
  }
  throw new Error('no SOF');
}

test('media: fixture video, Range on the static stream, trickplay sheets and VTT on the fixture clock', { app: 'none', fast: true, timeout: 60000, allowViolations: [/Trickplay with legacy api_key=/] }, async (t) => {
  const { srv } = t;
  const m = srv.media;
  if (!m.webm) {
    t.log('no fixture media: ' + m.error);
    assert.fail('fixture media missing (ffmpeg required): ' + m.error);
  }
  const s = srv.issueToken('alice', 'media-oracle');
  const ep = srv.world.list('Episode')[0];
  const src = ep.MediaSources[0];

  await t.step('the fixture: an hour, ≤ 15 MB, 2 fps, keyframes every 10 s', async () => {
    const size = statSync(m.webm).size;
    t.log(`fixture ${(size / 1e6).toFixed(1)} MB, ${m.duration} s, ${m.sheets.length} sheets`);
    assert(size <= 15e6, 'size ' + size);
    const p = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=codec_name,avg_frame_rate', '-of', 'json', m.webm], { encoding: 'utf8' });
    if (p.status === 0) {
      const j = JSON.parse(p.stdout);
      assert(Math.abs(Number(j.format.duration) - 3600) < 1, 'duration ' + j.format.duration);
      assert.deepEqual(j.streams.map((x) => x.codec_name), ['vp9', 'opus']);
      assert.equal(j.streams[0].avg_frame_rate, '2/1');
    }
    // every seeded episode fits in the file (resume, credits and Up Next windows)
    const longest = Math.max(...srv.world.list('Episode').map((e) => e.RunTimeTicks / TICKS));
    assert(longest <= m.duration, `longest episode ${longest} s > fixture`);
  });

  await t.step("the TV player's static=true URL: 200 full, 206 ranges, 416 past the end, no 12.1 violations", async () => {
    const size = statSync(m.webm).size;
    // directUrl() in player.svelte.js: static, mediaSourceId, api_key (accepted on streams), PlaySessionId, deviceId
    const url = `/Videos/${ep.Id}/stream.${src.Container}?static=true&mediaSourceId=${src.Id}&api_key=${s.token}&PlaySessionId=abc123&deviceId=media-oracle`;
    let r = await get(srv, url, {}, 'HEAD');
    assert.equal(r.status, 200);
    assert.deepEqual(r.violations, []);
    assert.equal(r.h.get('accept-ranges'), 'bytes');
    assert.equal(Number(r.h.get('content-length')), size);
    assert.equal(r.h.get('content-type'), 'video/webm');

    r = await get(srv, url, { Range: 'bytes=0-1023' });
    assert.equal(r.status, 206);
    assert.deepEqual(r.violations, []);
    assert.equal(r.h.get('content-range'), `bytes 0-1023/${size}`);
    assert.equal(r.body.length, 1024);
    assert.equal(r.body.subarray(0, 4).toString('hex'), '1a45dfa3', 'EBML header');
    assert(r.body.includes(Buffer.from('webm')), 'DocType webm');

    r = await get(srv, url, { Range: `bytes=${size - 500}-` });
    assert.equal(r.status, 206, 'open-ended range');
    assert.equal(r.h.get('content-range'), `bytes ${size - 500}-${size - 1}/${size}`);
    assert(r.body.equals(readFileSync(m.webm).subarray(size - 500)), 'the last 500 bytes');

    r = await get(srv, url, { Range: 'bytes=-200' });
    assert.equal(r.status, 206, 'suffix range');
    assert.equal(r.body.length, 200);

    r = await get(srv, url, { Range: `bytes=${size + 10}-` });
    assert.equal(r.status, 416, 'range past the end');
    assert.equal(r.h.get('content-range'), `bytes */${size}`);

    // the same file under the container-less route
    r = await get(srv, `/Videos/${ep.Id}/stream?static=true&mediaSourceId=${src.Id}&api_key=${s.token}`, { Range: 'bytes=0-3' });
    assert.equal(r.status, 206);
    assert.deepEqual(r.violations, []);
  });

  await t.step('trickplay: real 3200×1800 JPEGs of the seeded grid; thumbnail i = the frame at i·10 s; ApiKey only', async () => {
    const lay = ep.Trickplay[ep.Id][320];
    const q = `?MediaSourceId=${src.Id}&ApiKey=${s.token}`;
    const bodies = [];
    for (let k = 0; k < 6; k++) {
      const r = await get(srv, `/Videos/${ep.Id}/Trickplay/320/${k}.jpg${q}`);
      assert.equal(r.status, 200, 'sheet ' + k);
      assert.deepEqual(r.violations, []);
      assert.equal(r.h.get('content-type'), 'image/jpeg');
      assert.deepEqual(jpegSize(r.body), { w: lay.Width * lay.TileWidth, h: lay.Height * lay.TileHeight }, 'sheet ' + k + ' is the full seeded grid');
      bodies.push(r.body);
    }
    assert(!bodies[0].equals(bodies[1]), 'sheets differ');
    assert(bodies[4].equals(bodies[0]) && bodies[5].equals(bodies[1]), 'past the fixture hour the index wraps');
    assert.equal(lay.Interval, m.interval * 1000);
    const legacy = await get(srv, `/Videos/${ep.Id}/Trickplay/320/0.jpg?MediaSourceId=${src.Id}&api_key=${s.token}`);
    assert.equal(legacy.status, 401, 'api_key refused on Trickplay (12.1)');
    assert.equal(legacy.violations.length, 1, 'and flagged (allowed for this test only)');

    // thumbnail 354 (sheet 3, row 5, col 4) against the fixture frame at 3540 s
    const ff = spawnSync('ffmpeg', ['-v', 'error', '-ss', '3540', '-i', m.webm, '-i', m.sheets[3],
      '-filter_complex', '[0:v]trim=end_frame=1,setpts=PTS-STARTPTS[a];[1:v]crop=320:180:1280:900[b];[a][b]psnr=stats_file=-', '-f', 'null', '-'], { encoding: 'utf8' });
    if (ff.status === 0) {
      const psnr = Number(/psnr_avg:([\d.]+|inf)/.exec(ff.stdout)?.[1].replace('inf', '99'));
      t.log('thumbnail 354 vs frame @3540 s: PSNR ' + psnr);
      assert(psnr > 25, 'thumbnail matches its frame (PSNR ' + psnr + ')');
      // and does not match the neighbouring frame
      const ff2 = spawnSync('ffmpeg', ['-v', 'error', '-ss', '3550', '-i', m.webm, '-i', m.sheets[3],
        '-filter_complex', '[0:v]trim=end_frame=1,setpts=PTS-STARTPTS[a];[1:v]crop=320:180:1280:900[b];[a][b]psnr=stats_file=-', '-f', 'null', '-'], { encoding: 'utf8' });
      const other = Number(/psnr_avg:([\d.]+|inf)/.exec(ff2.stdout)?.[1].replace('inf', '99'));
      assert(other < psnr - 3, `the neighbour frame matches worse (${other} vs ${psnr})`);
    }
  });

  await t.step('Stream.vtt: a cue every 10 s for the hour, on the burned-in clock', async () => {
    const sub = ep.MediaSources[0].MediaStreams.find((x) => x.Type === 'Subtitle' && x.IsTextSubtitleStream);
    const r = await get(srv, `/Videos/${ep.Id}/${src.Id}/Subtitles/${sub.Index}/0/Stream.vtt?api_key=${s.token}`);
    assert.equal(r.status, 200);
    assert.deepEqual(r.violations, []);
    const txt = r.body.toString('utf8');
    assert(txt.startsWith('WEBVTT\n'));
    const cues = [...txt.matchAll(/(\d\d):(\d\d):(\d\d)\.000 --> (\d\d):(\d\d):(\d\d)\.000\nFixture subtitle (\S+)/g)];
    assert.equal(cues.length, m.duration / m.interval);
    for (const [i, c] of cues.entries()) {
      const start = +c[1] * 3600 + +c[2] * 60 + +c[3];
      assert.equal(start, i * 10, 'cue ' + i);
      assert.equal(c[7], `${c[1]}:${c[2]}:${c[3]}`, 'cue text = its start on the fixture clock');
    }
  });
});

test('media: headless Chrome decodes the fixture from the stream route — plays, seeks to 20:00 (Range), duration 1 h', { fast: true, timeout: 45000 }, async (t) => {
  const { page, srv } = t;
  if (!srv.media.webm) assert.fail('fixture media missing: ' + srv.media.error);
  const s = srv.issueToken('alice', 'media-chrome');
  const ep = srv.world.list('Episode')[0];
  await page.goto(srv.urls.tv + '/__e2e_blank');
  const url = `${srv.urls.jf}/Videos/${ep.Id}/stream.mkv?static=true&mediaSourceId=${ep.Id}&api_key=${s.token}`;
  const n0 = srv.requests({ origin: 'jf', path: `/Videos/${ep.Id}/stream.mkv` }).length;
  const r = await page.eval(async (url) => {
    const v = document.createElement('video');
    v.muted = true;
    document.body.append(v);
    const ev = (name) => new Promise((ok, no) => {
      v.addEventListener(name, ok, { once: true });
      v.addEventListener('error', () => no(new Error('media error ' + v.error?.code + ' ' + v.error?.message)), { once: true });
    });
    const t0 = performance.now();
    v.src = url;
    await v.play();
    await ev('timeupdate');
    const started = performance.now() - t0;
    v.currentTime = 1200;
    await ev('seeked');
    await new Promise((ok) => setTimeout(ok, 600));
    return { started, duration: v.duration, t: v.currentTime, paused: v.paused, w: v.videoWidth, h: v.videoHeight };
  }, url);
  t.log('fixture in Chrome: ' + JSON.stringify(r));
  assert(Math.abs(r.duration - srv.media.duration) < 1, 'duration ' + r.duration);
  assert.deepEqual([r.w, r.h], [srv.media.width, srv.media.height]);
  assert(r.t >= 1200 && r.t < 1210 && !r.paused, 'playing on after the seek: ' + r.t);
  const reqs = srv.requests({ origin: 'jf', path: `/Videos/${ep.Id}/stream.mkv` }).slice(n0);
  assert(reqs.some((e) => e.status === 206), 'Chrome fetched by Range: ' + reqs.map((e) => e.status).join(','));
});
