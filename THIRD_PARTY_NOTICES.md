# Third-party notices

VibeReel's own code is MIT-licensed (see `LICENSE`). The repository also
contains, or its builds bundle, the following third-party components.

## Included in this repository

| Component | Where | Upstream | License | License text |
|---|---|---|---|---|
| libpgs 0.8.1 (`dist/libpgs.js`, unmodified) | `src/vendor/libpgs.js` | https://github.com/Arcus92/libpgs-js | MIT, Copyright (c) 2024 David Schulte | `src/vendor/libpgs.LICENSE` |
| core-js 3.38.1 (parts, bundled inside libpgs.js by its upstream build) | `src/vendor/libpgs.js` | https://github.com/zloirock/core-js | MIT, Copyright (c) 2014-2024 Denis Pushkarev | `src/vendor/libpgs.LICENSE` |
| Instrument Serif (Regular, Italic; latin + latin-ext WOFF2 subsets) | `phone/public/fonts/` | https://github.com/Instrument/instrument-serif | SIL Open Font License 1.1, Copyright 2022 The Instrument Serif Project Authors | `phone/public/fonts/OFL.txt` |
| The two `sed` expressions of the Homebrew Channel's elevated `run-js-service` | `service/run-js-service` | https://github.com/webosbrew/webos-homebrew-channel | MIT, Copyright (c) 2021 webOS Brew | below |

## Bundled into the builds from npm (not in the repository)

| Component | In | Upstream | License |
|---|---|---|---|
| Svelte 5 runtime | TV `app.js`, phone bundle | https://github.com/sveltejs/svelte | MIT, Copyright (c) 2016-2025 Svelte Contributors |
| clsx | phone bundle | https://github.com/lukeed/clsx | MIT, Copyright (c) Luke Edwards |

Their license texts ship in the packages under `node_modules/` after `npm install`.
Every build also writes `LICENSES.txt` next to the bundle (`vite.licenses.js`): this
project's license plus the full license text of every third-party module that ended
up in that build, so the TV package and the phone app carry their notices.

Everything else in the repository is original to this project, including the
icons (`src/lib/icons.js`, `phone/src/lib/icons.js`,
`docs/ios/vibereel-iphone/icons/`), the generated launcher/splash images and
`public/refresh60.mp4` (one second of black 60p video made with ffmpeg).
The design mock-ups in `docs/ios/vibereel-iphone/` load Instrument Serif from
Google Fonts at view time; nothing from there is checked in.

## webOS Homebrew Channel — MIT License

```
MIT License

Copyright (c) 2021 webOS Brew

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
