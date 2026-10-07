/* The fixture library for the real-Jellyfin run, made by ffmpeg into the
 * git-ignored integration/jellyfin/.cache/media-v<N>/ once (~10 s), then copied
 * (hard-linked where possible) into each run's temp dir:
 *
 *   Movies/Contract Movie (2020)/Contract Movie (2020).mkv      60 s, the contract file:
 *     HEVC 320×180 · E-AC3 5.1 "eng" (default) · AAC 2.0 "ger" · SRT "eng" · ASS "ger"
 *     · chapters Prologue 0 / Intro 5 / Story 20 / Credits 45 (findMarkers(): intro 5–20, credits 45–60)
 *   Movies/Browser Movie (2021)/Browser Movie (2021).mp4        120 s, H.264 + AAC 2.0, faststart —
 *     what headless Chrome can decode, so the TV bundle plays a real DirectPlay stream (long enough
 *     for MovieDetail's Resume, which needs a position > 30 s)
 *   Shows/Contract Show/Season 01/Contract Show S01E0{1,2}.mkv   30 s each, H.264 + AAC
 *
 * Every file is a test pattern with a sine tone and nothing else; titles come
 * from the folder names (metadata fetchers are off, the run is offline).
 *
 *   ensureFixtures(ffmpeg) → { dir, files: { movie, browser, ep1, ep2 } }   */
import { existsSync, mkdirSync, writeFileSync, rmSync, readdirSync, renameSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const V = 2; // bump when the recipe changes
export const CACHE = path.join(here, '.cache');
const DIR = path.join(CACHE, 'media-v' + V);

export const FIXTURES = {
  movie: { rel: 'Movies/Contract Movie (2020)/Contract Movie (2020).mkv', name: 'Contract Movie', seconds: 60, chapters: [['Prologue', 0], ['Intro', 5], ['Story', 20], ['Credits', 45]] },
  browser: { rel: 'Movies/Browser Movie (2021)/Browser Movie (2021).mp4', name: 'Browser Movie', seconds: 120 },
  ep1: { rel: 'Shows/Contract Show/Season 01/Contract Show S01E01.mkv', series: 'Contract Show', season: 1, episode: 1, seconds: 30 },
  ep2: { rel: 'Shows/Contract Show/Season 01/Contract Show S01E02.mkv', series: 'Contract Show', season: 1, episode: 2, seconds: 30 }
};

function ff(ffmpeg, args, cwd) {
  const r = spawnSync(ffmpeg, ['-v', 'error', '-y', '-nostdin', ...args], { cwd, stdio: 'pipe', timeout: 300000 });
  if (r.status !== 0) throw new Error(`${ffmpeg} ${args.slice(0, 6).join(' ')}…: ${String(r.stderr || r.error || 'failed').slice(0, 600)}`);
}

const srt = (lang) => Array.from({ length: 6 }, (_, i) => `${i + 1}\n00:00:${String(i * 10 + 1).padStart(2, '0')},000 --> 00:00:${String(i * 10 + 4).padStart(2, '0')},000\nFixture subtitle ${lang} ${i * 10} s\n`).join('\n');
const ass = () => `[Script Info]
ScriptType: v4.00+
PlayResX: 320
PlayResY: 180

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,16,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,1,0,2,10,10,10,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
${Array.from({ length: 6 }, (_, i) => `Dialogue: 0,0:00:${String(i * 10 + 2).padStart(2, '0')}.00,0:00:${String(i * 10 + 5).padStart(2, '0')}.00,Default,,0,0,0,,Untertitel ${i * 10} s`).join('\n')}
`;

function chaptersMeta(list, total) {
  let s = ';FFMETADATA1\n';
  list.forEach(([title, at], i) => {
    const end = i + 1 < list.length ? list[i + 1][1] : total;
    s += `[CHAPTER]\nTIMEBASE=1/1000\nSTART=${at * 1000}\nEND=${end * 1000}\ntitle=${title}\n`;
  });
  return s;
}

export function ensureFixtures(ffmpeg = 'ffmpeg') {
  const files = Object.fromEntries(Object.entries(FIXTURES).map(([k, f]) => [k, path.join(DIR, f.rel)]));
  if (Object.values(files).every((f) => existsSync(f))) return { dir: DIR, files, cached: true };
  mkdirSync(CACHE, { recursive: true });
  for (const d of readdirSync(CACHE)) if (d.startsWith('media-') && d !== 'media-v' + V) rmSync(path.join(CACHE, d), { recursive: true, force: true });
  const tmp = DIR + '.tmp';
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  const at = (rel) => {
    mkdirSync(path.dirname(path.join(tmp, rel)), { recursive: true });
    return path.join(tmp, rel);
  };
  const video = (sec) => ['-f', 'lavfi', '-i', `testsrc2=size=320x180:rate=10:duration=${sec}`];
  const tone = (sec, layout, freq) => ['-f', 'lavfi', '-i', `sine=frequency=${freq}:sample_rate=48000:duration=${sec},aformat=channel_layouts=${layout}`];

  // the contract movie
  const m = FIXTURES.movie;
  writeFileSync(path.join(tmp, 'en.srt'), srt('en'));
  writeFileSync(path.join(tmp, 'de.ass'), ass());
  writeFileSync(path.join(tmp, 'chapters.txt'), chaptersMeta(m.chapters, m.seconds));
  ff(ffmpeg, [
    ...video(m.seconds), ...tone(m.seconds, '5.1', 440), ...tone(m.seconds, 'stereo', 660),
    '-i', 'en.srt', '-i', 'de.ass', '-f', 'ffmetadata', '-i', 'chapters.txt',
    '-map', '0:v', '-map', '1:a', '-map', '2:a', '-map', '3:s', '-map', '4:s', '-map_chapters', '5',
    '-c:v', 'libx265', '-preset', 'ultrafast', '-x265-params', 'log-level=error:keyint=20', '-pix_fmt', 'yuv420p',
    '-c:a:0', 'eac3', '-b:a:0', '384k', '-c:a:1', 'aac', '-b:a:1', '128k', '-c:s:0', 'srt', '-c:s:1', 'ass',
    '-metadata:s:a:0', 'language=eng', '-metadata:s:a:0', 'title=English', '-disposition:a:0', 'default',
    '-metadata:s:a:1', 'language=ger', '-metadata:s:a:1', 'title=Deutsch', '-disposition:a:1', '0',
    '-metadata:s:s:0', 'language=eng', '-metadata:s:s:1', 'language=ger', '-disposition:s:0', '0', '-disposition:s:1', '0',
    at(m.rel)
  ], tmp);
  // what Chrome can decode
  const b = FIXTURES.browser;
  ff(ffmpeg, [...video(b.seconds), ...tone(b.seconds, 'stereo', 550), '-map', '0:v', '-map', '1:a',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '20', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k',
    '-metadata:s:a:0', 'language=eng', '-movflags', '+faststart', at(b.rel)], tmp);
  for (const k of ['ep1', 'ep2']) {
    const e = FIXTURES[k];
    ff(ffmpeg, [...video(e.seconds), ...tone(e.seconds, 'stereo', 500 + e.episode * 50), '-map', '0:v', '-map', '1:a',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '20', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k',
      '-metadata:s:a:0', 'language=eng', at(e.rel)], tmp);
  }
  for (const f of ['en.srt', 'de.ass', 'chapters.txt']) rmSync(path.join(tmp, f));
  rmSync(DIR, { recursive: true, force: true });
  renameSync(tmp, DIR);
  return { dir: DIR, files, cached: false };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const t0 = Date.now();
  const r = ensureFixtures(process.argv[2] || 'ffmpeg');
  console.error(`[fixtures] ${r.cached ? 'cached' : 'made in ' + (Date.now() - t0) + ' ms'}: ${r.dir}`);
  console.log(r.dir);
}
