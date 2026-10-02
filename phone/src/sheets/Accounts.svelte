<script>
  /* Accounts — the avatar's sheet (design screens/11-accounts.html), the TV's
   * TopNav account menu: every account remembered on this device
   * (account.svelte.js). Switching and signing out reload the app, exactly as
   * on the TV — caches, the Home store and the "seen" lists belong to the
   * previous user. Settings closes the sheet and pushes on the current tab. */
  import Sheet from '../components/Sheet.svelte';
  import List from '../components/List.svelte';
  import Row from '../components/Row.svelte';
  import Avatar from '../components/Avatar.svelte';
  import Icon from '../components/Icon.svelte';
  import { closeSheet, push } from '../lib/router.svelte.js';
  import { openLogin } from '$lib/nav.svelte.js';
  import { accounts, isCurrent, switchTo, signOut } from '$lib/account.svelte.js';
  import { cfg } from '$lib/config.js';
  import { pushSignOut } from '../lib/push.js';
  import { confirm } from '../lib/confirm.svelte.js';

  let { params = {} } = $props();

  const host = (s) => {
    try {
      return new URL(s, location.href).host;
    } catch {
      return s || '';
    }
  };
  const here = host(cfg.server);
  // the current account first, then the rest in the order they were added
  const list = $derived([...accounts.list].sort((a, b) => isCurrent(b) - isCurrent(a)));

  let busy = $state(false);
  /* Both reload into another session: take this iPhone's push subscription
   * off the server first, or the old account's notifications keep coming
   * (the next start registers it for whoever is signed in then). */
  function pick(a) {
    if (isCurrent(a)) return closeSheet();
    if (busy) return;
    busy = true;
    pushSignOut().finally(() => switchTo(a)); // reloads
  }

  function openSettings() {
    closeSheet();
    push('settings');
  }

  /* Sign out asks first (one stray tap used to end the session and reload
   * the app): an iOS action sheet (ACT-01) — "Sign out of alice?", who it
   * switches to, a red Sign Out and Cancel. It replaced the earlier armed
   * row ("Tap again to sign out"), whose only feedback was its own text. */
  const nextUp = $derived(accounts.list.find((a) => !isCurrent(a))); // who signOut() switches to
  async function out() {
    if (busy) return;
    const ok = await confirm({
      title: 'Sign out of ' + (cfg.userName || 'this account') + '?',
      message: nextUp ? 'Switches to ' + (nextUp.userName || 'the next account') + '.' : 'Signing back in needs the password.',
      action: 'Sign Out'
    });
    if (!ok || busy) return;
    busy = true;
    await pushSignOut();
    await signOut(); // reloads
  }
</script>

<Sheet title="Accounts">
  <p class="group__label">On this iPhone · {here}</p>
  <List role="radiogroup">
    {#each list as a (a.server + a.userId)}
      {@const me = isCurrent(a)}
      <Row
        insetSep
        selected={me}
        check={me}
        title={a.userName || 'Unnamed'}
        sub={me ? 'Signed in' : host(a.server) === here ? 'Tap to switch' : 'Tap to switch · ' + host(a.server)}
        role="radio"
        aria-checked={me}
        disabled={busy || undefined}
        onclick={() => pick(a)}
      >
        {#snippet lead()}<Avatar account={a} />{/snippet}
      </Row>
    {/each}
    <Row insetSep action title="Add account" onclick={() => (closeSheet(), openLogin(true))}>
      {#snippet lead()}<span class="avatar accounts__add"><Icon name="plus" size="sm" /></span>{/snippet}
    </Row>
  </List>
  <List group>
    <Row icon="settings" title="Settings" chevron onclick={openSettings} />
    <Row
      danger
      icon="logout"
      iconStyle="color: var(--danger); background: var(--danger-soft)"
      title={'Sign out of ' + (cfg.userName || 'this account')}
      disabled={busy || undefined}
      onclick={out}
    />
  </List>
</Sheet>
