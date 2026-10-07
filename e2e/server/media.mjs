/* Fixture media, generated once into the git-ignored e2e/.cache/media/.
 *
 * One long video stands in for every stream (/Videos/{id}/stream…):
 *   fixture-v<N>.webm — 60 min, 320×180 at 2 fps, VP9 ~20 kbit/s with the
 *   presentation time burned in (hh:mm:ss.mmm, top left), a keyframe every
 *   10 s (cheap seeks), mono Opus 440 Hz (60 s encoded once, looped by copy).
 *   ~12.7 MB, ~55–65 s to generate on this machine. Desktop Chrome decodes it,
 *   so the player gets past the loading card, and it is long enough for
 *   resume points (Continue Watching's 20:00), credits and Up Next windows of
 *   every seeded episode (42–56 min). Seeded movies run 80–159 min, longer than
 *   the file: a test that needs a movie's real end shortens its RunTimeTicks
 *   (or uses an episode); the stream simply ends at 60:00.
 *
 * Trickplay sheets are made from that same file the way Jellyfin makes them:
 * one 320×180 thumbnail every 10 s (frame n·20), tiled 10×10 into a
 * 3200×1800 JPEG — sheet k holds thumbnails 100k…100k+99, the last one padded
 * black, exactly the seeded layout (Width 320, Height 180, TileWidth/Height 10,
 * Interval 10000). Thumbnail i therefore shows the burned-in time i·10 s. The
 * file has 4 sheets (360 thumbnails); a seeded item longer than 60 min asks for
 * more, and those indexes wrap (sheet k → k mod 4), still valid JPEGs of the
 * right grid.
 *
 * fixture-v<N>-cut.webm — the first 20 s of that file (stream copy, cut on
 * the 10 s keyframe grid): a download that stopped at 0:20, served by the
 * fake's /api/downloads/{id}/stream for ids in world.ml.cutStreams.
 *
 * fixture-v<N>-trailer/ — the first 30 s as reel-api's trailer job leaves it
 * (trailers.py: ffmpeg -c copy → an HLS event playlist of fMP4 segments):
 * index.m3u8 (complete, #EXT-X-ENDLIST), init.mp4, s000–s002.m4s (10 s each,
 * the keyframe grid); VP9 + Opus, codecs "vp09.00.10.08,opus". Served by the
 * fake's /api/trailers/{key}/{name} for keys in world.ml.trailers.
 *
 * The VTT served for every text subtitle has one cue every 10 s for the whole
 * hour, "Fixture subtitle hh:mm:ss" from t to t+4 s — the same clock the
 * picture shows, so a cue on screen can be checked against the playhead.
 *
 * Without ffmpeg everything here is null and the stream/trickplay routes
 * answer 404 with a note. */
import { existsSync, mkdirSync, renameSync, readdirSync, unlinkSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.cache', 'media');
const V = 1; // bump when the recipe changes: the old files are ignored (and removed)
export const FIXTURE = { duration: 3600, fps: 2, width: 320, height: 180, interval: 10, cols: 10, rows: 10, cut: 20, trailer: 30 };
FIXTURE.sheetCount = Math.ceil(FIXTURE.duration / FIXTURE.interval / (FIXTURE.cols * FIXTURE.rows)); // 4

let memo = null;

function ff(args, timeout = 180000) {
  const r = spawnSync('ffmpeg', ['-v', 'error', '-y', ...args], { cwd: dir, stdio: 'pipe', timeout });
  if (r.status !== 0) throw new Error('ffmpeg ' + args.slice(0, 4).join(' ') + '…: ' + String(r.stderr || r.error || 'failed').slice(0, 400));
}

const pad = (n, w = 2) => String(n).padStart(w, '0');
const hms = (s) => `${pad(Math.floor(s / 3600))}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}`;

/* the subtitle track that lines up with the fixture's burned-in clock */
export function fixtureVtt() {
  let out = 'WEBVTT\n\n';
  for (let t = 0; t < FIXTURE.duration; t += FIXTURE.interval) out += `${hms(t)}.000 --> ${hms(t + 4)}.000\nFixture subtitle ${hms(t)}\n\n`;
  return out;
}

export function ensureMedia() {
  if (memo) return memo;
  const webm = path.join(dir, `fixture-v${V}.webm`);
  const sheet = (k) => path.join(dir, `fixture-v${V}-trick-${k}.jpg`);
  const sheets = Array.from({ length: FIXTURE.sheetCount }, (_, k) => sheet(k));
  const cut = path.join(dir, `fixture-v${V}-cut.webm`);
  const trailerDir = path.join(dir, `fixture-v${V}-trailer`);
  /* the trailer HLS, likewise a stream copy (well under a second) */
  const ensureTrailer = () => {
    const files = ['index.m3u8', 'init.mp4', 's000.m4s', 's001.m4s', 's002.m4s'];
    if (files.every((f) => existsSync(path.join(trailerDir, f)))) return { dir: trailerDir, files, duration: FIXTURE.trailer, codecs: 'vp09.00.10.08,opus' };
    try {
      const tmp = trailerDir + '.tmp';
      mkdirSync(tmp, { recursive: true });
      ff(['-i', webm, '-t', String(FIXTURE.trailer), '-c', 'copy', '-f', 'hls', '-hls_segment_type', 'fmp4', '-hls_time', '2', '-hls_playlist_type', 'event',
        '-hls_fmp4_init_filename', 'init.mp4', '-hls_segment_filename', path.join(tmp, 's%03d.m4s'), path.join(tmp, 'index.m3u8')]);
      renameSync(tmp, trailerDir);
      return ensureTrailer();
    } catch {
      return null;
    }
  };
  /* derived from the full file in well under a second (no re-encode) */
  const ensureCut = () => {
    if (existsSync(cut)) return cut;
    try {
      ff(['-i', webm, '-t', String(FIXTURE.cut), '-c', 'copy', 'cut.tmp.webm']);
      renameSync(path.join(dir, 'cut.tmp.webm'), cut);
      return cut;
    } catch {
      return null;
    }
  };
  if (existsSync(webm) && sheets.every((f) => existsSync(f))) return (memo = { ...FIXTURE, webm, sheets, cut: ensureCut(), trailer: ensureTrailer(), vtt: fixtureVtt() });
  try {
    mkdirSync(dir, { recursive: true });
    // older recipes (and the 30 s sample.webm of the first version)
    for (const f of readdirSync(dir)) if (!f.startsWith(`fixture-v${V}`) || f.includes('.tmp')) rmSync(path.join(dir, f), { recursive: true, force: true }); // (the trailer is a directory)
    const { duration, fps, width, height, interval, cols, rows } = FIXTURE;
    if (!existsSync(webm)) {
      ff(['-f', 'lavfi', '-i', `testsrc2=size=${width}x${height}:rate=${fps}`, '-t', String(duration),
        '-vf', "drawtext=text='%{pts\\:hms}':fontsize=28:fontcolor=white:box=1:boxcolor=black@0.6:x=8:y=8",
        '-c:v', 'libvpx-vp9', '-b:v', '20k', '-deadline', 'realtime', '-cpu-used', '8', '-g', String(fps * interval), '-row-mt', '1', '-an', 'v.tmp.webm']);
      ff(['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '60', '-ac', '1', '-c:a', 'libopus', '-b:a', '6k', 'a.tmp.webm']);
      ff(['-i', 'v.tmp.webm', '-stream_loop', '-1', '-i', 'a.tmp.webm', '-map', '0:v', '-map', '1:a', '-c', 'copy', '-shortest', 'f.tmp.webm']);
      renameSync(path.join(dir, 'f.tmp.webm'), webm);
      for (const f of ['v.tmp.webm', 'a.tmp.webm']) unlinkSync(path.join(dir, f));
    }
    ff(['-i', webm, '-vf', `select='not(mod(n\\,${fps * interval}))',scale=${width}:${height},tile=${cols}x${rows}`, '-fps_mode', 'passthrough', '-an', '-q:v', '6', '-start_number', '0', 'trick-%d.tmp.jpg']);
    sheets.forEach((f, k) => renameSync(path.join(dir, `trick-${k}.tmp.jpg`), f));
    return (memo = { ...FIXTURE, webm, sheets, cut: ensureCut(), trailer: ensureTrailer(), vtt: fixtureVtt() });
  } catch (e) {
    return (memo = { ...FIXTURE, webm: null, sheets: null, cut: null, trailer: null, vtt: fixtureVtt(), error: e.message });
  }
}
