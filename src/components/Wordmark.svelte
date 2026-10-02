<script>
  import { GLYPH } from '../lib/icons.js';

  let { size = 0 } = $props();
</script>

<span class="wordmark" style={size ? `font-size:${size}px` : null}><svg class="mark" viewBox="0 0 100 100" aria-hidden="true">{@html GLYPH}</svg><span class="v">Vibe</span><span class="r">Reel</span></span>
