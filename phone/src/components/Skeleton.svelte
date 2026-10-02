<script>
  /* Skeleton — `.skel` placeholder block: still 400 ms, three breaths, then rests (MOT-06).
   *   kind   'poster' | 'thumb' | 'line' | 'line-lg' | 'pill' | 'circle' | 'hero' | '' (plain)
   *   w, h   CSS sizes (e.g. '60%', '44px'); class / style extra */
  let { kind = '', w = '', h = '', class: cls = '', style = '' } = $props();
</script>

<div
  class="skel {kind ? 'skel--' + kind : ''} {cls}"
  style="{w ? 'width:' + w + ';' : ''}{h ? 'height:' + h + ';' : ''}{style}"
  aria-hidden="true"
></div>
