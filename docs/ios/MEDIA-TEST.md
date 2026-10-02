# iPhone media test — what Jellyfin's HLS remux gives iOS Safari

Measured 2026-09-29 against the real server (Jellyfin **12.1.0**, jellyfin-ffmpeg 8.1.2) and
the real library (288 movies/episodes), with the DeviceProfile below, DeviceId
`reel-mediatest`. For every case: `POST /Items/{id}/PlaybackInfo` → the decision →
`master.m3u8` → variant playlist → init segment + first media segment fetched and
inspected (MP4 box walk of the init segment, ffprobe of init+segment, the ffmpeg command
line from the server's `FFmpeg.*.log`). Every job was stopped with
`DELETE /Videos/ActiveEncodings`; nothing reported progress. Re-run the same checks
through the tailnet origin's `/jf` prefix: identical results (see "Through /jf").

**This is server-side truth only.** Nothing here was played on an iPhone — see the
checklist at the end.

## Library inventory (what has to play)

Titles are anonymised: *Series A–H* and *Film A–G* each name one show or film and mean the
same one everywhere in this document.

| Video | Range | Files | Notes |
|---|---|---|---|
| HEVC Main 10 | SDR | 108 | mostly 1080p/1440p series |
| HEVC Main 10 | **DV 8.1** (DOVIWithHDR10) | 71 | 1 of them is `.mp4` tagged **`hev1`** (Film D) |
| H.264 | SDR | 63 | 1080p WEB-DL + Blu-ray |
| HEVC Main 10 | DV 8.1 + HDR10+ | 26 | |
| HEVC Main 10 | **DV 5** (DOVI, no HDR10 fallback) | 14 | Series F, Series C S1 |
| HEVC Main 10 | HDR10 / HDR10+ | 4 | |
| AV1 | SDR / DV 10.1 | 2 | Film E, Film F (both Opus audio) |

No **DV profile 7** (UHD-BD dual layer) and no VC-1/MPEG-2 in the library today.
Audio tracks: AC3 92, E-AC3 87 + E-AC3 Atmos 78, DTS-HD MA 73, DTS 39, Opus 6, FLAC 5,
AAC 3, TrueHD Atmos 1. Subtitles: SRT 423 (+147 external), PGS 93, mov_text 37, VobSub 1.

## Results

Every file came back as **HLS fMP4 via `TranscodingUrl`** (`/videos/{id}/master.m3u8`,
`SegmentContainer=mp4`) — no DirectPlay/DirectStream (all mkv; the one mp4 is `hev1`).
"Remux" = Jellyfin's `FFmpeg.Remux` job: `-codec:v:0 copy -codec:a:0 copy`, zero
re-encoding, CPU ≈ nothing. First segment answered in 0.2–2.5 s cold.

### Video

| Case | Decision (TranscodeReasons) | Video | Init sample entry | Master CODECS | Verdict |
|---|---|---|---|---|---|
| H.264 1080p SDR (Series A) | ContainerNotSupported | **copy** | `avc1` + avcC | `avc1.4D4028` | ✅ |
| HEVC 10-bit 1080p SDR (Series B) | ContainerNotSupported | **copy**, `-tag:v hvc1` | `hvc1` + hvcC | `hvc1.2.4.L120.B0` | ✅ |
| HEVC 4K HDR10 / HDR10+ (Film B, Series C) | ContainerNotSupported | **copy**, `hvc1` | `hvc1` + hvcC + colr (PQ) | `hvc1.2.4.L15x.B0`, `VIDEO-RANGE=PQ` (+ an SDR-labelled twin) | ✅ |
| **DV 8.1** 4K (Series D, Series E) | ContainerNotSupported | **copy**, `-tag:v dvh1 -strict -2` | `dvh1` + hvcC + **dvvC** + colr | `hvc1.2.4.L150.B0` + `SUPPLEMENTAL-CODECS="dvh1.08.06/db1p"`, PQ | ✅ server-side (Apple-style signalling) |
| DV 8.1 + HDR10+ (Series C S2) | ContainerNotSupported | copy, dvh1, bsf `remove_hdr10plus=1` | `dvh1` + dvvC | same as DV 8.1 | ✅ (HDR10+ SEI stripped, DV kept) |
| **DV 5** 4K (Series F) | ContainerNotSupported | **copy**, dvh1 | `dvh1` + hvcC + **dvcC** | variant 1 `dvh1.05.06`; variant 2 `hvc1…` PQ | ✅ on a DV device (current iPhones). Variant 2 would be wrong colours on a non-DV client — irrelevant here |
| DV 8.1 **mp4 tagged `hev1`** (Film D) | **VideoCodecTagNotSupported** | copy, **retagged `dvh1`** | `dvh1` + dvvC | DV 8.1 as above | ✅ `hev1` problem solved by the remux. ⚠️ playlist uses nominal 6.000 s segments (no keyframe index for mp4), real first segment 7.26 s — see Known issues |
| AV1 1080p SDR + Opus (Film E) | +VideoCodecNotSupported, AudioCodecNotSupported | **transcode** `hevc_qsv` (VAAPI decode), 3 s segments | `hvc1` | `hvc1.1.4.L150.B0`, SDR | ⚠️ works, but a real transcode (1st segment 2.2 s) |
| AV1 4K **DV 10** + Opus (Film F) | same | **transcode** hevc_qsv, **tone-mapped to SDR 8-bit** | `hvc1` | SDR | ⚠️ loses HDR/DV; 1st segment 6.3 s |
| AV1 with `av1` + `opus` allowed in the profile | ContainerNotSupported | **copy** (`av01`/`dav1`), Opus copy | `av01` + av1C, `Opus` + dOps | `av01.0.08M.10,Opus`; DV10: `SUPPLEMENTAL-CODECS="dav1.10.06/db1p"` | ✅ server-side — only offer on an iPhone that decodes AV1 in hardware (15 Pro / 16+) |

`hevc-level` in the URL is capped by the profile's `VideoLevel` (183 = 6.1): 4K files are
L150/L153, all fine. No file exceeds 60 fps.

### Audio (with the profile's `AudioCodec: eac3,ac3,aac,flac,alac`, MaxAudioChannels 8)

| Source track | Result | Init entry | Notes |
|---|---|---|---|
| E-AC3 5.1 / **E-AC3 Atmos** (5.1 and 7.1-labelled) | **copy** | `ec-3` + dec3 | Atmos JOC survives (profile string intact). MaxAudioChannels must stay **8**: with 6 the 8-ch DD+ of Film G was re-encoded to AC3 5.1 (verified) |
| AC3 | **copy** | `ac-3` | |
| AAC LC 5.1, **HE-AAC** 2.0 | **copy** | `mp4a` (`mp4a.40.2` / `mp4a.40.5`) | |
| FLAC 5.1 (Series E S4) | **copy** | `fLaC` + dfLa | Safari supports FLAC-in-fMP4 — verify on device (checklist) |
| **DTS-HD MA / DTS:X 7.1 / DTS 5.1** | **re-encode → AC3 5.1 640 kbit/s** (`FFmpeg.DirectStream`: video still copied) | `ac-3` | Jellyfin picks AC3 over E-AC3 for surround even with eac3 listed first |
| DTS-HD MA 2.0 (Series G) | re-encode → **AAC LC 2.0 384 kbit/s** | `mp4a` | |
| **TrueHD Atmos 7.1** (Film G, when selected) | re-encode → **AC3 5.1 640 kbit/s** | `ac-3` | Atmos lost. The same file's E-AC3 Atmos track copies — the engine must prefer it (the TV's `score()` already does) |
| Opus 5.1 | re-encode → AC3 5.1 (copy if `opus` is allowed) | | only the 2 AV1 files |

### Subtitles

| Track | DeliveryMethod | URL (root-relative → prefix with `cfg.server`) |
|---|---|---|
| SRT (embedded or external), mov_text | **External**, converted | `/Videos/{id}/{msid}/Subtitles/{i}/0/Stream.vtt?ApiKey=…` |
| **PGS** | **External** (raw) | `…/Subtitles/{i}/0/Stream.pgssub?ApiKey=…` → libpgs on a canvas, as on the TV. Video stays copied |
| **VobSub (DVDSUB)** | **Encode** (burn-in) | video becomes a real transcode: `hevc_qsv`, 3 s segments, **HDR10 source tone-mapped to SDR**, 1st segment 5.3 s. Same as the TV's burn-in fallback |

Subtitles are never muxed into the HLS stream (`-map -0:s`), so text tracks are the
engine's job (blob `<track>` as on the TV).

### Start position / seeking

- `StartTimeTicks` in PlaybackInfo does **not** end up in `TranscodingUrl`; the variant
  playlist always lists the **whole file from 0** (no `EXT-X-START`). Resume = load the
  master, then set `video.currentTime = resumeSec` (Safari fetches that segment).
- Requesting segment *N* restarts ffmpeg with `-ss <segment start> -start_number N` and
  `-copyts`: the fragment's timestamps are **absolute** (resume at 600 s → segment 99,
  `start_time` 594.5; at 1200 s → segment 200, `start_time` 1199.97). Seeking is exact
  to the keyframe before the target; 1st segment after a jump arrived in 1.2–1.5 s.
- Segment lengths: `-hls_time 6` for remux; the playlist uses the real keyframe positions
  for mkv sources (e.g. 8.008, 10.427, 4.004 s …), so `EXTINF` matches the fragments
  (checked: 7.007 vs 7.048 s, 6.006 vs 6.005 s). `EXT-X-TARGETDURATION` can be large
  (47 s on Series D E1 — one long GOP somewhere) — legal, only matters for startup at
  that point. Transcodes use 3 s segments.

### Auth inside the playlists

`ApiKey=` is carried on every URI Jellyfin writes (variant, `EXT-X-MAP`, segments), so
Safari's native player — which can't send an `Authorization` header — fetched all of them
header-less (verified). The master also carries `#EXT-X-IMAGE-STREAM-INF` pointing at
`Trickplay/320/tiles.m3u8` (Jellyfin's trickplay as an HLS image stream).

### Through `/jf` (tailnet origin)

Same PlaybackInfo + master + variant + init + segment fetched via
`https://nas.<tailnet>.ts.net:9443/jf/…` for DV 8.1 (copy) and HDR10 + DTS→AC3 + PGS:
identical decisions and bytes. `tailscale serve` strips `/jf`; every URI inside the
playlists is **relative** (`main.m3u8?…`, `hls1/main/0.mp4?…`), so they resolve under
`/jf/videos/{id}/` automatically. Only the root-relative URLs in the JSON
(`TranscodingUrl`, subtitle `DeliveryUrl`) need `cfg.server` prefixed.

## Recommended DeviceProfile

Send with every PlaybackInfo (`MaxStreamingBitrate` 200 000 000 on Wi-Fi; the cellular cap
lowers it — that forces a real transcode). This is exactly what was tested:

```json
{
  "Name": "VibeReel Phone (iOS Safari)",
  "MaxStreamingBitrate": 200000000,
  "MaxStaticBitrate": 200000000,
  "MusicStreamingTranscodingBitrate": 384000,
  "DirectPlayProfiles": [
    { "Container": "mp4,m4v,mov", "Type": "Video", "VideoCodec": "h264,hevc", "AudioCodec": "aac,ac3,eac3,flac,alac,mp3" },
    { "Container": "hls", "Type": "Video", "VideoCodec": "hevc,h264", "AudioCodec": "eac3,ac3,aac,flac,alac" }
  ],
  "TranscodingProfiles": [
    { "Container": "mp4", "Type": "Video", "Protocol": "hls", "Context": "Streaming",
      "VideoCodec": "hevc,h264", "AudioCodec": "eac3,ac3,aac,flac,alac",
      "MaxAudioChannels": "8", "MinSegments": 2, "BreakOnNonKeyFrames": true },
    { "Container": "mp4", "Type": "Video", "Protocol": "http", "Context": "Static",
      "VideoCodec": "h264", "AudioCodec": "aac" }
  ],
  "ContainerProfiles": [],
  "CodecProfiles": [
    { "Type": "Video", "Codec": "h264", "Conditions": [
      { "Condition": "EqualsAny", "Property": "VideoProfile", "Value": "high|main|baseline|constrained baseline", "IsRequired": false },
      { "Condition": "EqualsAny", "Property": "VideoRangeType", "Value": "SDR", "IsRequired": false },
      { "Condition": "LessThanEqual", "Property": "VideoLevel", "Value": "52", "IsRequired": false },
      { "Condition": "NotEquals", "Property": "IsInterlaced", "Value": "true", "IsRequired": false } ] },
    { "Type": "Video", "Codec": "hevc", "Conditions": [
      { "Condition": "EqualsAny", "Property": "VideoProfile", "Value": "main|main 10", "IsRequired": false },
      { "Condition": "EqualsAny", "Property": "VideoRangeType", "Value": "SDR|HDR10|HDR10Plus|HLG|DOVI|DOVIWithHDR10|DOVIWithHLG|DOVIWithSDR|DOVIWithHDR10Plus", "IsRequired": false },
      { "Condition": "LessThanEqual", "Property": "VideoLevel", "Value": "183", "IsRequired": false },
      { "Condition": "NotEquals", "Property": "IsInterlaced", "Value": "true", "IsRequired": false },
      { "Condition": "LessThanEqual", "Property": "VideoFramerate", "Value": "60", "IsRequired": true } ] },
    { "Type": "Video", "Codec": "hevc", "Container": "mp4,m4v,mov", "Conditions": [
      { "Condition": "EqualsAny", "Property": "VideoCodecTag", "Value": "hvc1|dvh1", "IsRequired": true } ] }
  ],
  "SubtitleProfiles": [
    { "Format": "vtt", "Method": "External" },
    { "Format": "pgssub", "Method": "External" }
  ],
  "ResponseProfiles": [ { "Type": "Video", "Container": "m4v", "MimeType": "video/mp4" } ]
}
```

Why each part:

- **mkv never direct-plays** on iOS, so every mkv goes HLS; the `hls` DirectPlay entry is
  jellyfin-web's convention (only matters for sources that are HLS themselves).
- **fMP4 (`Container: mp4`), not TS**: Safari won't take HEVC in MPEG-TS HLS, and DV/HDR
  signalling needs the fMP4 init segment.
- `VideoCodec` order `hevc,h264` makes a *forced* transcode (AV1, VobSub burn-in,
  cellular cap) produce HEVC via QSV. Swap to `h264,hevc` if an older phone must play the
  transcodes.
- **Range types**: everything an iPhone with DV can show. `DOVIWithEL`/`DOVIInvalid` are
  deliberately absent — DV 7 (dual layer) must fall back (see Known issues).
- `VideoCodecTag hvc1|dvh1` only on the mp4 container profile: an `hev1` mp4 then remuxes
  (retagged) instead of direct-playing into a black screen. The remux always writes
  `hvc1`/`dvh1` itself.
- `MaxAudioChannels "8"`: copies 7.1-labelled DD+ Atmos untouched.
- No `ass`/`ssa` → Jellyfin converts them to VTT (External). No `vobsub`/`dvdsub` →
  burn-in (Encode).
- The static `http` profile is only a fallback Jellyfin wants to see; it isn't used for video.

### Build it at runtime, don't hard-code the capability bits

On the phone derive three things from `canPlayType` like jellyfin-web does, and keep the
rest fixed:

- `hevc` `VideoLevel`: `hvc1.2.4.L186` → 186, `L183` → 183, `L153` → 153 (all iPhones since
  the XS answer at least L153; every file here is ≤ L153).
- **AV1**: if `canPlayType('video/mp4; codecs="av01.0.15M.10"')` is non-empty (A17 Pro /
  M-series and later) put `av1` first in both `VideoCodec` lists plus an `av1` CodecProfile
  with the same range types, and add `opus` to `AudioCodec` — then the two AV1 files copy
  instead of transcoding. (Tested: Jellyfin copies AV1 + Opus into fMP4 cleanly.)
- **Dolby Vision**: drop the `DOVI*` range types if `canPlayType('video/mp4;
  codecs="dvh1.08.06"')` is empty (no current iPhone). DV 8.1 then plays as HDR10;
  **DV 5 would then need a real transcode** (Jellyfin tone-maps it), so keep `DOVI` only
  when `dvh1.05.06` answers.

## Known failures and what to do

| Problem | Effect | Do |
|---|---|---|
| **DV profile 7** (UHD-BD remux, dual layer) | none in the library today. With the profile above it matches no range type → Jellyfin transcodes (tone-map → SDR HEVC) | fine as-is. If such files appear and should keep HDR: add `DOVIWithEL` to the hevc range types — Jellyfin then copies the BL (HDR10-compatible) and drops the EL; test first |
| **`hev1`-tagged HEVC in mp4** | would be a black/failed direct play in Safari | handled: the codec-tag condition forces the remux, which retags to `hvc1`/`dvh1` |
| mp4 sources have **no keyframe index** → nominal 6.000 s `EXTINF` while real fragments are cut at keyframes (7.26 s on Film D) | playlist timeline drifts from the media; seeks can land a few seconds off, possible stall at a segment boundary | only 1 file. If it misbehaves on the phone: remux it to mkv on the NAS (`ffmpeg -c copy`) — mkv gets exact segment lengths from the Matroska cues |
| **TrueHD Atmos** / **DTS** | re-encoded to AC3 5.1 640k (DTS 2.0 → AAC); Atmos lost for TrueHD | engine prefers a same-language E-AC3/AC3/AAC track when present (TV `score()` does this); otherwise the AC3 conversion is fine. Video stays copied |
| **AV1** without hardware decode | full transcode on the N150's QSV, SDR tone-map for the DV10 title | acceptable (2 files); AV1-capable iPhones copy via the runtime branch |
| **VobSub burn-in** | full transcode, HDR → SDR | as on the TV; libbitsub (`.mks` extraction, 12.x) is the upgrade path |
| HDR10+ dynamic metadata | stripped from DV 8.1+HDR10+ files (bsf) | nothing to do — DV carries the dynamic metadata |
| DV 5 **fallback variant** (`hvc1`, PQ) | would show wrong colours on a non-DV client | irrelevant for iPhones (all DV-capable) |

## Must verify on the real iPhone

1. **DV 8.1** (Series D E1): plays, and the Dolby Vision badge/brightness behaviour
   appears (Safari picks the `SUPPLEMENTAL-CODECS` DV path, not plain HDR10).
2. **DV 5** (Series F S1E1): plays with correct colours (not purple/green) — confirms
   the `dvh1.05.06` variant is chosen.
3. HDR10 4K (Film B): HDR, no stutter at 20–32 Mbit/s over the tailnet (LAN direct vs
   DERP relay — check `tailscale status` shows *direct*).
4. **E-AC3 Atmos** (Series C S2): sound on the speaker, spatial audio with AirPods; the
   8-channel DD+ of Film G too.
5. **FLAC 5.1** (a Series E S4 episode): audio present (FLAC-in-fMP4-HLS).
6. **HE-AAC** 2.0 track (Film C, track 2): audio present.
7. Resume at an arbitrary point (set `currentTime` after load): lands within one GOP,
   no A/V desync; a long seek recovers in ≤ 2 s.
8. PGS via libpgs and SRT via `<track>` stay in sync after a seek.
9. VobSub burn-in (Film C, DVD sub) starts within ~6 s.
10. PiP and AirPlay from the custom player with an HLS remux source (AirPlay to the LG
    hands the URL over — the `ApiKey` in it must stay valid).
11. The one `hev1` mp4 (Film D): plays, seeking works.
12. With the phone screen locked / app backgrounded: Jellyfin's ffmpeg job is stopped
    when the engine stops (no orphan `FFmpeg.Remux` on the NAS; `pgrep ffmpeg`).

## Re-running this test

The scripts live in the session scratchpad (not in the repo): `mt/probe.py` (one case),
`mt/batch.py` (a JSON list of cases), `mt/profile.py` (the profile above as Python). They
read the TV account from `tvcreds.json`, never print the token, read the ffmpeg command
line from `/var/lib/jellyfin/log/FFmpeg.*_{itemId}_*.log` over `ssh nas sudo`, and stop
each job afterwards.

## Found on the real iPhone (2026-09-29)

- **Never hand Safari `master.m3u8` for an HDR/HEVC source.** Jellyfin's master lists the
  stream copy (VIDEO-RANGE=PQ) *plus* an SDR HEVC re-encode and an H.264 re-encode at the same
  BANDWIDTH. Safari hops between variants; every hop restarts the single server job, and a 4K
  re-encode runs at 0.3–0.9× — the start hung on the loading card (Film A, Film C,
  Series H; SDR Series B has one variant and played). The player now loads
  `main.m3u8` with the master's query = the first variant = the copy. Verified: `-codec:v copy`.
  The tests above fetched the first variant directly, which is why they missed it.
- DV profile 8 ranges (`DOVIWithHDR10|HLG|SDR|HDR10Plus`) are declared unconditionally: the
  base layer plays on any iPhone even if Safari answers the `dvh1` probe with "".
- **No Picture in Picture in the home-screen app.** iOS refuses it for a standalone web app
  (`requestPictureInPicture` → "The video element does not support the Picture-in-Picture mode",
  swipe-home doesn't float the video); the same page in a Safari tab has PiP, including auto-PiP
  on swipe-home (`autopictureinpicture`). The player hides its PiP button when
  `navigator.standalone`; the installed app pauses on backgrounding instead.

## Quality cap (Settings → Streaming quality, 8 / 4 Mbit/s)

Measured 2026-09-29 with the real `phoneProfile()` (evaluated from `tracks.js`) and the phone's
PlaybackInfo body, DeviceId `reel-qualitytest`, loading `main.m3u8` as the player does. "×" =
media seconds produced per wall second fetching segments back to back for 30 s (≈ ffmpeg's own
`speed=`); "first" = PlaybackInfo → init + segment 0 received; "seek" = segment at mid-file
requested cold (Jellyfin restarts ffmpeg with `-ss`) → received. Every job stopped, UserData
unchanged (fetching HLS never records playback — confirmed 2026-09-30 with a whole offline
download, 558 segments, and the phone's own DeviceId; only `Sessions/Playing*` does). NAS: Intel N95, QSV (VAAPI decode, OpenCL bt2390 tone-map, `h264_qsv` veryfast).

**Why H.264 and a resolution box** — Film A (4K HDR10, 36 Mbit/s, DTS-HD MA) at 8 Mbit/s:

| Output | × | first | seek |
|---|---|---|---|
| Jellyfin's own pick (profile unchanged): HEVC, 2560×1440 from its bitrate table | 1.7 | 6.9 s | 7.6 s |
| HEVC 1080p | 2.4 | 4.5 s | 6.3 s |
| **H.264 1080p** (shipped for 8) | **4.1–4.2** | 2.8 s | 4.2–4.3 s |
| HEVC 720p (4 Mbit/s) | 4.0 | 2.9 s | 4.3 s |
| **H.264 720p** (shipped for 4) | **6.2–6.6** | 2.0–2.3 s | 3.9 s |

`hevc_qsv` costs ~1.7× the time of `h264_qsv` here (low-power VDENC encoders are off in
`encoding.xml`). HDR can't be kept: Jellyfin 12.1 keeps HDR only on stream copy; any QSV
transcode of an HDR/DV source is tone-mapped to 8-bit SDR (`IsHwTonemapAvailable` only asks
whether the source is HDR and tone-mapping is on), so there is no "HDR10 at 1080p" option.

**Shipped profile under a cap**: transcoding `VideoCodec` `h264,hevc` (H.264 is the encode
target; HEVC/AV1 still listed so a file *under* the cap is copied), `Conditions` Width/Height
≤ 1920×1080 (8) / 1280×720 (4) — StreamBuilder applies those only when it re-encodes the video,
so they reach the URL as `MaxWidth`/`MaxHeight`; at 4 Mbit/s `AudioCodec aac` +
`MaxAudioChannels 2` (else DTS/TrueHD → AC3 5.1 at 640 kbit/s eats a sixth of the budget).

| File | Cap | Output | × | first | seek (1st / 3 segs) |
|---|---|---|---|---|---|
| Film A — 4K HDR10 HEVC 36 Mbit/s, DTS-HD MA 5.1 | 8 | H.264 1920×1080 SDR, AC3 5.1 640k; 5.8 Mbit/s | 4.2 | 2.8 s | 4.3 / 5.8 s |
| | 4 | H.264 1280×720 SDR, AAC 2.0 256k; 3.1 Mbit/s | 6.2 | 2.3 s | 3.9 / 5.0 s |
| Series E S1E1 — 4K **DV 8.1** 25.5 Mbit/s, DTS-HD MA 5.1 | 8 | H.264 1080p SDR, AC3 5.1; 7.6 Mbit/s | 4.0 | 2.9 s | 4.3 / 5.9 s |
| | 4 | H.264 720p SDR, AAC 2.0; 3.8 Mbit/s | 6.2 | 2.8 s | 3.0 / 4.0 s |
| Series D E1 — 4K DV 8.1 16 Mbit/s, E-AC3 5.1 | 8 | H.264 1080p SDR, **E-AC3 copied**; 8.0 Mbit/s | 4.1 | 2.3 s | 2.8 / 4.2 s |
| Series F S1E1 — 4K **DV 5** 22 Mbit/s, E-AC3 Atmos | 8 | H.264 1080p SDR (full range, colours checked on a frame), E-AC3 copied | 3.6 | 3.4 s | 3.4 / 5.1 s |
| Film B — 4K HDR10 26 Mbit/s, DTS:X 7.1 | 8 | H.264 1920×802 SDR, AC3 5.1 | 5.4 | 4.3 s | 3.7 / 4.8 s |
| Series A E1 — H.264 1080p 4.3 Mbit/s, E-AC3 2.0 | 8 | **copy** (fits) | — | 0.4 s | 0.1 s |
| | 4 | H.264 720p, AAC 2.0 | 14.8 | 0.9 s | 1.2 / 1.5 s |
| Series B — HEVC 10-bit 1080p SDR 6.3 Mbit/s, E-AC3 5.1 | 8 | **copy** (fits) | — | 0.7 s | 0.1 s |
| | 4 | H.264 720p, AAC 2.0 | 12.5 | 1.5 s | 1.4 / 1.9 s |
| Series G — HEVC 1440p SDR 4.1 Mbit/s, DTS-HD MA 2.0 | 8 | video copy, DTS → AAC 2.0 256k | — | 0.9 s | 0.0 s |
| | 4 | H.264 966×720, AAC 2.0 | 16.2 | 0.8 s | 1.3 / 1.7 s |

End to end in headless Chrome 154 (native HLS, H.264/AAC only) through the dev proxy, with the
real player code: Film C (4K HDR10) at 8 Mbit/s → first frame 3.6 s, 1920×804,
info line "1080p · 8 Mbit/s (reduced)"; a seek to 30:00 playing again after 3.3 s; switching
to 4 Mbit/s in the player restarted at 30:00 and played 1280×536 after 1.8 s. Film A at
4 Mbit/s: first frame 4.0 s, seek 3.8 s.

The slow-link hint and the stall card compare the link against the cap (not the file's
bitrate) when the stream is re-encoded; the encoder is ≥ 3.6× real time even on the heaviest
files, so a ring on a capped stream is the network, not the NAS (unless the NAS is busy with
other transcodes at the same time — untested).
