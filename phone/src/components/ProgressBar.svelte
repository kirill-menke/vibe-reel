<script>
  /* ProgressBar — `.progress` + fill. p: 0–1. class: extra (e.g. 'tile__progress').
   *   label  what it measures, for VoiceOver ('Watched', 'Downloaded'); default 'Watched' (playback progress) */
  /** @type {{ p?: number | null, label?: string, class?: string, style?: string }} */
  let { p = 0, label = 'Watched', class: cls = '', style = '' } = $props();
  const v = $derived(Math.max(0, Math.min(1, Number(p) || 0)));
</script>

<div class="progress {cls}" style="--p: {v}; {style}" role="progressbar" aria-label={label} aria-valuemin="0" aria-valuemax="100" aria-valuenow={Math.round(v * 100)}>
  <div class="progress__fill"></div>
</div>
