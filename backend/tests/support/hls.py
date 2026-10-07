"""Structural checks of an HLS media playlist as reel-api serves it (livehls,
trailers): what a player relies on, not just which tags occur somewhere.

`check_playlist(text, complete=..., segment=re)` asserts (RFC 8216):

- `#EXTM3U` first, `#EXT-X-START` exactly once (reel-api injects it), an
  EVENT playlist with `#EXT-X-MAP:URI="init.mp4"` before the first segment;
- every `#EXTINF` (> 0 s) is followed by its segment URI, nothing else;
- `#EXT-X-TARGETDURATION` is an integer >= every EXTINF rounded to the
  nearest integer (4.3.3.1), i.e. >= the longest segment as players round it;
- `#EXT-X-MEDIA-SEQUENCE` (0 when absent) is the number of the first segment
  and the names count up from it with no gap, in order;
- `#EXT-X-ENDLIST` is there iff `complete`, and then it is the last line.

Returns [(name, duration)] in playlist order.
"""

from __future__ import annotations

import re


def check_playlist(text: str, *, complete: bool, segment: re.Pattern) -> list[tuple[str, float]]:
    lines = [ln.strip() for ln in text.splitlines() if ln.strip()]
    assert lines and lines[0] == "#EXTM3U", lines[:1]
    assert sum(ln.startswith("#EXT-X-START:") for ln in lines) == 1
    assert "#EXT-X-PLAYLIST-TYPE:EVENT" in lines

    target = [ln for ln in lines if ln.startswith("#EXT-X-TARGETDURATION:")]
    assert len(target) == 1, target
    target_s = int(target[0].split(":", 1)[1])  # an integer, by the spec
    seq_tags = [ln for ln in lines if ln.startswith("#EXT-X-MEDIA-SEQUENCE:")]
    assert len(seq_tags) <= 1
    seq = int(seq_tags[0].split(":", 1)[1]) if seq_tags else 0

    segs: list[tuple[str, float]] = []
    map_at = next(i for i, ln in enumerate(lines) if ln.startswith("#EXT-X-MAP:"))
    assert lines[map_at] == '#EXT-X-MAP:URI="init.mp4"'
    for i, ln in enumerate(lines):
        if ln.startswith("#EXTINF:"):
            assert i > map_at, "a segment before the init section"
            dur = float(ln.split(":", 1)[1].split(",", 1)[0])
            assert dur > 0, ln
            uri = lines[i + 1]
            assert not uri.startswith("#") and segment.match(uri), (ln, uri)
            segs.append((uri, dur))
    uris = [ln for ln in lines if not ln.startswith("#")]
    assert uris == [n for n, _ in segs], "a URI without its EXTINF"

    for name, dur in segs:
        assert round(dur) <= target_s, f"{name}: {dur} s over TARGETDURATION {target_s}"
    numbers = [int(re.search(r"(\d+)", n).group(1)) for n, _ in segs]
    assert numbers == list(range(seq, seq + len(segs))), numbers

    if complete:
        assert lines[-1] == "#EXT-X-ENDLIST"
        assert lines.count("#EXT-X-ENDLIST") == 1
    else:
        assert "#EXT-X-ENDLIST" not in lines
    return segs
