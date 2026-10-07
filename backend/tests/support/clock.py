"""Virtual time for reel-api's sleep/poll loops (streaming, livehls, push, undo, caches).

The product modules do `import asyncio` / `import time` and call
`asyncio.sleep`, `time.monotonic()`, `time.time()`. `FakeClock.install(module)`
swaps *that module's* `asyncio` and `time` names for proxies that delegate
everything to the real modules except sleep/monotonic/time — so the real
event loop, create_task, to_thread, subprocesses etc. keep working, and no
other module (pytest, httpx, the event loop itself) sees fake time.

Two modes:

* ``auto=True`` (default): every ``sleep(s)`` advances the clock by ``s`` and
  yields once. A loop that polls every second for 120 s "takes" 120 virtual
  seconds and finishes instantly. Use it when the test awaits the code under
  test directly.
* ``auto=False``: ``sleep(s)`` blocks until the test calls
  ``await clock.advance(...)`` past its deadline. Use it for background
  tasks (push watcher, undo sweeper, livehls reaper) the test steps through.

Wall-clock *dates* (``datetime.now()``) are not touched; use the
``time_machine`` fixture (time-machine package) for those.
"""

from __future__ import annotations

import asyncio as _asyncio
import time as _time
from types import ModuleType

_real_sleep = _asyncio.sleep


class _Proxy:
    """Attribute proxy: overrides first, then the real module."""

    def __init__(self, real: ModuleType, **overrides):
        self._real = real
        self.__dict__.update(overrides)

    def __getattr__(self, name):  # only called for names not in __dict__
        return getattr(self._real, name)


class FakeClock:
    def __init__(self, start: float = 10_000.0, wall: float = 1_790_000_000.0, auto: bool = True):
        self.t = float(start)
        self._t0 = float(start)
        self._wall0 = float(wall)
        self.auto = auto
        self.sleeps: list[float] = []  # every sleep() requested, in order
        self._waiters: list[tuple[float, _asyncio.Future]] = []

    # ---- the clock ----
    def monotonic(self) -> float:
        return self.t

    def time(self) -> float:
        return self._wall0 + (self.t - self._t0)

    def monotonic_ns(self) -> int:
        return int(self.t * 1e9)

    def time_ns(self) -> int:
        return int(self.time() * 1e9)

    async def sleep(self, delay: float, result=None):
        delay = max(float(delay), 0.0)
        self.sleeps.append(delay)
        if self.auto:
            self.t += delay
            await _real_sleep(0)
            return result
        fut = _asyncio.get_running_loop().create_future()
        self._waiters.append((self.t + delay, fut))
        await fut
        return result

    async def advance(self, seconds: float, settle: int = 10) -> None:
        """Move time forward, waking every sleeper whose deadline passed (in
        deadline order, letting each run before the next is woken)."""
        target = self.t + seconds
        while True:
            due = sorted((d, f) for d, f in self._waiters if d <= target and not f.done())
            if not due:
                break
            d, f = due[0]
            self.t = max(self.t, d)
            self._waiters = [(dd, ff) for dd, ff in self._waiters if ff is not f]
            f.set_result(None)
            await self.settle(settle)
        self.t = target
        await self.settle(settle)

    @staticmethod
    async def settle(n: int = 10) -> None:
        """Let other tasks run for n loop iterations (real, not virtual, time)."""
        for _ in range(n):
            await _real_sleep(0)

    @property
    def pending_sleepers(self) -> int:
        return sum(1 for _, f in self._waiters if not f.done())

    # ---- patching ----
    def install(self, monkeypatch, *modules: ModuleType) -> "FakeClock":
        """Give each module a fake `time` and `asyncio` (only the names it has)."""
        for mod in modules:
            if isinstance(getattr(mod, "time", None), (ModuleType, _Proxy)):
                monkeypatch.setattr(
                    mod,
                    "time",
                    _Proxy(_time, monotonic=self.monotonic, time=self.time,
                           monotonic_ns=self.monotonic_ns, time_ns=self.time_ns),
                )
            if isinstance(getattr(mod, "asyncio", None), (ModuleType, _Proxy)):
                monkeypatch.setattr(mod, "asyncio", _Proxy(_asyncio, sleep=self.sleep))
        return self
