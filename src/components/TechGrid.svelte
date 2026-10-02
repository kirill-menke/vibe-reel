<script>
  import { videoStream, resLabel, codecPretty, chLayout, isAtmos, isCommentary, langName, describeTracks } from '../lib/tracks.js';
  import { P } from '../lib/player.svelte.js';
  import { focusKey } from '../lib/focus.js';

  /* hero        — compact variant for the detail hero's info column.
     markSelected — ring the audio track that will be used. Only meaningful while
                    something is playing (it's the track you are hearing); on the
                    detail screen it only decorated the default pick. */
  /* compact      — cap the audio row at AUDIO_CAP chips and the subtitle row at
                    SUB_CAP languages (preferred ones first), each with a
                    focusable "+N" that expands the row in place. A 31-language
                    Blu-ray remux used to fill five rows of the detail page. */
  let { item, src, hero = false, markSelected = true, compact = false, fkey = 'tg' } = $props();

  const AUDIO_CAP = 4;
  const SUB_CAP = 3;
  /* The languages this household reads first; the rest keep file order. */
  const SUB_PREF = ['English', 'German'];
  let audioOpen = $state(false);
  let subsOpen = $state(false);

  const v = $derived(src ? videoStream(src) : null);
  const streams = $derived(src ? src.MediaStreams || [] : []);
  const audio = $derived(streams.filter((s) => s.Type === 'Audio'));
  const subs = $derived(streams.filter((s) => s.Type === 'Subtitle'));

  const vRange = $derived(v ? (v.VideoRangeType || v.VideoRange || '').toUpperCase() : '');
  const isDovi = $derived(!!v && (vRange.includes('DOVI') || /dolby ?vision/i.test(v.Title || '')));

  const resChip = $derived(v ? (v.Width && v.Height ? `${v.Width} × ${v.Height}` : resLabel(v.Width, v.Height)) : '');
  const codecChip = $derived(v ? (v.Codec || '').toUpperCase() + (v.BitDepth ? ' ' + v.BitDepth + '-bit' : '') : '');
  const dvChip = $derived(
    v && isDovi
      ? v.DvProfile != null
        ? 'DV Profile ' + v.DvProfile + (v.DvBlSignalCompatibilityId != null ? '.' + v.DvBlSignalCompatibilityId : '')
        : 'Dolby Vision'
      : ''
  );

  /* fps + file size (the container/MKV isn't useful to surface here) */
  const plainChip = $derived.by(() => {
    if (!v) return '';
    const plain = [];
    const fps = v.RealFrameRate || v.AverageFrameRate;
    if (fps) plain.push(Math.round(fps * 1000) / 1000 + ' fps');
    if (src.Size) plain.push((src.Size / 1073741824).toFixed(1) + ' GB');
    return plain.join(' · ');
  });

  /* A file far above what the stall watchdog measured this session (P.link):
     say so, quietly, before a long buffering session. Only from a real
     measurement, and only for 30 min — the TV may have moved networks. */
  const LINK_FRESH_MS = 30 * 60 * 1000;
  const slowFor = $derived.by(() => {
    const l = P.link;
    const need = src && src.Bitrate ? src.Bitrate / 1e6 : 0;
    if (hero || !l || !need || Date.now() - l.at > LINK_FRESH_MS || l.got >= need * 0.85) return null;
    return { need: Math.round(need), got: l.got };
  });

  function audioText(s) {
    const comm = isCommentary(s);
    const lang = comm ? 'Commentary' : s.Language ? s.Language.toUpperCase() : '';
    const label = codecPretty(s.Codec) + (isAtmos(s) ? ' Atmos' : '') + (chLayout(s) ? ' ' + chLayout(s) : '');
    return [lang, label].filter(Boolean).join(' · ');
  }

  /* One badge per language. This row answers "which languages can I watch this
     in", not "which stream variants exist" — listing English PGS, English SRT,
     English SDH, German PGS … filled the row with noise. A language whose every
     track is forced is still flagged, because forced-only isn't full subtitles. */
  const subLangs = $derived.by(() => {
    const out = [];
    const seen = new Map();
    for (const s of subs) {
      const label = langName(s.Language);
      let e = seen.get(label);
      if (!e) {
        e = { label, forced: true };
        seen.set(label, e);
        out.push(e);
      }
      if (!s.IsForced) e.forced = false;
    }
    if (!compact) return out;
    // preferred first (in SUB_PREF order), everything else as the file lists it
    const rank = (e) => {
      const i = SUB_PREF.indexOf(e.label);
      return i < 0 ? SUB_PREF.length : i;
    };
    return out.map((e, i) => [e, i]).sort((a, b) => rank(a[0]) - rank(b[0]) || a[1] - b[1]).map((x) => x[0]);
  });

  /* Audio in the order play would pick it (describeTracks' ranking: the
     default track first), so the capped row still shows what you'll hear. */
  const audioOrdered = $derived.by(() => {
    if (!compact) return audio;
    const order = describeTracks(src, item).audio.map((a) => a.index);
    return [...audio].sort((a, b) => order.indexOf(a.Index) - order.indexOf(b.Index));
  });

  /* Collapsing only pays when it hides at least two chips — "+1" is noise. */
  const audioShown = $derived(
    compact && !audioOpen && audioOrdered.length > AUDIO_CAP + 1 ? audioOrdered.slice(0, AUDIO_CAP) : audioOrdered
  );
  const subsShown = $derived(compact && !subsOpen && subLangs.length > SUB_CAP + 1 ? subLangs.slice(0, SUB_CAP) : subLangs);
  const audioMore = $derived(compact && audioOrdered.length > AUDIO_CAP + 1);
  const subsMore = $derived(compact && subLangs.length > SUB_CAP + 1);

  /* The toggle stays the same element (it moves to the row's end), so focus
     never drops; re-reveal it after the row has grown. */
  async function toggle(which) {
    if (which === 'audio') audioOpen = !audioOpen;
    else subsOpen = !subsOpen;
    await focusKey(fkey + '-' + which);
  }
</script>

{#if src}
  <div class="techgrid" class:hero>
    <div class="eyebrow sm">VIDEO</div>
    <div class="chips">
      {#if v}
        <span class="tchip">{resChip}</span>
        <span class="tchip">{codecChip}</span>
        {#if isDovi}
          <span class="tchip">{dvChip}</span>
          {#if vRange.includes('HDR10')}<span class="tchip">HDR10 fallback</span>{/if}
        {:else if vRange.includes('HDR10')}
          <span class="tchip">HDR10</span>
        {:else if vRange.includes('HLG')}
          <span class="tchip">HLG</span>
        {/if}
        {#if plainChip}<span class="tchip plain">{plainChip}</span>{/if}
        {#if slowFor}<span class="tchip plain">{slowFor.need} Mbit/s · the TV got about {slowFor.got} earlier, expect buffering</span>{/if}
      {/if}
    </div>

    <div class="eyebrow sm">AUDIO</div>
    <div class="chips">
      {#each audioShown as s (s.Index)}
        <span class="tchip" class:sel={markSelected && s.Index === P.audioIndex} class:muted={isCommentary(s)}
          >{audioText(s)}{#if (s.Codec || '').toLowerCase() === 'truehd'}&nbsp;<span class="mini">plays as DD+ Atmos</span>{/if}</span
        >
      {/each}
      {#if audioMore}
        <button class="tchip more focus" data-focus="{fkey}-audio" onclick={() => toggle('audio')}
          >{audioOpen ? 'Show less' : '+' + (audioOrdered.length - AUDIO_CAP)}</button
        >
      {/if}
    </div>

    {#if subLangs.length}
      <div class="eyebrow sm">SUBTITLES</div>
      <div class="chips">
        {#each subsShown as s (s.label)}
          <span class="tchip">{s.label}{s.forced ? ' · forced' : ''}</span>
        {/each}
        {#if subsMore}
          <button class="tchip more focus" data-focus="{fkey}-subs" onclick={() => toggle('subs')}
            >{subsOpen ? 'Show less' : '+' + (subLangs.length - SUB_CAP)}</button
          >
        {/if}
      </div>
    {/if}
  </div>
{/if}
