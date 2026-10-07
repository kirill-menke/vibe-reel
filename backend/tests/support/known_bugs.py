"""Tests for suspected product bugs (run/findings.md, local only).

Product code is not changed in this lane, so a test for a known defect states
the *intended* behaviour and is marked with ``known_bug("Fn", ...)``: a strict
xfail. While the bug is there the test fails as expected (XFAIL); once a fix
lands it passes, which strict mode reports as a failure (XPASS(strict)) — the
marker then has to be removed, so a fix can't go unnoticed and the test keeps
guarding the fixed behaviour afterwards.

``raises`` narrows what counts as "the bug is still there". The default,
AssertionError, means the test reached its assertions and they didn't hold;
tests that go through the app use the client's view
(``make_api(raise_app_exceptions=False)``), so a crash is a plain 500 and
fails an assertion too. Any other exception (a broken fixture, a renamed
helper) is then a real failure, not a silent XFAIL.
"""

from __future__ import annotations

import re

import pytest

_REASON = re.compile(r"^run/findings\.md (F\d+): ")


def known_bug(fid: str, why: str, raises=AssertionError):
    """A strict xfail for finding `fid` (e.g. "F7") of run/findings.md."""
    assert re.fullmatch(r"F\d+", fid), fid
    return pytest.mark.xfail(strict=True, raises=raises, reason=f"run/findings.md {fid}: {why}")


def finding_ids(node) -> set[str]:
    """The findings a collected test item is marked with by known_bug()."""
    ids = set()
    for mark in node.iter_markers("xfail"):
        m = _REASON.match(mark.kwargs.get("reason", ""))
        if m:
            ids.add(m.group(1))
    return ids
