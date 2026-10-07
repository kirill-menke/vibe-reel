<script module>
  import { HM } from '../lib/header.svelte.js';
  import { ME, MY } from '../lib/me.svelte.js';
  import { focusKey, focusFirst } from '../lib/focus.js';

  /** @param {Reel.OwnedTitle} t the data-focus suffix: "movie-603" */
  const fk = (t) => t.type + '-' + t.id;

  /* The rows around the title under the confirmation, taken when it opened:
   * the title may leave the list meanwhile (deleted on another device — a
   * refresh after another delete drops it), and then focus goes next door. */
  /** @type {string[]} */
  let near = [];

  /** @param {Reel.OwnedTitle} t */
  function remember(t) {
    const titles = ME.me ? ME.me.titles : [];
    const at = titles.findIndex((x) => x.type === t.type && x.id === t.id);
    near = at < 0 ? [] : [titles[at + 1], titles[at - 1]].filter(Boolean).map((x) => 'my-' + fk(/** @type {Reel.OwnedTitle} */ (x)));
  }

  /* Keep or Back on the confirmation: the list again, on that row's Delete —
   * or, with the row gone, the next row, the previous one, the empty state's
   * Search, whatever is first in the panel. Never <body>. */
  export async function backToList() {
    const t = MY.confirm;
    MY.confirm = null;
    HM.open = 'mylib';
    for (const k of [t && 'my-del-' + fk(t), ...near, 'my-search']) {
      if (k && (await focusKey(k))) return;
    }
    await focusFirst();
  }
</script>

<script>
  /* The avatar menu's My library (run/design.md §6.3–6.4): one more .lvmenu
   * hung from the avatar, so focus.js makes it modal exactly like the account
   * list, and Back closes it onto the avatar (Keys.svelte, HM_BUTTON).
   *
   * HM.open === 'mylib': the quota bars (a normal user's movies and shows,
   * "3 of 10"; an admin "Admin · no limit") and the titles this user added
   * (GET /api/me, me.svelte.js), each a row with its status and a Delete.
   * HM.open === 'mylib-del': the confirmation for MY.confirm, rendered
   * *instead of* the list in the same spot, so the D-pad can't wander off it.
   * It opens on Keep; Back or Keep return to the list on that row's Delete.
   * Delete deletes the title from the server with its files — for everyone. */
  import Icon from './Icon.svelte';
  import { deleting, deleteTitle, titleKey, titleStatus, deleteMessage } from '../lib/me.svelte.js';
  import { lookupOpener } from '../lib/lookup.svelte.js';
  import { posterThumb } from '../lib/medialib.js';
  import { openSearch } from '../lib/nav.svelte.js';

  const me = $derived(ME.me);
  const titles = $derived(me ? me.titles : []);

  /** @type {[Reel.MediaType, string][]} */
  const KINDS = [
    ['movie', 'Movies'],
    ['tv', 'Shows']
  ];

  /** @param {Reel.QuotaUse} q @returns {number} 0..100 */
  const pct = (q) => (q.limit ? Math.min(100, (q.used / q.limit) * 100) : 100);
  /** @param {Reel.QuotaUse} q */
  const isFull = (q) => q.limit != null && q.used >= q.limit;

  /** @param {Reel.OwnedTitle} t */
  async function open(t) {
    HM.open = null;
    const go = await lookupOpener({ id: t.id, type: t.type, title: t.title, year: t.year ?? undefined, poster: t.poster, added: true });
    go();
  }

  /** @param {Reel.OwnedTitle} t */
  function ask(t) {
    if (deleting[titleKey(t)]) return; // already going
    remember(t);
    MY.confirm = t;
    HM.open = 'mylib-del';
    focusKey('my-keep'); // the safe default
  }

  const keep = backToList;

  async function confirmDelete() {
    const t = MY.confirm;
    if (!t) return;
    const at = titles.findIndex((x) => x.type === t.type && x.id === t.id);
    const next = titles[at + 1] || null;
    const prev = at > 0 ? titles[at - 1] : null;
    const own = ['my-' + fk(t), 'my-del-' + fk(t)];
    MY.confirm = null;
    HM.open = 'mylib';
    await focusKey(own[1]); // back on the row, which now says "Deleting…"
    if (!(await deleteTitle(t))) return; // the row stays; focus too
    if (HM.open !== 'mylib') return; // the panel was closed meanwhile
    /* Only move focus if it is still on that row (or fell to <body> with it):
     * the D-pad may have walked on while the delete ran. */
    const a = /** @type {HTMLElement | null} */ (document.activeElement);
    if (a && a !== document.body && !own.includes(a.dataset?.focus || '')) return;
    for (const k of [next && 'my-' + fk(next), prev && 'my-' + fk(prev), 'my-search']) {
      if (k && (await focusKey(k))) return;
    }
  }

  function search() {
    HM.open = null;
    openSearch();
  }

  /* The first row brings the quota bars back into view; any other row just
   * stays visible. */
  /** @param {FocusEvent} e */
  function keepInView(e) {
    const el = /** @type {HTMLElement | null} */ (e.target);
    const menu = /** @type {HTMLElement} */ (e.currentTarget);
    if (el && el.closest('.myrow') === menu.querySelector('.myrow')) menu.scrollTop = 0;
    else el?.scrollIntoView?.({ block: 'nearest' });
  }
</script>

{#if HM.open === 'mylib-del' && MY.confirm}
  {@const t = MY.confirm}
  <div class="lvmenu hmenu mylib confirm" role="dialog" aria-label="Delete {t.title}">
    <div class="lvcap">Delete from the server</div>
    <div class="myconf">
      <span class="nwposter">{#if t.poster}<img src={posterThumb(t.poster)} alt="" onerror={(e) => e.currentTarget.remove()} />{/if}</span>
      <div class="myconftext">
        <div class="myconfq">Delete “{t.title}”{t.year ? ' (' + t.year + ')' : ''}?</div>
        <div class="msg">
          {deleteMessage(t.type)}
        </div>
      </div>
    </div>
    <div class="myconfbtns">
      <button class="opt focus mykeep" data-focus="my-keep" onclick={keep}>Keep</button>
      <button class="opt focus mydanger" data-focus="my-delete" onclick={confirmDelete}><Icon name="trash" /><span>Delete</span></button>
    </div>
  </div>
{:else}
  <div class="lvmenu hmenu mylib" role="list" aria-label="My library" onfocusin={keepInView}>
    <div class="lvcap">My library</div>
    {#if me}
      <div class="myquota">
        {#if me.admin}
          <div class="myadmin">Admin · no limit</div>
        {:else}
          {#each KINDS as [k, label] (k)}
            {@const q = me.quota[k]}
            <div class="myq" class:full={isFull(q)} data-kind={k}>
              <div class="myqhead"><span>{label}</span><span class="myqn">{q.used} of {q.limit}{isFull(q) ? ' · full' : ''}</span></div>
              <div class="mybar"><b style:width="{pct(q)}%"></b></div>
            </div>
          {/each}
        {/if}
      </div>
      <div class="lvcap">{me.admin ? 'Titles you added' : 'Your titles'}</div>
      {#each titles as t (titleKey(t))}
        <div class="nwrow myrow" class:busy={deleting[titleKey(t)]}>
          <button class="opt focus nwmain mymain" data-focus="my-{fk(t)}" onclick={() => open(t)}>
            <span class="nwposter">{#if t.poster}<img src={posterThumb(t.poster)} alt="" onerror={(e) => e.currentTarget.remove()} />{/if}</span>
            <span class="nwtext">
              <span class="nwtitle">{t.title}</span>
              <span class="nwseason">{t.type === 'tv' ? 'Show' : 'Movie'}{t.year ? ' · ' + t.year : ''}</span>
              <span class="nwline mystatus" class:found={t.status === 'in_library'}>{titleStatus(t)}</span>
            </span>
          </button>
          <button class="opt focus nwget mydel" data-focus="my-del-{fk(t)}" onclick={() => ask(t)}>
            <Icon name="trash" /><span>Delete</span>
          </button>
        </div>
      {:else}
        <button class="opt focus myempty" data-focus="my-search" onclick={search}>Nothing added yet — find something in Search</button>
      {/each}
    {:else}
      <div class="nwempty">Couldn’t load your library right now.</div>
    {/if}
  </div>
{/if}
