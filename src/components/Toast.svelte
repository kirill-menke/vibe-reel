<script>
  import { toastState } from '../lib/toast.svelte.js';
  import Icon from './Icon.svelte';
</script>

<div id="toast" class:show={toastState.show}>{toastState.msg}{#if toastState.undo}<span class="undo"><Icon name="play" inline />Undo</span>{/if}</div>
