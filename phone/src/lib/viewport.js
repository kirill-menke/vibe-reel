/* The shell never scrolls: body and #app are position: fixed, inset 0 (app.css),
 * and every page scrolls its own .screen. The one thing that still moves the
 * page is the iOS keyboard — focusing Search's field pans the visual viewport
 * up to reveal the input, and after the keyboard closes iOS (17–26, standalone
 * especially) does not always pan back: visualViewport.offsetTop stays > 0
 * and the whole app sits shifted up with an empty band under the tab bar.
 * Once no field has focus any more, put the viewport back at 0,0.
 * Harmless where it never happens (the check is two numbers). */

import { toast } from '$lib/toast.svelte.js';

/** @type {(el: (Element & { isContentEditable?: boolean }) | null) => boolean} */
const editable = (el) =>
  !!el && (el.isContentEditable || el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT');

export function initViewport() {
  const vv = window.visualViewport;
  let t = 0;
  const settle = () => {
    clearTimeout(t);
    // after the keyboard's own close animation (and a focus hop between fields)
    t = setTimeout(() => {
      if (editable(document.activeElement) || (vv && vv.scale > 1.01)) return;   // typing, or a pinch-zoom the user made
      if (window.scrollX || window.scrollY || (vv && vv.offsetTop > 0)) window.scrollTo(0, 0);
    }, 150);
  };
  addEventListener('focusout', settle);
  vv?.addEventListener('resize', settle);
  setTimeout(staleInstallHint, 4000);
}

/* A Home Screen install made while index.html asked for the opaque `black`
 * status bar (2026-09-30 → 10-01) keeps it (iOS reads the tag at install
 * time only), so it never draws behind the Dynamic Island. Tell the user once
 * a day how to get the full screen. Precise: that install has
 * safe-area-inset-top 0 in portrait; a black-translucent one has ≥ 20. */
function staleInstallHint() {
  if (!navigator.standalone || innerWidth > innerHeight || document.visibilityState !== 'visible') return;
  const probe = document.createElement('div');
  probe.style.cssText = 'position:fixed;visibility:hidden;pointer-events:none;height:env(safe-area-inset-top,0px)';
  document.body.append(probe);
  const top = probe.getBoundingClientRect().height;
  probe.remove();
  if (top >= 20) return;
  const KEY = 'reel.reinstallHint';
  try {
    if (Date.now() - Number(localStorage.getItem(KEY) || 0) < 86400e3) return;
    localStorage.setItem(KEY, String(Date.now()));
  } catch { /* no storage: show it anyway */ }
  toast('To use the whole screen, remove VibeReel from the Home Screen and add it again from Safari.');
}
