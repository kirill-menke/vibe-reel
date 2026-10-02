<script>
  /* Login — full-screen modal (R.modal === 'login'), per screens/01-login*.html.
   * Remembered accounts (one tap: switchTo → reload), then username/password
   * against the server — which is normally this origin's /jf, so its field is
   * folded under "Server". Same request as the TV's Login
   * (POST /Users/AuthenticateByName). Adding an account (S.addingAccount, from
   * the Accounts sheet) shows Cancel and reloads into the new account; a server
   * change made meanwhile is rolled back if it's cancelled. */
  import { onDestroy, tick } from 'svelte';
  import Icon from '../components/Icon.svelte';
  import Avatar from '../components/Avatar.svelte';
  import { cfg, saveCfg } from '$lib/config.js';
  import { api, errText } from '$lib/api.js';
  import { S } from '$lib/nav.svelte.js';
  import { R, markBooted, closeLoginModal } from '../lib/router.svelte.js';
  import { accounts, rememberCurrent, switchTo, isCurrent } from '$lib/account.svelte.js';
  import { reducedMotion, DUR, EASE } from '../lib/safe.js';

  const adding = S.addingAccount;
  const before = adding ? { ...cfg } : null;
  const defaultServer = location.origin + '/jf';

  let username = $state('');
  let password = $state('');
  let reveal = $state(false);
  let serverUrl = $state(cfg.server);
  let showServer = $state(cfg.server !== defaultServer);
  let busy = $state(false);
  let err = $state(''); // credential problem → under the password
  let serverErr = $state(''); // couldn't reach → under the server field
  let focused = $state('');
  let srvEl = $state(null);
  let userEl = $state(null);
  let pwEl = $state(null);
  let authed = false;
  let gone = false;

  const others = $derived(accounts.list.filter((a) => !(adding && isCurrent(a))));

  function host(u) {
    try {
      return new URL(u).host;
    } catch {
      return u;
    }
  }

  function onAuthed(res) {
    if (gone) return;
    authed = true;
    cfg.token = res.AccessToken;
    cfg.userId = res.User.Id;
    cfg.userName = res.User.Name;
    saveCfg();
    rememberCurrent();
    // a second account, or a re-sign-in over mounted screens that all hold
    // the old session's errors/caches: boot clean
    if (adding || R.booted) location.reload();
    else {
      closeLoginModal();
      markBooted();
    }
  }

  /* A wrong answer shakes the field it's about (the passcode shake);
   * Reduce Motion: the red ring and the hint alone. */
  function shake(input) {
    const box = input?.closest('.field')?.querySelector('.field__box');
    if (!box || reducedMotion()) return;
    box.animate(
      [0, -8, 8, -6, 6, -3, 0].map((x) => ({ transform: `translateX(${x}px)` })),
      { duration: DUR.push, easing: EASE.standard }
    );
  }

  /* Return walks the fields; only the last one submits (LGN-01: by HTML's
   * implicit submission, Return in Username sent an empty password — a
   * "Wrong username or password" and a failed login in Jellyfin's log). */
  function next(e, to) {
    if (e.key !== 'Enter' || e.isComposing) return;
    e.preventDefault();
    to?.focus();
  }

  function submit(e) {
    e?.preventDefault();
    if (busy) return;
    const u = username.trim();
    err = '';
    serverErr = '';
    if (!u) {
      err = 'Enter your username';
      shake(userEl);
      userEl?.focus();
      return;
    }
    const srv = (serverUrl || '').trim().replace(/\/+$/, '') || defaultServer;
    if (srv !== cfg.server) {
      cfg.server = srv;
      saveCfg();
    }
    busy = true;
    api('/Users/AuthenticateByName', { method: 'POST', body: { Username: u, Pw: password } })
      .then(onAuthed)
      .catch((e) => {
        if (gone) return;
        if (e.status === 401) {
          err = 'Wrong username or password';
          shake(pwEl);
          pwEl?.select();
        } else if (e.network || e.status >= 502 || e.status === 404) {
          serverErr = 'Couldn’t reach the server. Check the address and that Tailscale is on.';
          showServer = true;
          tick().then(() => shake(srvEl));
        } else {
          err = errText(e);
          shake(pwEl);
        }
      })
      .finally(() => (busy = false));
  }

  function cancel() {
    closeLoginModal();
  }

  onDestroy(() => {
    gone = true;
    if (before && !authed && cfg.server !== before.server) {
      Object.assign(cfg, before);
      saveCfg();
    }
  });
</script>

<main class="screen screen--no-tabbar">
  <div class="login">
    {#if adding}
      <div style="display:flex;justify-content:flex-end;margin:calc(var(--s-6) * -1) calc(var(--s-3) * -1) 0 0">
        <button type="button" class="btn btn--text" onclick={cancel}><span>Cancel</span></button>
      </div>
    {/if}
    <div class="login__brand">
      <p class="wordmark wordmark--xl">Vibe<span class="wordmark__accent">Reel</span></p>
      <p class="login__tag">{adding ? 'Add an account' : 'Sign in to your Jellyfin server'}</p>
    </div>

    {#if others.length}
      <section>
        <p class="group__label" style="padding-left: var(--s-4)">On this iPhone</p>
        <div class="list" style="margin: 0">
          {#each others as a (a.server + a.userId)}
            <button type="button" class="row row--inset-sep" onclick={() => switchTo(a)}>
              <Avatar account={a} />
              <span class="row__main"><span class="row__title">{a.userName}</span><span class="row__sub">{host(a.server)}</span></span>
              <span class="row__trail"><Icon name="chevron-right" size="sm" /></span>
            </button>
          {/each}
        </div>
      </section>
      <p class="divider">or sign in</p>
    {/if}

    <form class="form" onsubmit={submit} novalidate>
      {#if showServer}
        <label class="field {serverErr ? 'field--error' : focused === 'srv' ? 'field--focus' : ''}">
          <span class="field__label">Server address</span>
          <span class="field__box"
            ><Icon name="server" size="sm" /><input
              class="field__input"
              type="url"
              inputmode="url"
              autocapitalize="off"
              autocorrect="off"
              spellcheck="false"
              enterkeyhint="next"
              bind:this={srvEl}
              onkeydown={(e) => next(e, userEl)}
              bind:value={serverUrl}
              onfocus={() => (focused = 'srv')}
              onblur={() => (focused = '')}
            /></span
          >
          {#if serverErr}<span class="field__hint">{serverErr}</span>{/if}
        </label>
      {/if}
      <label class="field {focused === 'u' ? 'field--focus' : ''}">
        <span class="field__label">Username</span>
        <span class="field__box"
          ><Icon name="user" size="sm" /><input
            class="field__input"
            type="text"
            autocapitalize="off"
            autocorrect="off"
            autocomplete="username"
            enterkeyhint="next"
            placeholder="Username"
            bind:this={userEl}
            onkeydown={(e) => next(e, pwEl)}
            bind:value={username}
            onfocus={() => (focused = 'u')}
            onblur={() => (focused = '')}
          /></span
        >
      </label>
      <label class="field {err ? 'field--error' : focused === 'p' ? 'field--focus' : ''}">
        <span class="field__label">Password</span>
        <span class="field__box"
          ><Icon name="lock" size="sm" /><input
            class="field__input"
            type={reveal ? 'text' : 'password'}
            autocomplete="current-password"
            enterkeyhint="go"
            placeholder="Password"
            bind:this={pwEl}
            bind:value={password}
            onfocus={() => (focused = 'p')}
            onblur={() => (focused = '')}
          /><button class="search__clear" type="button" aria-label={reveal ? 'Hide password' : 'Show password'} onclick={() => (reveal = !reveal)}
            ><Icon name={reveal ? 'eye-off' : 'eye'} size="sm" /></button
          ></span
        >
        {#if err}<span class="field__hint">{err}</span>{/if}
      </label>
      <button class="btn btn--primary btn--block" type="submit" style="margin-top: var(--s-2)" disabled={busy || undefined} aria-busy={busy || undefined}>
        {#if busy}<span class="spinner" style="--spinner: 18px"></span><span>Signing in…</span>
        {:else if serverErr}<Icon name="refresh" size="sm" /><span>Try again</span>
        {:else}<span>Sign in</span>{/if}
      </button>
      {#if !showServer}
        <button type="button" class="btn btn--text login__server" onclick={() => (showServer = true)}>
          <Icon name="server" size="sm" /><span>Server · {host(cfg.server)}</span>
        </button>
      {/if}
    </form>
  </div>
</main>
