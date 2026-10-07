<script>
  import Icon from './Icon.svelte';
  import { SET, setSetting, LANGS, SUB_MODES } from '../lib/settings.svelte.js';
  import { cfg } from '../lib/config.js';
  import appinfo from '../../public/appinfo.json';

  /* The avatar menu's Settings: one more .lvmenu hung from the avatar
   * (HM.open === 'settings'), so it is modal for the D-pad exactly like the
   * account list (focus.js) and Back closes it onto the avatar (Keys.svelte,
   * HM_BUTTON). A choice row steps through its values — OK or ▶ forward, ◀ back;
   * ◀▶ are swallowed here because a one-column menu has nowhere to go sideways
   * anyway. Every change is live: SET is read at the next playback start. */

  const CHOICES = {
    audioLang: LANGS,
    subLang: LANGS,
    subMode: SUB_MODES
  };

  /** @typedef {keyof typeof CHOICES} ChoiceKey */
  /** @typedef {'autoplayNext' | 'autoSkipIntro' | 'autoSkipRecap'} ToggleKey */

  /** @param {ChoiceKey} key */
  function label(key) {
    const list = CHOICES[key];
    const hit = list.find(([v]) => v === SET[key]);
    return hit ? hit[1] : list[0][1];
  }

  /** @param {ChoiceKey} key @param {number} by */
  function step(key, by) {
    const list = CHOICES[key];
    const i = Math.max(0, list.findIndex(([v]) => v === SET[key]));
    setSetting(key, list[(i + by + list.length) % list.length][0]);
  }

  /** @param {ChoiceKey} key @returns {(e: KeyboardEvent) => void} */
  function sideways(key) {
    return (e) => {
      if (e.keyCode !== 37 && e.keyCode !== 39) return;
      e.preventDefault();
      e.stopPropagation(); // not a spatial move — Keys.svelte never sees it
      step(key, e.keyCode === 39 ? 1 : -1);
    };
  }

  const subHint = $derived((SUB_MODES.find(([v]) => v === SET.subMode) || SUB_MODES[0])[2]);

  /** @param {FocusEvent} e */
  function keepInView(e) {
    /** @type {Element | null} */ (e.target)?.scrollIntoView?.({ block: 'nearest' });
  }
</script>

{#snippet choice(/** @type {ChoiceKey} */ key, /** @type {string} */ text)}
  <button class="opt focus setrow" data-focus="set-{key}" onclick={() => step(key, 1)} onkeydown={sideways(key)}>
    <span class="setlab">{text}</span>
    <span class="setval"><i class="l"><Icon name="chev" /></i>{label(key)}<i class="r"><Icon name="chev" /></i></span>
  </button>
{/snippet}

{#snippet toggle(/** @type {ToggleKey} */ key, /** @type {string} */ text)}
  <button
    class="opt focus setrow"
    class:on={SET[key]}
    data-focus="set-{key}"
    role="switch"
    aria-checked={SET[key]}
    onclick={() => setSetting(key, !SET[key])}
  >
    <span class="setlab">{text}</span><i class="sw"><b></b></i>
  </button>
{/snippet}

<div class="lvmenu hmenu settings" role="list" aria-label="Settings" onfocusin={keepInView}>
  <div class="lvcap">Playback</div>
  {@render choice('audioLang', 'Audio language')}
  {@render choice('subLang', 'Subtitle language')}
  {@render choice('subMode', 'Subtitles')}
  <div class="msg sethint">{subHint}</div>
  {@render toggle('autoplayNext', 'Autoplay next episode')}
  {@render toggle('autoSkipIntro', 'Skip intros automatically')}
  {@render toggle('autoSkipRecap', 'Skip recaps automatically')}
  <div class="msg sethint">Choices you make in the player’s Audio/Subtitles menu are remembered per series and win over these.</div>

  <div class="acsep"></div>
  <div class="lvcap">About</div>
  <dl class="setabout">
    <dt>Version</dt><dd>{appinfo.title} {appinfo.version}</dd>
    <dt>Server</dt><dd>{cfg.server}</dd>
    <dt>Signed in as</dt><dd>{cfg.userName}</dd>
  </dl>
</div>
