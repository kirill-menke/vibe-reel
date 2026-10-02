/* The webOS font stack has no glyphs for ⟳ ☰ ▸ and similar — they render as
 * tofu (measured on the TV: also U+25B8 and the private-use area). Every icon in the UI is therefore
 * inline SVG, not a glyph, so it looks the same everywhere. These are the <svg> inner
 * bodies; Icon.svelte supplies the wrapper. */
export const ICONS = {
  play: '<path d="M8 5.14v13.72a1 1 0 0 0 1.53.85l10.79-6.86a1 1 0 0 0 0-1.7L9.53 4.29A1 1 0 0 0 8 5.14z"/>',
  pause: '<rect x="6" y="5" width="4.2" height="14" rx="1.2"/><rect x="13.8" y="5" width="4.2" height="14" rx="1.2"/>',
  /* OSD ⏪/⏩: a circular arrow with the step in it, so the button says how far
   * it jumps (SEEK_BACK / SEEK_FWD in player.svelte.js — keep the digits in
   * sync). Digits are the one thing the webOS font does have glyphs for. */
  back10:
    '<path d="M12 3.2A8.8 8.8 0 1 1 3.5 9.9" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>' +
    '<path d="M12.6.4v5.6L8.6 3.2z"/>' +
    '<text x="12.3" y="15.4" text-anchor="middle" font-size="8.2" font-weight="800" letter-spacing="-.3">10</text>',
  fwd30:
    '<path d="M12 3.2A8.8 8.8 0 1 0 20.5 9.9" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>' +
    '<path d="M11.4.4v5.6l4-2.8z"/>' +
    '<text x="11.7" y="15.4" text-anchor="middle" font-size="8.2" font-weight="800" letter-spacing="-.3">30</text>',
  /* chapter list: bullets + lines (the OSD's Chapters button) */
  chapters:
    '<rect x="3" y="4.6" width="3.4" height="3.4" rx="1"/><rect x="3" y="10.3" width="3.4" height="3.4" rx="1"/>' +
    '<rect x="3" y="16" width="3.4" height="3.4" rx="1"/>' +
    '<rect x="9" y="5.2" width="12" height="2.2" rx="1.1"/><rect x="9" y="10.9" width="12" height="2.2" rx="1.1"/>' +
    '<rect x="9" y="16.6" width="8.4" height="2.2" rx="1.1"/>',
  /* skip-to-end: the Skip Intro chip's glyph (and the OSD's Next episode button) */
  skip:
    '<path d="M4.6 5.6v12.8a.8.8 0 0 0 1.25.66l9.45-6.4a.8.8 0 0 0 0-1.32L5.85 4.94A.8.8 0 0 0 4.6 5.6z"/>' +
    '<rect x="16.9" y="5" width="2.9" height="14" rx="1.45"/>',
  /* OSD round buttons. The stroked parts set their own fill/stroke — Icon.svelte
   * only supplies fill="currentColor" on the <svg>, so an inner fill="none" wins. */
  /* audio/language track: a speech bubble with a waveform in it. Deliberately
   * *not* a speaker-with-waves — that reads as volume, which this button has
   * nothing to do with. The vertical bars also keep it apart from `subs`, which
   * is the other rounded box in the row but carries horizontal text lines. */
  audio:
    '<path d="M5.6 3.6H18.4A3.4 3.4 0 0 1 21.8 7V14.4A3.4 3.4 0 0 1 18.4 17.8H11.6L7.2 21.4V17.8H5.6' +
    'A3.4 3.4 0 0 1 2.2 14.4V7A3.4 3.4 0 0 1 5.6 3.6Z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>' +
    '<rect x="6.2" y="8.7" width="2.1" height="4" rx="1.05"/><rect x="9.4" y="6.9" width="2.1" height="7.6" rx="1.05"/>' +
    '<rect x="12.6" y="8" width="2.1" height="5.4" rx="1.05"/><rect x="15.8" y="9" width="2.1" height="3.4" rx="1.05"/>',
  subs:
    '<rect x="2.4" y="4.5" width="19.2" height="15" rx="2.6" fill="none" stroke="currentColor" stroke-width="2"/>' +
    '<rect x="5.6" y="9.1" width="4.2" height="2.2" rx="1.1"/><rect x="11.2" y="9.1" width="7.2" height="2.2" rx="1.1"/>' +
    '<rect x="5.6" y="13.3" width="6.6" height="2.2" rx="1.1"/><rect x="13.6" y="13.3" width="4.8" height="2.2" rx="1.1"/>',
  picture:
    '<circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2"/>' +
    '<path d="M12 4.6a7.4 7.4 0 0 1 0 14.8z"/>',
  /* checkmark — the "in library / added" badge on a Fetch result card */
  check:
    '<path d="M20.3 6.3a1 1 0 0 1 0 1.4l-9.6 9.6a1 1 0 0 1-1.4 0l-4.6-4.6a1 1 0 0 1 1.4-1.4l3.9 3.9 8.9-8.9a1 1 0 0 1 1.4 0z"/>',
  /* thin outline check — the understated "watched" mark on an episode row. A
     stroked tick rather than the solid glyph `check` draws, so it can sit on the
     row without a filled disc behind it and still read from three metres. */
  checkthin:
    '<path d="M4.8 12.6 9.7 17.5 19.2 7" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>',
  /* backspace — the Delete key of Search's keyboard (⌫ is tofu on webOS) */
  backspace:
    '<path d="M9.2 5.5h10.3a1.5 1.5 0 0 1 1.5 1.5v10a1.5 1.5 0 0 1-1.5 1.5H9.2L3 12z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>' +
    '<path d="M11.6 9.4l5.2 5.2M16.8 9.4l-5.2 5.2" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
  /* film strip — the detail pages' Trailer button */
  trailer:
    '<rect x="3" y="4.5" width="18" height="15" rx="2.2" fill="none" stroke="currentColor" stroke-width="2.1"/>' +
    '<path d="M10 9.3v5.4a.6.6 0 0 0 .92.5l4.1-2.7a.6.6 0 0 0 0-1l-4.1-2.7a.6.6 0 0 0-.92.5z"/>',
  /* plus — the idle "add to library" affordance */
  plus: '<rect x="10.8" y="4" width="2.4" height="16" rx="1.2"/><rect x="4" y="10.8" width="16" height="2.4" rx="1.2"/>',
  /* minus — the subtitle-timing step down (player subtitle menu) */
  minus: '<rect x="4" y="10.8" width="16" height="2.4" rx="1.2"/>',
  /* the tab row's new-seasons bell */
  bell:
    '<path d="M12 2.6a1.3 1.3 0 0 1 1.3 1.3v.6a6.4 6.4 0 0 1 5.1 6.3v3.9l1.7 2.4a1 1 0 0 1-.8 1.6H4.7a1 1 0 0 1-.8-1.6l1.7-2.4v-3.9a6.4 6.4 0 0 1 5.1-6.3v-.6A1.3 1.3 0 0 1 12 2.6z"/>' +
    '<path d="M9.4 19.8h5.2a2.6 2.6 0 0 1-5.2 0z"/>',
  /* sign out: a door frame with an arrow leaving it */
  signout:
    '<path d="M10.5 3.5H6.2A2.2 2.2 0 0 0 4 5.7v12.6a2.2 2.2 0 0 0 2.2 2.2h4.3" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>' +
    '<path d="M9.5 12h10M16 8l4 4-4 4" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>',
  /* settings: three slider tracks with their knobs (reads better at 24px than a cog) */
  gear:
    '<path d="M3.5 6.5h17M3.5 12h17M3.5 17.5h17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>' +
    '<circle cx="8.5" cy="6.5" r="2.6"/><circle cx="15.5" cy="12" r="2.6"/><circle cx="10" cy="17.5" r="2.6"/>',
  /* ---- top-nav tabs (Home / Movies / Shows) ---- */
  home:
    '<path d="M12 2.4 1.9 11a1 1 0 0 0 1.3 1.52L12 4.98l8.8 7.54A1 1 0 0 0 22.1 11L12 2.4z"/>' +
    '<path d="M12 7.3 4.5 13.7V20a1.3 1.3 0 0 0 1.3 1.3h3.9v-5.5h4.6v5.5h3.9A1.3 1.3 0 0 0 19.5 20v-6.3L12 7.3z"/>',
  /* film strip — Movies */
  film:
    '<rect x="2.2" y="3.6" width="19.6" height="16.8" rx="2.4" fill="none" stroke="currentColor" stroke-width="2"/>' +
    '<rect x="6.6" y="4.6" width="1.6" height="14.8"/><rect x="15.8" y="4.6" width="1.6" height="14.8"/>' +
    '<rect x="3.6" y="6.4" width="2.4" height="2.2" rx=".7"/><rect x="3.6" y="10.9" width="2.4" height="2.2" rx=".7"/>' +
    '<rect x="3.6" y="15.4" width="2.4" height="2.2" rx=".7"/>' +
    '<rect x="18" y="6.4" width="2.4" height="2.2" rx=".7"/><rect x="18" y="10.9" width="2.4" height="2.2" rx=".7"/>' +
    '<rect x="18" y="15.4" width="2.4" height="2.2" rx=".7"/>',
  /* screen + rabbit-ear antenna — Shows */
  tv:
    '<path d="M7.6 2.2 12 6.1l4.4-3.9" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>' +
    '<rect x="2.4" y="6.8" width="19.2" height="13.6" rx="2.6" fill="none" stroke="currentColor" stroke-width="2"/>',
  /* magnifier — Search (the tab formerly labelled Fetch) */
  /* Library bar (LibraryBar.svelte). sort: bars shortening towards the bottom
   * beside a down arrow — "ordered by"; genre: four tiles — "categories";
   * unseen: an open eye — "only what you haven't seen"; chev: the dropdown hint. */
  sort:
    '<rect x="3" y="5" width="11" height="2.2" rx="1.1"/><rect x="3" y="10.9" width="8" height="2.2" rx="1.1"/>' +
    '<rect x="3" y="16.8" width="5" height="2.2" rx="1.1"/>' +
    '<path d="M18.1 4.6v12.2" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>' +
    '<path d="M14.9 14.4 18.1 18.4 21.3 14.4" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>',
  genre:
    '<rect x="3.2" y="3.2" width="7.6" height="7.6" rx="2"/><rect x="13.2" y="3.2" width="7.6" height="7.6" rx="2" fill="none" stroke="currentColor" stroke-width="2"/>' +
    '<rect x="3.2" y="13.2" width="7.6" height="7.6" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><rect x="13.2" y="13.2" width="7.6" height="7.6" rx="2"/>',
  unseen:
    '<path d="M2.4 12s3.6-6.6 9.6-6.6 9.6 6.6 9.6 6.6-3.6 6.6-9.6 6.6S2.4 12 2.4 12z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>' +
    '<circle cx="12" cy="12" r="3.1"/>',
  chev: '<path d="M6.5 9.5 12 15l5.5-5.5" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>',
  search:
    '<circle cx="10.5" cy="10.5" r="6.6" fill="none" stroke="currentColor" stroke-width="2.2"/>' +
    '<path d="M15.6 15.6a1.15 1.15 0 0 1 1.63 0l4.06 4.06a1.15 1.15 0 0 1-1.63 1.63L15.6 17.23a1.15 1.15 0 0 1 0-1.63z"/>',
  /* restart — "Start over" next to Resume (a counter-clockwise arrow) */
  restart:
    '<path d="M4.6 14.6a7.9 7.9 0 1 0 1.9-8.2L3.2 9.7" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"/>' +
    '<path d="M3.2 4.4v5.3h5.3" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"/>',
  /* download — download-activity badges and rows (arrow into a tray) */
  download:
    '<rect x="10.8" y="3" width="2.4" height="10.4" rx="1.2"/>' +
    '<path d="M7.5 10.4a1 1 0 0 1 1.42 0L12 13.5l3.08-3.1a1 1 0 1 1 1.42 1.42l-3.79 3.8a1 1 0 0 1-1.42 0l-3.79-3.8a1 1 0 0 1 0-1.42z"/>' +
    '<rect x="4" y="17.4" width="16" height="2.4" rx="1.2"/>'
};

/* VibeReel brand mark (2a "waveform → play") */
export const GLYPH =
  '<g fill="#e6b450">' +
  '<rect x="6" y="31" width="11" height="38" rx="5.5"/><rect x="24" y="19" width="11" height="62" rx="5.5"/>' +
  '<rect x="42" y="27" width="11" height="46" rx="5.5"/><polygon points="62,25 62,75 96,50"/></g>';
