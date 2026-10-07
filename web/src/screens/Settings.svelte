<script>
  /* Settings for the web build — the phone's Settings screen
   * (phone/src/screens/Settings.svelte) without what a browser tab doesn't
   * have (offline downloads, push notifications) and with desktop wording.
   * Every value is the shared one: src/lib/settings.svelte.js (SET /
   * setSetting) and the engine's per-device streaming cap (getQualityCap /
   * setQualityCap). The cap's default depends on where the browser is
   * (lib/net.js: 8 Mbit/s through the tunnel, Original at home) until it is
   * picked here or in the player. */
  import NavBar from '$p/components/NavBar.svelte';
  import List from '$p/components/List.svelte';
  import Row from '$p/components/Row.svelte';
  import Switch from '$p/components/Switch.svelte';
  import Segmented from '$p/components/Segmented.svelte';
  import { scrollPast } from '$p/lib/gestures.js';
  import { SET, setSetting, LANGS, SUB_MODES, SUB_SIZE_MIN, SUB_SIZE_MAX, SUB_SIZE_STEP } from '$lib/settings.svelte.js';
  import { getQualityCap, setQualityCap, QUALITY_CAPS } from '$lib/player.svelte.js';
  import { cfg } from '$lib/config.js';
  import appinfo from '../../../public/appinfo.json';
  import { push as pushRoute } from '$p/lib/router.svelte.js';
  import { ME, quotaSummary } from '$lib/me.svelte.js';
  import { via, markQualityChosen } from '../lib/net.js';

  /** @type {{ params?: VR.RouteParams, active?: boolean }} */
  let { active = false } = $props();

  let solid = $state(false);

  const MODES = [
    { value: 'off', label: 'Forced only' },
    { value: 'auto', label: 'Automatic' },
    { value: 'always', label: 'Always' }
  ];
  const modeHint = $derived((SUB_MODES.find(([v]) => v === SET.subMode) || SUB_MODES[0])[2]);

  /** @type {number[]} */
  const SIZES = [];
  for (let s = SUB_SIZE_MIN; s <= SUB_SIZE_MAX; s += SUB_SIZE_STEP) SIZES.push(s);

  let quality = $state(getQualityCap());
  // the player's Quality picker writes the same setting while this page stays mounted
  $effect(() => {
    if (active) quality = getQualityCap();
  });
  const mbit = (/** @type {number | 'original'} */ v) => (v === 'original' ? 'Original' : Math.round(v / 1e6) + ' Mbit/s');
  const QUALITY = QUALITY_CAPS.map((v) => ({ value: v, label: mbit(v) }));
  const qualityHint = $derived(
    quality === 'original'
      ? 'Every file plays as it is, at full quality. A 4K film needs a fast connection.'
      : quality === 8000000
        ? 'Larger files are converted on the server to 1080p at 8 Mbit/s: HDR plays as SDR and it starts a little slower. Smaller files play as they are.'
        : 'Larger files are converted on the server to 720p at 4 Mbit/s with stereo sound: HDR plays as SDR and it starts a little slower. Smaller files play as they are.'
  );
  const where = via === 'tunnel' ? ' You’re connected from outside home: the default here is 8 Mbit/s.' : via === 'lan' ? ' You’re on the home network: the default here is Original.' : '';

  const langName = (/** @type {string} */ code) => (LANGS.find(([c]) => c === code) || [code, code])[1];
  const host = (() => {
    try {
      return new URL(cfg.server, location.href).host;
    } catch {
      return cfg.server;
    }
  })();
</script>

<main class="screen settings" use:scrollPast={{ y: 24, onchange: (s) => (solid = s) }}>
  <div class="spacer-navbar"></div>
  <header class="pagehead">
    <h1 class="pagehead__title">Settings</h1>
    <p class="pagehead__sub">{cfg.userName || 'Signed out'} · this browser</p>
  </header>

  <List label="Playback" foot="Up Next counts down for 10 seconds before it plays.">
    <Row wrap title="Skip recaps automatically" sub="“Previously on” and previews">
      {#snippet trail()}<Switch on={SET.autoSkipRecap} label="Skip recaps automatically" onchange={(v) => setSetting('autoSkipRecap', v)} />{/snippet}
    </Row>
    <Row wrap title="Skip intros automatically" sub="Otherwise a Skip Intro button shows">
      {#snippet trail()}<Switch on={SET.autoSkipIntro} label="Skip intros automatically" onchange={(v) => setSetting('autoSkipIntro', v)} />{/snippet}
    </Row>
    <Row wrap title="Autoplay next episode">
      {#snippet trail()}<Switch on={SET.autoplayNext} label="Autoplay next episode" onchange={(v) => setSetting('autoplayNext', v)} />{/snippet}
    </Row>
  </List>

  <List group label="Languages" foot="What you pick in the player’s Audio and Subtitles menus is remembered per series and wins over these.">
    <Row class="setrow" title="Audio" value={langName(SET.audioLang)} chevron>
      <select class="setrow__select" aria-label="Audio language" value={SET.audioLang} onchange={(e) => setSetting('audioLang', e.currentTarget.value)}>
        {#each LANGS as [code, name] (code)}<option value={code}>{name}</option>{/each}
      </select>
    </Row>
    <Row class="setrow" title="Subtitles" value={langName(SET.subLang)} chevron>
      <select class="setrow__select" aria-label="Subtitle language" value={SET.subLang} onchange={(e) => setSetting('subLang', e.currentTarget.value)}>
        {#each LANGS as [code, name] (code)}<option value={code}>{name}</option>{/each}
      </select>
    </Row>
  </List>

  <List group label="Subtitles" foot={modeHint}>
    <Row column title="Show subtitles">
      <Segmented options={MODES} value={SET.subMode} label="Show subtitles" onchange={(v) => setSetting('subMode', v)} />
    </Row>
    <Row class="setrow" title="Size" value="{SET.subSize}%" chevron>
      <select class="setrow__select" aria-label="Subtitle size" value={String(SET.subSize)} onchange={(e) => setSetting('subSize', Number(e.currentTarget.value))}>
        {#each SIZES as s (s)}<option value={String(s)}>{s}%{s === 100 ? ' (default)' : ''}</option>{/each}
      </select>
    </Row>
  </List>

  <List group label="Streaming" foot="{qualityHint}{where}">
    <Row column title="Quality">
      <!-- any click on a segment is an explicit pick, the selected one too (lib/net.js) -->
      <div class="wquality" onclickcapture={markQualityChosen} role="presentation">
      <Segmented
        options={QUALITY}
        value={quality}
        label="Streaming quality"
        onchange={(v) => {
          quality = v;
          setQualityCap(v);
        }}
      />
      </div>
    </Row>
  </List>

  {#if ME.me}
    <List group label="Library">
      <!-- what you added to the server and your quota (GET /api/me; an old reel-api has none) -->
      <Row title="My library" icon="movies" sub={quotaSummary()} chevron onclick={() => pushRoute('mylibrary')} />
    </List>
  {/if}

  <List group label="About">
    <Row title="Server" value={host} class="selectable" />
    <Row title="Version" value="{appinfo.title} {appinfo.version} · Web" class="selectable" />
  </List>
</main>

<NavBar title="Settings" {solid} />
