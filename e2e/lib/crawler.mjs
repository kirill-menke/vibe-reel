/* TV invariant crawler: explores a screen's focus graph with trusted D-pad
 * keys and checks the focus invariants (invariants.mjs) after every press.
 *
 *   const r = await crawl(page, {
 *     name: 'home',                 // for messages
 *     keys: ['Up','Down','Left','Right'],
 *     dupOk: ['tile-'],             // data-focus prefixes allowed to repeat in scope
 *     maxStates: 80,                // stop once this many states are expanded
 *     maxPresses: 700, timeLimit: 85000,
 *     settle: 250,                  // ms after each press (hero/rail transitions)
 *     leaveSettle: 700,             // at most this long after a press that left the screen for
 *                                   // focus to rest (150 ms on one element); Back then gets
 *                                   // leaveSettle + 1 s to land on the start screen again
 *     restore: async () => {},      // bring the app back to the start state (reload + boot);
 *                                   // without it a lost crawl ends early (reported)
 *     check: async (page, state) => [] // extra per-press checks → problems
 *     prefer: (id) => bool          // travel to preferred unexpanded states first
 *                                   // (e.g. the bar's pills before the 140th tile)
 *   });
 *   r = { states, edges, keys, problems, leaves, presses, restores, ms, complete }
 *
 * A STATE is the focused element in the active scope: its data-focus key plus
 * its ordinal among elements with that key (Home's rails share tile-<id> keys
 * by design), within a SIGNATURE = scope kind (.screen / .lvmenu / #search /
 * #video-layer …) + the mounted screen's class. The crawl starts wherever
 * focus is, never calls element.focus(): every state is reached by replaying
 * recorded D-pad edges, which is the thing under test.
 *
 * Exploration is the classic online graph search: press an untried key of the
 * current state if it has one, else walk the shortest known path to the
 * nearest state that still has untried keys (BFS over the recorded edges).
 * Every state reachable by the given keys gets each key tried once (until a
 * limit). An edge whose landing differs from the recorded one (focus memory,
 * scroll position, a hero swap) is re-recorded and the walk re-planned.
 *
 * An edge that changes the signature LEFT the screen (▲ on the tab row raises
 * Search, a dropdown opens …): it is recorded in `leaves`, Back is pressed,
 * and Back must bring back the start signature with focus on a real element —
 * otherwise that is a problem. Leave edges are never used for travel.
 *
 * Problems: focus on <body>, any invariants.mjs violation, a Back that did not
 * return, a press that left focus unreachable. Each distinct message is kept
 * once, with the edge that first produced it. */
import { checkFocusInvariants, inPageScope } from './invariants.mjs';
import { sleep } from './page.mjs';

/* serialisable: runs in the page */
function probeSrc(scopeSrc) {
  const scope = new Function('return (' + scopeSrc + ')')()();
  const scr = document.querySelector('.screen');
  const screen = scr ? [...scr.classList].filter((c) => c !== 'screen').join('.') || 'screen' : 'none';
  const a = document.activeElement;
  const body = !a || a === document.body || a === document.documentElement || !a.isConnected;
  let key = null;
  let ord = 0;
  if (!body) {
    key = a.dataset?.focus || null;
    if (key) ord = scope.all.filter((e) => e.dataset.focus === key).indexOf(a);
  }
  const desc = body ? '<body>' : key ? key + (ord > 0 ? '#' + ord : '') : `<${a.tagName.toLowerCase()}.${String(a.className).split(' ').join('.')}>`;
  return { sig: scope.kind + '|' + screen, id: desc, key, body };
}

export async function probe(page) {
  return page.eval(`(${probeSrc})(${JSON.stringify(inPageScope.toString())})`);
}

export async function crawl(page, opts = {}) {
  const {
    name = 'crawl', keys = ['Up', 'Down', 'Left', 'Right'], dupOk = [], maxStates = 80, maxPresses = 700,
    timeLimit = 85000, settle = 250, leaveSettle = 700, restore = null, check = null, log = () => {}, prefer = null
  } = opts;
  const t0 = Date.now();
  const states = new Map(); // id → { id, key, tried: Set }
  const edges = new Map(); // id → Map(key → id)   (latest observation)
  const seenEdges = new Map(); // `${id} ${k}` → Set(target ids)  (every observation)
  const leaves = [];
  const problems = [];
  const probSeen = new Set();
  let presses = 0;
  let restores = 0;
  let limit = null;

  const problem = (msg, ctx) => {
    if (probSeen.has(msg)) return;
    probSeen.add(msg);
    problems.push(`${msg}  (${ctx})`);
  };
  const addState = (s) => {
    if (!states.has(s.id)) states.set(s.id, { id: s.id, key: s.key, tried: new Set() });
    return states.get(s.id);
  };
  const record = (from, k, to) => {
    if (!edges.has(from)) edges.set(from, new Map());
    edges.get(from).set(k, to);
    const sk = from + ' ' + k;
    if (!seenEdges.has(sk)) seenEdges.set(sk, new Set());
    seenEdges.get(sk).add(to);
  };

  let start = await probe(page);
  if (start.body) throw new Error(`${name}: crawl start has focus on <body>`);
  const startSig = start.sig;
  addState(start);
  for (const p of await invariants()) problem(p, 'at start ' + start.id);

  /* checkFocusInvariants, except that duplicates whose second copy sits in
   * an [inert] subtree (a Svelte block mid-outro — F-006, Home's hero .info
   * for 220 ms after a hero swap) are re-checked once that outro has ended,
   * as 20-tv-home does: only what is still wrong then is a problem */
  async function invariants() {
    let bad = await checkFocusInvariants(page, { dupOk });
    if (bad.length && bad.every((b) => b.endsWith('(one copy is an inert outro)'))) {
      await page.waitFor(() => !document.querySelector('.screen [inert], #search [inert]'), { what: 'outro finished', timeout: 3000 });
      bad = await checkFocusInvariants(page, { dupOk });
    }
    return bad;
  }

  /* probe until the focused element (sig + id, not <body>) is unchanged for
   * 150 ms, or leaveSettle ms have passed; returns the last probe */
  async function settled(s) {
    const t1 = Date.now();
    let since = Date.now();
    while (Date.now() - t1 < leaveSettle) {
      await sleep(50);
      const n = await probe(page);
      if (n.sig !== s.sig || n.id !== s.id || n.body !== s.body) since = Date.now();
      s = n;
      if (!s.body && Date.now() - since >= 150) break;
    }
    return s;
  }

  /* one press + all checks; returns the landing state (after Back, for a leave) */
  async function step(from, k) {
    presses++;
    await page.key(k, { settle });
    let s = await probe(page);
    const ctx = `${from.id} --${k}-->`;
    if (s.sig !== startSig) {
      // the press left the screen (or is passing through a transition): wait
      // — at most leaveSettle — until focus rests on one element for 150 ms
      s = await settled(s);
      if (s.sig !== startSig) {
        leaves.push({ from: from.id, key: k, to: s.sig + ' ' + s.id });
        if (s.body) problem(`focus on <body> after leaving to ${s.sig}`, ctx);
        else for (const p of await invariants()) problem(p, ctx + ' ' + s.sig);
        presses++;
        await page.key('Back', { settle: 0 });
        let back = await probe(page);
        // the parent screen remounts: up to leaveSettle + 1 s to get focus back
        for (const tb = Date.now(); (back.sig !== startSig || back.body) && Date.now() - tb < leaveSettle + 1000; ) {
          await sleep(50);
          back = await probe(page);
        }
        // a remembered-focus restore (takeGridFocus etc.) may still move it
        if (back.sig === startSig && !back.body) back = await settled(back);
        if (back.sig !== startSig) problem(`Back from ${s.sig} did not return to ${startSig} (got ${back.sig})`, ctx);
        else if (back.body) problem(`Back from ${s.sig} left focus on <body>`, ctx);
        return { s: back, left: true };
      }
    }
    if (s.body) {
      problem('focus is on <body> (the D-pad has nothing to move from)', ctx);
      return { s, left: false };
    }
    for (const p of await invariants()) problem(p, ctx + ' ' + s.id);
    if (check) for (const p of (await check(page, s)) || []) problem(p, ctx + ' ' + s.id);
    return { s, left: false };
  }

  async function doRestore(why) {
    if (!restore) return false;
    restores++;
    log(`${name}: restore (${why}) at ${cur.sig} ${cur.id}; unexpanded: ${[...states.values()].filter((x) => keys.some((k) => !x.tried.has(k))).map((x) => x.id).join(' ')}`);
    await restore();
    const s = await probe(page);
    if (s.body || s.sig !== startSig) {
      problem(`restore did not reach the start (${s.sig} ${s.id})`, why);
      return false;
    }
    if (!states.has(s.id)) addState(s);
    cur = s;
    return true;
  }

  /* shortest known path (list of keys + expected ids) from `from` to the
   * nearest state with untried keys */
  function plan(from) {
    const prev = new Map([[from, null]]);
    const q = [from];
    let fallback = null; // nearest non-preferred candidate, when `prefer` is set
    const pathTo = (id) => {
      const path = [];
      for (let x = id; prev.get(x); x = prev.get(x).from) path.unshift(prev.get(x));
      return path;
    };
    while (q.length) {
      const id = q.shift();
      const st = states.get(id);
      if (st && keys.some((k) => !st.tried.has(k)) && id !== from) {
        if (!prefer || prefer(id)) return pathTo(id);
        if (!fallback) fallback = id;
      }
      // every target ever observed for an edge is a candidate hop (a press can
      // land differently with another scroll/hero state); the walk verifies
      // each hop and re-plans on a miss. Self-loops and leaves never help.
      for (const k of keys) {
        for (const to of seenEdges.get(id + ' ' + k) || []) {
          if (to === id || to.startsWith('LEAVE ') || prev.has(to)) continue;
          prev.set(to, { from: id, k, to });
          q.push(to);
        }
      }
    }
    return fallback ? pathTo(fallback) : null;
  }

  let cur = start;
  let expanded = 0;
  let strayRun = 0;
  outer: for (;;) {
    if (presses >= maxPresses) (limit = 'maxPresses');
    else if (Date.now() - t0 > timeLimit) (limit = 'timeLimit');
    if (limit) break;
    if (cur.body || cur.sig !== startSig) {
      if (!(await doRestore('lost: ' + cur.sig + ' ' + cur.id))) break;
      continue;
    }
    const st = addState(cur);
    const untried = keys.filter((k) => !st.tried.has(k));
    // with `prefer`, a non-preferred state waits while preferred work is left
    // (only when a known path leads to such work)
    let path = null;
    if (untried.length && prefer && !prefer(cur.id)) {
      const p = plan(cur.id);
      if (p && p.length && prefer(p.at(-1).to)) path = p;
    }
    if (untried.length && !path) {
      if (st.tried.size === 0) {
        if (expanded >= maxStates) {
          limit = 'maxStates';
          break;
        }
        expanded++;
      }
      const k = untried[0];
      st.tried.add(k);
      const { s, left } = await step(st, k);
      if (left) record(st.id, k, 'LEAVE ' + s.sig);
      else if (!s.body) record(st.id, k, s.id);
      cur = s;
      continue;
    }
    if (!path) path = plan(cur.id);
    if (!path) {
      // something unexpanded may still exist off a path we can't replay from here
      const left = [...states.values()].some((x) => keys.some((k) => !x.tried.has(k)));
      if (left && strayRun < 3) {
        strayRun++;
        if (await doRestore('no known path to an unexpanded state')) continue;
      }
      break;
    }
    for (const hop of path) {
      const { s, left } = await step(states.get(hop.from), hop.k);
      if (left) {
        record(hop.from, hop.k, 'LEAVE ' + s.sig);
        cur = s;
        continue outer;
      }
      if (s.body) {
        cur = s;
        continue outer;
      }
      record(hop.from, hop.k, s.id);
      cur = s;
      if (s.id !== hop.to) {
        addState(s);
        strayRun++;
        if (strayRun > 25 && (await doRestore('travel keeps landing elsewhere'))) strayRun = 0;
        continue outer;
      }
      if (presses >= maxPresses || Date.now() - t0 > timeLimit) continue outer;
    }
    strayRun = 0;
  }

  const unexpanded = [...states.values()].filter((x) => keys.some((k) => !x.tried.has(k))).map((x) => x.id);
  const varying = [...seenEdges].filter(([, v]) => v.size > 1).map(([k, v]) => k + ' → ' + [...v].join(' | '));
  return {
    name,
    states: [...states.keys()],
    keys: [...new Set([...states.values()].map((x) => x.key).filter(Boolean))],
    edges: [...edges].flatMap(([from, m]) => [...m].map(([k, to]) => ({ from, key: k, to }))),
    observed: [...seenEdges].flatMap(([sk, v]) => [...v].map((to) => ({ from: sk.slice(0, sk.lastIndexOf(' ')), key: sk.slice(sk.lastIndexOf(' ') + 1), to }))),
    varying,
    leaves,
    problems,
    unexpanded,
    presses,
    restores,
    limit,
    complete: !limit && unexpanded.length === 0,
    ms: Date.now() - t0
  };
}

/* one-line summary for t.log() */
export function crawlSummary(r) {
  return `${r.name}: ${r.states.length} states, ${r.keys.length} keys, ${r.edges.length} edges, ${r.leaves.length} leaves, ${r.presses} presses, ${r.restores} restores, ${(r.ms / 1000).toFixed(1)} s${r.limit ? ', stopped at ' + r.limit : ''}${r.unexpanded.length ? ', unexpanded: ' + r.unexpanded.join(' ') : ''}, problems: ${r.problems.length}`;
}

/* Walk from wherever focus is to state `target` (an id as the crawl reports
 * it: data-focus key, '#n' suffix for a repeated key) by D-pad only, along
 * the edges a crawl observed. Each hop is verified; a miss re-plans from where
 * focus actually landed. Returns true when focus is on the target. */
export async function walkTo(page, r, target, { settle = 250, maxPresses = 80, log = () => {} } = {}) {
  const obs = r.observed || r.edges;
  let presses = 0;
  let stepOff = 0;
  const trail = [];
  for (;;) {
    const cur = await probe(page);
    if (cur.id === target) return true;
    if (presses >= maxPresses || cur.body) {
      log(`walkTo ${target}: gave up at ${cur.id} after ${presses} presses: ${trail.join(' ')}`);
      return false;
    }
    const prev = new Map([[cur.id, null]]);
    const q = [cur.id];
    while (q.length && !prev.has(target)) {
      const id = q.shift();
      for (const e of obs) {
        if (e.from !== id || e.to === id || e.to.startsWith('LEAVE ') || prev.has(e.to)) continue;
        prev.set(e.to, { from: id, key: e.key });
        q.push(e.to);
      }
    }
    if (!prev.has(target)) {
      // a crawl that stopped at its limit can leave focus on a state it never
      // expanded: step off it (one D-pad press) onto a known one and re-plan
      const known = new Set(obs.map((e) => e.from));
      if (!known.has(cur.id) && stepOff < 4) {
        const k = ['Up', 'Left', 'Down', 'Right'][stepOff++];
        presses++;
        await page.key(k, { settle });
        trail.push(k + '→?' + (await probe(page)).id.slice(0, 16));
        continue;
      }
      log(`walkTo ${target}: no known path from ${cur.id} (${trail.join(' ')})`);
      return false;
    }
    const path = [];
    for (let x = target; prev.get(x); x = prev.get(x).from) path.unshift({ ...prev.get(x), to: x });
    for (const hop of path) {
      presses++;
      await page.key(hop.key, { settle });
      const now = await probe(page);
      trail.push(hop.key + '→' + (now.id === hop.to ? '' : '!') + now.id.slice(0, 16));
      if (now.id !== hop.to) break; // re-plan from here
    }
  }
}
