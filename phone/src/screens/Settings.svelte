<script>
  /* Settings — pushed from the Accounts sheet (design screens/11-settings.html).
   * The TV's SettingsMenu on the phone: every value lives in
   * src/lib/settings.svelte.js (SET / setSetting, localStorage reel.settings),
   * read at the next playback start. "Streaming quality" is the engine's
   * per-device cap (getQualityCap / setQualityCap / QUALITY_CAPS in
   * player.svelte.js). iOS Safari can't tell cellular from Wi-Fi, so it is one
   * cap for every network (the design's separate cellular / Wi-Fi rows merged). */
  import NavBar from '../components/NavBar.svelte';
  import List from '../components/List.svelte';
  import Row from '../components/Row.svelte';
  import Switch from '../components/Switch.svelte';
  import Segmented from '../components/Segmented.svelte';
  import Icon from '../components/Icon.svelte';
  import { scrollPast } from '../lib/gestures.js';
  import { SET, setSetting, LANGS, SUB_MODES, SUB_SIZE_MIN, SUB_SIZE_MAX, SUB_SIZE_STEP } from '$lib/settings.svelte.js';
  import { getQualityCap, setQualityCap, QUALITY_CAPS } from '$lib/player.svelte.js';
  import { cfg } from '$lib/config.js';
  import appinfo from '../../../public/appinfo.json';
  import { pushSupport, permission, pushPrefs, pushServerState, setPush, sendTestPush } from '../lib/push.js';
  import { toast } from '$lib/toast.svelte.js';
  import { errText } from '$lib/api.js';
  import { onMount } from 'svelte';
  import { push as pushRoute } from '../lib/router.svelte.js';
  import { OFF } from '../lib/offline.svelte.js';

  /* Notifications (lib/push.js): what this device asked for, corrected by the
   * server's copy once it answers. Switching one on asks iOS for permission
   * inside the tap. Only the Home Screen app can receive them on iOS. */
  const pushOk = pushSupport();
  let push = $state(pushPrefs());
  let pushBusy = $state(false);
  onMount(() => {
    pushServerState()
      .then((s) => {
        if (s && !pushBusy) push = { ready: !!s.ready, seasons: !!s.seasons };
      })
      .catch(() => {});
  });
  function togglePush(kind, on) {
    if (pushBusy) return;
    pushBusy = true;
    const was = push[kind];
    push = { ...push, [kind]: on };
    setPush(kind, on)   // synchronous permission prompt inside this tap
      .then((p) => {
        push = p;
        if (on) toast(kind === 'ready' ? 'You’ll be notified when downloads are ready' : 'You’ll be notified about new seasons');
      })
      .catch((e) => {
        push = { ...push, [kind]: was };
        toast(pushErr(e, 'Couldn’t change notifications'));
      })
      .finally(() => (pushBusy = false));
  }
  /* push.js errors are either sentences meant for the user (permission, not
   * set up) or a bare "HTTP 502" from the service: never show the latter
   * (SET-01) */
  function pushErr(e, what) {
    if (e?.status >= 500 || e?.name === 'TypeError' || e?.name === 'AbortError' || e?.name === 'TimeoutError')
      return what + ' — the notification service didn’t answer. Try again in a moment.';
    const t = errText(e);
    return /^HTTP \d+$/.test(t) ? what + ' (' + t + ')' : t;
  }
  const pushFoot = $derived(
    pushOk === 'browser'
      ? 'Notifications only work in the Home Screen app: in Safari tap Share → Add to Home Screen, then open VibeReel from there.'
      : pushOk !== 'ok'
        ? 'This browser can’t receive notifications.'
        : permission() === 'denied'
          ? 'Notifications are off for VibeReel in the iPhone’s Settings → Notifications.'
          : 'Delivered to the Home Screen app on this iPhone.'
  );

  let { params = {}, active = false } = $props();

  let solid = $state(false);

  /* subMode, labelled by what it does (settings.svelte.js):
   *   'off'    only forced subtitles (signs, foreign-language lines)
   *   'auto'   forced, plus full ones when the audio isn't in your language
   *   'always' full subtitles in your language whenever the file has them */
  const MODES = [
    { value: 'off', label: 'Forced only' },
    { value: 'auto', label: 'Automatic' },
    { value: 'always', label: 'Always' }
  ];
  const modeHint = $derived((SUB_MODES.find(([v]) => v === SET.subMode) || SUB_MODES[0])[2]);

  const SIZES = [];
  for (let s = SUB_SIZE_MIN; s <= SUB_SIZE_MAX; s += SUB_SIZE_STEP) SIZES.push(s);

  let quality = $state(getQualityCap());
  // the player's Quality picker writes the same setting while this page stays mounted
  $effect(() => {
    if (active) quality = getQualityCap();
  });
  const mbit = (v) => (v === 'original' ? 'Original' : Math.round(v / 1e6) + ' Mbit/s');
  const QUALITY = QUALITY_CAPS.map((v) => ({ value: v, label: mbit(v) }));
  /* what the picked cap does (phoneProfile / PHONE_CAP_BOX in the engine) */
  const qualityHint = $derived(
    quality === 'original'
      ? 'Every file plays as it is, at full quality. A 4K film needs a fast connection.'
      : quality === 8000000
        ? 'Larger files are converted on the server to 1080p at 8 Mbit/s: HDR plays as SDR and it starts a little slower. Smaller files play as they are.'
        : 'Larger files are converted on the server to 720p at 4 Mbit/s with stereo sound: HDR plays as SDR and it starts a little slower. Smaller files play as they are.'
  );

  const langName = (code) => (LANGS.find(([c]) => c === code) || [code, code])[1];
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
    <p class="pagehead__sub">{cfg.userName || 'Signed out'} · this iPhone</p>
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

  <List group label="Streaming" foot="{qualityHint} Applies on Wi-Fi and mobile data alike — the iPhone can’t tell them apart.">
    <Row column title="Quality">
      <Segmented
        options={QUALITY}
        value={quality}
        label="Streaming quality"
        onchange={(v) => {
          quality = v;
          setQualityCap(v);
        }}
      />
    </Row>
  </List>

  <List group label="Downloads">
    <Row title="Downloads" icon="download" value={OFF.list.length ? String(OFF.list.filter((e) => e.user === cfg.userId).length) : ''} chevron onclick={() => pushRoute('downloads')} />
  </List>

  <List group label="Notifications" foot={pushFoot}>
    <Row wrap title="Ready to watch" sub="When a download is in your library">
      {#snippet trail()}<Switch on={push.ready} disabled={pushOk !== 'ok' || pushBusy} label="Notify me when a download is ready to watch" onchange={(v) => togglePush('ready', v)} />{/snippet}
    </Row>
    <Row wrap title="New seasons" sub="When a season you don’t have yet airs">
      {#snippet trail()}<Switch on={push.seasons} disabled={pushOk !== 'ok' || pushBusy} label="Notify me about new seasons" onchange={(v) => togglePush('seasons', v)} />{/snippet}
    </Row>
    {#if pushOk === 'ok' && (push.ready || push.seasons)}
      <Row title="Send a test notification" action onclick={() => sendTestPush().then(() => toast('Sent — it should arrive in a few seconds')).catch((e) => toast(pushErr(e, 'Test failed')))} />
    {/if}
  </List>

  <List group label="About">
    <Row title="Server" value={host} class="selectable" />
    <Row title="Version" value="{appinfo.title} {appinfo.version} · iPhone" class="selectable" />
  </List>
</main>

<NavBar title="Settings" {solid} />
