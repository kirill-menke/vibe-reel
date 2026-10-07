/* Fake clock. Wraps vi.useFakeTimers so Date.now(), setTimeout/setInterval,
 * requestAnimationFrame and performance.now all move together (the player's
 * watchdog compares Date.now() deltas inside a setInterval tick).
 *
 *   const clock = useClock();            // fake timers from now on (setup.js restores real ones after the test)
 *   await clock.tick(2000);              // advance 2 s, running due timers and flushing promises between them
 *   clock.tickSync(500);                 // advance without awaiting microtasks
 *   await clock.flush();                 // drain pending microtasks only
 *   clock.now()                          // the fake Date.now()
 *
 * Starts at a fixed wall time (2026-01-01T12:00:00Z) unless `start` is given,
 * so tests that format dates are stable.
 *
 * ⚠️ AbortSignal.timeout() runs on Node's internal timers, which fake timers do
 * NOT control — api()'s 30 s deadline, mlFetch's and the picture service's
 * would never fire. useClock() therefore also replaces AbortSignal.timeout with
 * a fake-timer version that aborts with a TimeoutError DOMException, as the spec
 * says (Chromium 120 then rejects the fetch with AbortError — the mock fetch's
 * net.hang() does the same). `abortTimeout: false` keeps the real one. The spy
 * is restored after the test (restoreMocks). `clock.timeouts` lists the ms of
 * every AbortSignal.timeout(ms) created. */
import { vi } from 'vitest';

export const TICKS_PER_SECOND = 10000000;
export const sec = (s) => Math.round(s * TICKS_PER_SECOND);

export const START = Date.UTC(2026, 0, 1, 12, 0, 0);

export function useClock({ start = START, abortTimeout = true } = {}) {
  const timeouts = [];
  if (abortTimeout) {
    vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => {
      timeouts.push(ms);
      const ac = new AbortController();
      setTimeout(() => ac.abort(new DOMException('The operation timed out.', 'TimeoutError')), ms);
      return ac.signal;
    });
  }
  vi.useFakeTimers({
    now: start,
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'requestAnimationFrame', 'cancelAnimationFrame', 'performance']
  });
  return {
    timeouts,
    now: () => Date.now(),
    async tick(ms) {
      await vi.advanceTimersByTimeAsync(ms);
    },
    tickSync(ms) {
      vi.advanceTimersByTime(ms);
    },
    async flush() {
      for (let i = 0; i < 10; i++) await Promise.resolve();
    },
    async runAll() {
      await vi.runAllTimersAsync();
    },
    pending: () => vi.getTimerCount(),
    setNow(t) {
      vi.setSystemTime(t);
    }
  };
}

/** Drain the microtask queue a few rounds (real timers). */
export async function flushPromises(rounds = 10) {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
}
