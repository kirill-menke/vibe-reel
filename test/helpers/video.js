/* A fake <video> for the playback engine (player.svelte.js) and the MSE feeders.
 *
 * It is a real happy-dom HTMLElement (so addEventListener, `hidden`, classList,
 * querySelector all work) with the media surface replaced by plain, test-driven
 * state — nothing plays by itself:
 *
 *   const v = fakeVideo();
 *   setVideoEl(v);                    // hand it to the engine
 *   v.setBuffered([[0, 120]]);        // TimeRanges
 *   v.advance(0.5);                   // playhead moves (fires 'timeupdate')
 *   v.freeze();                       // currentTime stops (the silent-stall case: no 'waiting')
 *   v.emit('loadedmetadata');         // fire a media event (also calls v.on<name>)
 *   v.setDuration(3600);
 *   v.audioTracks                     // [{ enabled }] list, see setAudioTracks()
 *   v.calls                           // [['play'], ['pause'], ['load'], ['src', url], …]
 *
 * `currentTime` assignment is recorded as a seek (`v.seeks`) and fires
 * 'seeking' + 'seeked' unless v.autoSeek = false. `src` assignment is recorded;
 * `removeAttribute('src')` clears it; getAttribute('src') reflects it. play() resolves, un-pauses and fires
 * 'play'; 'playing' follows at once when readyState >= 3 (HAVE_FUTURE_DATA),
 * else as soon as v.setReadyState(n >= 3) is called — as a real element does,
 * so an early play() (the phone's Low Power Mode kick before metadata) does not
 * count as the first frame. v.autoPlay = false: play() never leads to
 * 'playing'; v.playRejects = err: play() rejects and stays paused. */

export function timeRanges(list = []) {
  const r = list.map(([s, e]) => [s, e]);
  return {
    get length() {
      return r.length;
    },
    start(i) {
      if (i < 0 || i >= r.length) throw new DOMException('index', 'IndexSizeError');
      return r[i][0];
    },
    end(i) {
      if (i < 0 || i >= r.length) throw new DOMException('index', 'IndexSizeError');
      return r[i][1];
    }
  };
}

export function fakeVideo({ duration = NaN } = {}) {
  const el = document.createElement('video');
  const st = {
    currentTime: 0,
    duration,
    paused: true,
    ended: false,
    muted: false,
    readyState: 0,
    buffered: timeRanges(),
    src: '',
    error: null,
    playbackRate: 1,
    audioTracks: makeTrackList([]),
    textTracks: []
  };
  const calls = [];
  const seeks = [];
  const def = (name, get, set) => Object.defineProperty(el, name, { configurable: true, get, set });

  def('currentTime', () => st.currentTime, (t) => {
    st.currentTime = Number(t);
    seeks.push(st.currentTime);
    calls.push(['seek', st.currentTime]);
    if (el.autoSeek) {
      el.emit('seeking');
      el.emit('seeked');
    }
  });
  def('duration', () => st.duration);
  def('paused', () => st.paused);
  def('ended', () => st.ended);
  def('muted', () => st.muted, (v) => (st.muted = !!v));
  def('readyState', () => st.readyState);
  def('buffered', () => st.buffered);
  def('error', () => st.error);
  def('playbackRate', () => st.playbackRate, (v) => (st.playbackRate = v));
  def('audioTracks', () => st.audioTracks);
  def('textTracks', () => st.textTracks);
  def('src', () => st.src, (v) => {
    st.src = String(v);
    calls.push(['src', st.src]);
  });
  def('currentSrc', () => st.src);
  const rmAttr = el.removeAttribute.bind(el);
  el.removeAttribute = (name) => {
    if (name === 'src') {
      st.src = '';
      calls.push(['removeSrc']);
    }
    return rmAttr(name);
  };
  // the src property reflects the content attribute, as on a real <video>
  // (the engine's onerror reads getAttribute('src') to tell an emptied element)
  const getAttr = el.getAttribute.bind(el);
  el.getAttribute = (name) => (name === 'src' ? (st.src ? st.src : null) : getAttr(name));
  const hasAttr = el.hasAttribute.bind(el);
  el.hasAttribute = (name) => (name === 'src' ? !!st.src : hasAttr(name));

  Object.assign(el, {
    calls,
    seeks,
    autoSeek: true,
    autoPlay: true,
    pendingPlaying: false,
    playRejects: null,
    play() {
      calls.push(['play']);
      if (el.playRejects) return Promise.reject(el.playRejects);
      if (el.autoPlay) {
        const was = st.paused;
        st.paused = false;
        st.ended = false;
        if (was) el.emit('play');
        if (st.readyState >= 3) el.emit('playing');
        else el.pendingPlaying = true;
      }
      return Promise.resolve();
    },
    pause() {
      calls.push(['pause']);
      if (!st.paused) {
        st.paused = true;
        el.pendingPlaying = false;
        el.emit('pause');
      }
    },
    load() {
      calls.push(['load']);
    },
    canPlayType: (t) => el.canPlay(t),
    canPlay: () => 'probably',
    requestVideoFrameCallback: () => 0,
    /* ---- test controls ---- */
    emit(type, detail) {
      const ev = new Event(type);
      if (detail) Object.assign(ev, detail);
      el.dispatchEvent(ev);
      return ev;
    },
    /** move the playhead by dt seconds (fires timeupdate) */
    advance(dt) {
      st.currentTime += dt;
      el.emit('timeupdate');
    },
    /** set the playhead without it counting as a seek */
    setTime(t) {
      st.currentTime = t;
    },
    freeze() {
      /* the playhead simply stops being advanced; nothing is fired — the
       * silent stall CLAUDE.md describes (iptables DROP of the NAS) */
    },
    setBuffered(list) {
      st.buffered = timeRanges(list);
    },
    setDuration(d) {
      st.duration = d;
      el.emit('durationchange');
    },
    /** HAVE_NOTHING 0 … HAVE_ENOUGH_DATA 4; reaching >= 3 un-holds a pending 'playing' */
    setReadyState(n) {
      st.readyState = n;
      if (n >= 3 && el.pendingPlaying && !st.paused) {
        el.pendingPlaying = false;
        el.emit('playing');
      }
    },
    setPaused(p) {
      st.paused = !!p;
    },
    end() {
      st.ended = true;
      st.paused = true;
      el.emit('ended');
    },
    fail(code = 3, message = 'decode') {
      st.error = { code, message };
      el.emit('error');
    },
    setAudioTracks(n) {
      st.audioTracks = makeTrackList(Array.from({ length: n }, (_, i) => ({ enabled: i === 0, id: String(i) })));
    },
    state: st
  });
  return el;
}

function makeTrackList(list) {
  const tl = list.slice();
  tl.getTrackById = (id) => tl.find((t) => t.id === id) || null;
  tl.addEventListener = () => {};
  tl.removeEventListener = () => {};
  return tl;
}
