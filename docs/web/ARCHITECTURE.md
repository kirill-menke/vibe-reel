# VibeReel Web: architecture

The desktop web client (`web/`) is the iPhone PWA's screens and the shared `src/lib`
engine under a desktop shell, for Chrome and Firefox with a mouse and a keyboard. It is
served from one HTTPS origin together with Jellyfin (`/jf`) and reel-api (`/ml`), like the
phone app, and streams Jellyfin's HLS fMP4 remux through Media Source Extensions.

## Build: one more flavour of the phone build

```sh
npx vite build --config web/vite.config.js     # → web/dist (hashed assets)
npx vite --config web/vite.config.js           # dev server, http://127.0.0.1:8910
```

- **Defines.** `__PHONE__: true, __WEB__: true`. The TV build defines both `false`, the
  phone build `__WEB__: false`. Web-only code sits behind `__PHONE__ && __WEB__`, or
  `__WEB__` inside a `__PHONE__` branch, so both other bundles constant-fold it away. They
  stay **byte-identical** to a tree without the web client. A scratch build of the TV
  `app.js`/`style.css` and of the whole `phone/dist`, md5-compared before and after, is the
  check.
- **Svelte markup.** Svelte never folds a constant into its static template, so
  `<p>{__WEB__ ? 'In this browser' : 'On this iPhone'}</p>` would move the phone bundle.
  `vite.svelte-consts.js` (in both the phone and web configs) folds
  `{__WEB__ ? '…' : '…'}` in markup to plain text, and `__WEB__ ? '…' : '…'` in expressions
  to the chosen literal, before the compiler runs.
- **Identity.** Jellyfin lists the client as `VibeReel Web` on device `Web`. DeviceIds start
  `reelweb-` (`src/lib/api.js`, `config.js`), so a browser never shares a device row with
  the iPhone app.
- **Module redirects** (`web/vite.config.js`, matched on the *resolved* path like the
  phone's). The phone's three apply: `nav.svelte.js` becomes the phone router shim,
  `focus.js` the no-op shim, and `lifecycle.js` becomes `web/src/lib/lifecycle.js`.
  `WEB_SWAPS` turns phone-only machinery into inert stubs (`offline`, `homesnap`, `push`,
  `restore`). The desktop variants of `gestures.js`, `Sheet`, `TopBar` and `Rail` keep the
  phone props.
- **Target** `es2022`. `phone/public` is shared (fonts, favicon). The service worker,
  launch images, manifest and touch icons are pruned from `web/dist`, because the web MVP
  has no service worker.
- **Tests.** vitest project `web` (`test/web/**`, phone redirects + `__WEB__: true`); ratchet project `web` (ceiling 0).

## The shell (`web/src`)

- `App.svelte` is the desktop shell. It shows `WebNav` instead of the tab bar, keeps every
  route of every tab stack mounted (only the active top is visible), and renders sheets as
  popovers or dialogs. It also hosts `WebPlayer` (always mounted: the `<video>` survives
  across playbacks), Login, the toast and the offline banner.
- `screens.js` / `sheets.js` hold the phone's registries, minus Downloads and the offline
  sheet. Settings is the web's own.
- `lib/urlsync.svelte.js` mirrors the phone router into the address bar and history:
  `/movies`, `/shows`, `/search?q=`, `/movie/<id>`, `/show/<id>`, `/item/<id>`,
  `/person/<id>`, `/lookup/<type>/<id>`, `/settings`, `/my-library`. Back/Forward, reloads
  and deep links work, and the player gets a history entry of its own, so the browser's
  Back closes it.
- `lib/lifecycle.js`: switching tab or window leaves a playing video alone. Only `pagehide`
  stops playback, with Stopped sent as `keepalive`. Back after an absence of more than
  60 s, it rechecks the server and the token.
- `player/WebPlayer.svelte` maps the mouse and keyboard onto `src/lib/player.svelte.js`:
  - Space or K: play/pause. ← → or J L: ∓10 s. 0–9: jump to 0–90 %. ↑ ↓: volume.
    M: mute. C: subtitles. S: skip intro/recap. Shift+N: next episode.
    F: full screen. P: Picture in Picture. ?: the list of shortcuts.
  - Esc: closes the shortcut list, else a panel, else leaves full screen, else the
    player. In full screen the browser takes Esc itself and only leaves full screen.
  - The key map is `player/shortcuts.js` (pure, pinned by
    `test/web/shortcuts.web.test.js`); it also feeds the "?" list. Keys that change
    nothing visible in the bar flash on the picture: play/pause, ∓N s (adding up
    while the key repeats), the volume %, the time a digit jumped to.
  - Mouse: a click on the picture pauses, a double click toggles full screen, the
    wheel over the speaker sets the volume (remembered in `reel.web.volume`). The
    controls and cursor hide after the engine's idle timeout or when the pointer
    leaves the window; the cursor stays over a loading or error card. Every button
    has a tooltip naming its key.
  - Scrubber: a lighter fill and a hover preview (trickplay, chapter, time) follow
    the pointer. The bar's clock shows elapsed / total; a click flips it to time left.
  - The phone's Track/Chapter panels are popovers over the right end of the bar; a
    click anywhere outside closes them (on the picture without pausing). The Up Next
    card is the phone's.
  - PiP: the button and P exist where the API does (Chrome, Firefox 156). There the
    `<video>` carries `disablePictureInPicture` while not in PiP, which hides
    Firefox's own "Pop out this video" toggle over the picture; our request lifts it
    first.

## Hosting: `vr.kirill.es`

The NAS serves `/var/lib/vibereel-web/current` (a symlink to `releases/<stamp>/`) through
nginx. Jellyfin is at `/jf`, reel-api at `/ml`, and every unknown path falls back to
`index.html`. The nginx/ACME/tunnel configuration lives in the NAS's NixOS config, not in
this repo.

- **At home**, an AdGuard Home DNS rewrite points the name at the NAS. nginx terminates TLS
  with an ACME certificate for the name, so the LAN path has no Cloudflare in it.
- **Away**, a Cloudflare Tunnel carries the name, with Cloudflare Access in front.
  `lib/access.js` wraps `fetch` before anything else runs: when an expired Access session
  turns a `/jf` or `/ml` call into a network error, it asks `/net.json` with
  `redirect: 'manual'`. On a redirect to the Access login, it reloads the page so Access
  can sign the user in again, at most once a minute.
- **`/net.json`** answers `{"via":"lan"}` or `{"via":"tunnel"}`. `lib/net.js` makes the
  streaming-quality default Original on the LAN and 8 Mbit/s through the tunnel, until the
  user picks a quality. A missing file (the dev server) means Original.
- reel-api's request guard needs the name in `allowedHosts`, and nginx must pass `Host`
  through.

## Playback path

`src/lib/player.svelte.js` is the same engine as on the TV and the phone. In the web build
it differs in two places:

1. **`webProfile()`** (`src/lib/tracks.js`) builds the DeviceProfile from
   `MediaSource.isTypeSupported` probes (`webCaps()`), because what counts is what an fMP4
   SourceBuffer accepts. Measured on Linux:
   - **Chrome 154:** H.264, AV1, VP9, AAC, Opus, FLAC. No HEVC, AC-3/E-AC-3 or Dolby Vision.
   - **Firefox 156:** the same, plus HEVC Main/Main 10.

   How the profile uses that:
   - **DirectPlay:** progressive MP4 only, and only for the file's default audio track.
     Browsers have no `audioTracks`, so any other pick turns DirectPlay off.
   - **Everything else:** Jellyfin's HLS remux, video copied where the browser decodes it.
   - **Forced encodes:** H.264 is listed first, so HEVC on Chrome, the quality cap and
     burn-in all encode H.264.
   - **Audio:** AAC 5.1 at most. DTS, TrueHD and E-AC-3 become AAC.
   - **HDR:** claimed only on an HDR display (`video-dynamic-range: high`). DV profile 8
     plays as its base layer.
2. **`src/lib/jfhls.js`** feeds that HLS into a MediaSource through `segfeed.js`. Firefox
   has no HLS player, and Chrome's is not one to build on. The feed:
   - reads Jellyfin's VOD `main.m3u8`, never `master.m3u8`, and fetches the segments
     around the playhead;
   - rewrites a `dvh1` sample entry to `hvc1`;
   - writes each fragment's real start back into the playlist after a job restart;
   - stops the server job (`DELETE /Videos/ActiveEncodings`) when it ends.

   One feed runs at a time. Retry, an audio switch, a quality pick and the next episode
   each open a new feed, and the old one's job is stopped. Progress reports, markers,
   trickplay, Up Next and text/PGS subtitles all run as for any Jellyfin stream. Only the
   `<video>` src is the feed's blob URL.

Watch-while-downloading uses reel-api's live HLS (`livehls.py`) with `codec=aac` on every
call. Desktop browsers decode no AC-3/E-AC-3, so the server copies AAC and encodes the
rest to AAC.

## Dev server (`web/dev/plugin.js`, serve only)

- `/jf` and `/ml` are proxied to `VITE_JELLYFIN_URL` / `VITE_MEDIALIB_URL` from
  `.env.local`.
- `/?devlogin` signs in with the gitignored `phone/.devcreds.json`
  (`phone/dev-chrome.sh login` writes it), served at `/__devcreds`.
- **Playback guard:** `PlaybackInfo` and `Sessions/Playing*` answer 403, so nothing
  records a play on the real server. `REEL_DEV_ALLOWPLAY=1` lets them through, but then
  snapshot and restore the UserData of everything played.
- `REEL_DEV_READONLY=1` blocks every non-GET except sign-in and trailers.
- `REEL_DEV_NET=lan|tunnel` makes `/net.json` answer like the NAS.

## Deploy (`web/deploy.sh`)

```sh
./web/deploy.sh                 # build + publish + verify
NO_BUILD=1 ./web/deploy.sh      # publish the existing web/dist
```

`NAS` (ssh target), `WEB_ORIGIN` and `WEB_IP` come from `.env.local` or the command line.
The deploy is atomic, like the phone's:

1. rsync into `releases/<stamp>/`, hard-linking unchanged files from the live release.
2. md5-check the staged tree, then swap `current` with a rename. The last 3 releases are
   kept.
3. Verify through the real name pinned to the NAS's address, so Cloudflare and Access are
   not involved: `index.html` and every script and stylesheet it references must
   md5-match. A deep link must return `index.html`, and `/net.json` must answer (these two
   only warn).

Exit 0 means the origin serves this build. The NAS-side module must exist before the first deploy.
