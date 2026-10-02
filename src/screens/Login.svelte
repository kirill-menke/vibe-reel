<script module>
  /* Set by a caller that opens Login specifically to change the server (Home's
   * "Can't reach Jellyfin" card): the Server URL field starts out showing and
   * focused. Read once per mount. */
  export const loginOpts = { server: false };
</script>

<script>
  import { onMount, onDestroy, tick } from 'svelte';
  import Wordmark from '../components/Wordmark.svelte';
  import { cfg, saveCfg } from '../lib/config.js';
  import { api, qs, errText } from '../lib/api.js';
  import { S, openHome } from '../lib/nav.svelte.js';
  import { toast } from '../lib/toast.svelte.js';
  import { focusFirst, focusNow, focusKey } from '../lib/focus.js';
  import { rememberCurrent } from '../lib/account.svelte.js';

  let username = $state('');
  let password = $state('');
  let err = $state('');
  let qcCode = $state('');
  let qcNote = $state('');
  let qcAvailable = $state(true);
  /* the code in qcCode stopped working (expired, or the server stopped
   * answering the poll) — offer a fresh one instead of showing it forever */
  let qcDead = $state('');
  let busy = $state(false);
  // no server yet (a build without VITE_JELLYFIN_URL): ask for it first
  let showServer = $state(loginOpts.server || !cfg.server);
  const serverFirst = loginOpts.server || !cfg.server;
  loginOpts.server = false;
  let serverUrl = $state(cfg.server);
  let qcTimer = null;
  /* Bumped by every new code and by leaving the screen: an Initiate answer
   * that lands after either must not start a poll. (Back out of Login while a
   * slow server is still handing out a code used to leave a 2 s poll running
   * behind the next screen for the code's full 10 minutes.) */
  let qcGen = 0;

  /* Adding an account (avatar menu): the session underneath stays signed in
   * until this one succeeds, so a server change made here — which writes cfg —
   * is undone if the screen is left with Back. */
  const before = S.addingAccount ? { ...cfg } : null;
  let authed = false;
  /* Set once the screen is gone. A sign-in answer (password, or the Quick
   * Connect exchange) landing after Back out of "Add an account" must not
   * switch accounts behind the user's back — nor pair the new token with the
   * server URL onDestroy just restored, which booted into a 401 and saved a
   * broken entry in the account list. */
  let gone = false;

  function onAuthed(res) {
    if (gone) return;
    clearInterval(qcTimer);
    authed = true;
    cfg.token = res.AccessToken;
    cfg.userId = res.User.Id;
    cfg.userName = res.User.Name;
    saveCfg();
    rememberCurrent();
    // a second account: boot clean into it rather than carry the first one's caches
    if (before) location.reload();
    else openHome();
  }

  /* Jellyfin forgets a Quick Connect secret after ~10 minutes; polling it
   * then answers 404 (or 400/401). A dead poll used to be swallowed, leaving a
   * code on screen that could never work. Now an HTTP rejection, a string of
   * network failures, or the 10-minute mark ends the poll and says so. */
  const QC_MAX_AGE = 10 * 60 * 1000;
  const QC_MAX_NET_FAILS = 5;   // ×2 s poll = ~10 s of no answer at all

  function qcStop(why) {
    clearInterval(qcTimer);
    qcTimer = null;
    qcDead = why;
  }

  function startQuickConnect() {
    clearInterval(qcTimer);
    qcCode = '';
    qcDead = '';
    qcAvailable = true;
    qcNote = 'requesting a Quick Connect code…';
    const g = ++qcGen;
    if (!cfg.server) {
      qcNote = 'enter your Jellyfin server below (e.g. http://192.168.1.10:8096)';
      return;
    }
    api('/QuickConnect/Initiate', { method: 'POST' })
      .then((r) => {
        if (g !== qcGen) return;
        qcCode = r.Code;
        qcNote = '';
        const secret = r.Secret;
        const born = Date.now();
        let netFails = 0;
        let polling = false;
        const timer = (qcTimer = setInterval(() => {
          if (Date.now() - born > QC_MAX_AGE) {
            qcStop('This code has expired.');
            return;
          }
          if (polling) return;
          polling = true;
          api('/QuickConnect/Connect' + qs({ Secret: secret }))
            .then((st) => {
              if (qcTimer !== timer) return;   // superseded by a new code
              netFails = 0;
              if (st && st.Authenticated) {
                clearInterval(qcTimer);
                qcTimer = null;
                api('/Users/AuthenticateWithQuickConnect', { method: 'POST', body: { Secret: secret } })
                  .then(onAuthed)
                  .catch((e) => qcStop('Quick Connect sign-in failed: ' + errText(e)));
              }
            })
            .catch((e) => {
              if (qcTimer !== timer) return;
              if (e.status >= 500) qcStop(errText(e) + '.');
              else if (e.status) qcStop('This code has expired.');
              else if (++netFails >= QC_MAX_NET_FAILS) qcStop(errText(e) + '.');
            })
            .finally(() => (polling = false));
        }, 2000));
      })
      .catch(() => {
        if (g === qcGen) qcAvailable = false;
      });
  }

  function doLogin() {
    if (busy) return;   // Enter on the password field and OK on the button both land here
    const u = username.trim();
    if (!u) {
      err = 'Enter your username';
      focusNow('u');
      return;
    }
    busy = true;
    err = '';
    api('/Users/AuthenticateByName', { method: 'POST', body: { Username: u, Pw: password } })
      .then(onAuthed)
      .catch((e) => {
        err = e.status === 401 ? 'Wrong username or password' : errText(e);
      })
      .finally(() => (busy = false));
  }

  /* Enter on the username field moves on to the password (Keys.svelte submits
   * on Enter in the password field). Stopped here so the global handler doesn't
   * also see it — by then focus would already be on the password field. */
  function userKey(e) {
    if (e.keyCode !== 13) return;
    e.preventDefault();
    e.stopPropagation();
    focusNow('p');
  }

  async function newCode() {
    startQuickConnect();
    await tick();
    // the button just went away with the dead code; stay on the form
    if (!document.activeElement || document.activeElement === document.body) focusNow('u');
  }

  /* First press reveals the field, second applies it — same two-step as before. */
  async function changeServer() {
    if (!showServer) {
      showServer = true;
      await tick();
      focusNow('srv');
      return;
    }
    cfg.server = (serverUrl || cfg.server).trim();
    saveCfg();
    toast('Server: ' + cfg.server);
    startQuickConnect();
  }

  onMount(() => {
    startQuickConnect();
    S.ready = true;
    if (serverFirst) focusKey('srv');
    else focusFirst();
  });

  onDestroy(() => {
    gone = true;
    qcGen++;
    clearInterval(qcTimer);
    if (before && !authed && cfg.server !== before.server) {
      Object.assign(cfg, before);
      saveCfg();
    }
  });
</script>

<div class="screen login">
  <div class="card">
    <div class="brand"><Wordmark size={64} /></div>
    <div class="sub">{before ? 'Add an account' : 'Sign in to Jellyfin'} — {cfg.server}</div>

    <div id="qc">
      {#if qcCode && qcDead}
        <div class="qc-dead">{qcDead}</div>
        <button class="btn ghost big focus" data-focus="qc-new" onclick={newCode}>Get a new code</button>
      {:else if qcCode}
        <div style="color:var(--t3);font-size:20px">
          Quick Connect — enter this code in Jellyfin (phone/web › your name › Quick Connect):
        </div>
        <div class="qc-code">{qcCode}</div>
      {:else if !qcAvailable}
        <div style="color:var(--t3)">Quick Connect unavailable — use your password below.</div>
        <button class="btn ghost big focus" data-focus="qc-new" onclick={newCode}>Try Quick Connect again</button>
      {:else}
        <div class="loading" style="padding:0">{qcNote}</div>
      {/if}
    </div>

    <div style="margin:34px 0 10px;color:var(--t3)">or sign in with your password</div>

    {#if showServer}
      <div class="field">
        <label for="srv">Server URL</label>
        <input id="srv" class="focus" data-focus="srv" bind:value={serverUrl} />
      </div>
    {/if}

    <div class="field">
      <label for="u">Username</label>
      <input id="u" class="focus" data-focus="u" autocomplete="off" enterkeyhint="next" onkeydown={userKey} bind:value={username} />
    </div>
    <div class="field">
      <label for="p">Password</label>
      <input id="p" type="password" class="focus" data-focus="p" enterkeyhint="go" bind:value={password} />
    </div>

    <div class="err">{err}</div>

    <div class="row">
      <button class="btn primary big focus" class:busy data-focus="login" aria-disabled={busy} onclick={doLogin}
        >{busy ? 'Signing in…' : 'Sign in'}</button
      >
      <button class="btn ghost big focus" data-focus="server" onclick={changeServer}>Change server</button>
    </div>
  </div>
</div>
