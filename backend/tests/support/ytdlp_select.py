"""yt-dlp's format choice, for the fake yt-dlp (stdlib only: the fake's script
imports it by path).

A port of the parts of yt-dlp's `FormatSorter` (yt_dlp/utils/_utils.py,
2026.08) and format-spec selection that trailers.py depends on:

  * the sort order a YouTube extraction uses: the forced/priority fields,
    then the extractor's `_format_sort_fields` (quality, res, fps, hdr:12,
    source, vcodec, channels, acodec, lang, proto), then the defaults
    (size, br, asr, ext, hasaud, id) — field by field the same preference
    tuples, codec/protocol/HDR orders and bitrate filling;
  * the selectors `b`, `bv`, `bv*`, `ba`, `ba*`, `wv`, `wa` (best = last after
    an ascending sort), `+` merges, `( … )` groups, `/` fallbacks and the
    filters `[key=value]`, `!=`, `<`, `<=`, `>`, `>=` (a field the format
    lacks fails the filter, as without `?`).

Anything else in a spec raises `SpecError`: the fake refuses a spec it
doesn't understand instead of ignoring part of it. Checked against the
picks the real yt-dlp made on recorded YouTube format lists
(tests/recorded/ytdlp, test_ytdlp_recorded.py).
"""

from __future__ import annotations

import operator
import re


class SpecError(ValueError):
    pass


_VCODEC = ['av0?1', r'vp0?9\.0?2', 'vp0?9', '[hx]265|he?vc?', '[hx]264|avc', 'vp0?8', 'mp4v|h263',
           'theora', '', None, 'none']
_ACODEC = ['[af]lac', 'wav|aiff', 'opus', 'vorbis|ogg', 'aac', 'mp?4a?', 'mp3', 'ac-?4', 'e-?a?c-?3',
           'ac-?3', 'dts', '', None, 'none']
_HDR = ['dv', '(hdr)?12', r'(hdr)?10\+', '(hdr)?10', 'hlg', '', 'sdr', None]
_PROTO = ['(ht|f)tps', '(ht|f)tp$', 'm3u8.*', '.*dash', 'websocket_frag', 'rtmpe?', '', 'ws|websocket', 'f4']
_VEXT = ['mp4', 'mov', 'webm', 'flv', '', 'none']
_AEXT = ['m4a', 'aac', 'mp3', 'ogg', 'opus', 'web[am]', '', 'none']


def _ordered(order: list, value, regex: bool = True) -> int:
    """FormatSorter._resolve_field_value for an 'ordered' field (convert_none)."""
    n = len(order)
    empty = order.index('') if '' in order else n + 1
    if value is not None:
        value = str(value).lower()
    if regex and value is not None:
        for i, rx in enumerate(order):
            if rx and re.match(rx, value):
                return n - i
        return n - empty
    return n - (order.index(value) if value in order else empty)


def _num(v, default=None):
    try:
        return float(v) if v is not None else default
    except (TypeError, ValueError):
        return default


def _pref(value, *, default=None, limit=None, string=False):
    """FormatSorter._calculate_field_preference_from_value (not reversed, no ~)."""
    num = _num(value, default)
    if not string and num is not None:
        value = num
        if limit is None or value <= limit:
            return (0, value, 0)
        return (0, -value, 0)
    if value is None:
        return (-10, 0)
    return (1, value, 0)


_HDR_LIMIT = _ordered(_HDR, "12")


def _fill(f: dict) -> dict:
    """FormatSorter._fill_sorting_fields on a copy."""
    f = dict(f)
    if f.get('vcodec') == 'none':
        f['audio_ext'] = f.get('ext') if f.get('acodec') != 'none' else 'none'
        f['video_ext'] = 'none'
        f['vbr'] = 0
    else:
        f['video_ext'] = f.get('ext')
        f['audio_ext'] = 'none'
    if f.get('acodec') == 'none':
        f['abr'] = 0

    def sub(a, b):
        try:
            return f[a] - f[b]
        except (KeyError, TypeError):
            return None

    if not f.get('vbr') and f.get('vcodec') != 'none':
        f['vbr'] = sub('tbr', 'abr') or None
    if not f.get('abr') and f.get('acodec') != 'none':
        f['abr'] = sub('tbr', 'vbr') or None
    if not f.get('tbr'):
        try:
            f['tbr'] = (f['vbr'] + f['abr']) or None
        except (KeyError, TypeError):
            f['tbr'] = None
    return f


def preference(fmt: dict) -> tuple:
    """The sort key of one format (ascending = worst to best)."""
    f = _fill(fmt)
    hidden = f.get('preference')
    if hidden is None or hidden >= -1000:
        hidden = -1
    ie_pref = f.get('preference')
    if ie_pref is None:
        ie_pref = -1
    has = lambda k: 0 if f.get(k) not in ('none',) else -1  # noqa: E731
    return (
        _pref(hidden),
        _pref(int(any(f.get(k) != 'none' for k in ('vcodec', 'acodec')))),
        _pref(has('vcodec')),
        _pref(ie_pref),
        _pref(f.get('quality'), default=-1),
        _pref(min(filter(None, (f.get('height'), f.get('width'))), default=0)),
        _pref(f.get('fps')),
        _pref(_ordered(_HDR, f.get('dynamic_range')), limit=_HDR_LIMIT),
        _pref(f.get('source_preference'), default=-1),
        _pref(_ordered(_VCODEC, f.get('vcodec'))),
        _pref(f.get('audio_channels')),
        _pref(_ordered(_ACODEC, f.get('acodec'))),
        _pref(f.get('language_preference'), default=-1),
        _pref(_ordered(_PROTO, f.get('protocol'))),
        _pref(next(filter(None, (f.get('filesize'), f.get('filesize_approx'))), None)),
        _pref(next(filter(None, (f.get('tbr'), f.get('vbr'), f.get('abr'))), None)),
        _pref(f.get('asr')),
        _pref(_ordered(_VEXT, f.get('video_ext'), regex=False)),
        _pref(_ordered(_AEXT, f.get('audio_ext'))),
        _pref(has('acodec')),
        _pref(f.get('format_id'), string=True),
    )


# ---------------------------------------------------------------- format specs

_KINDS = {
    # name: (pick the best (-1) or worst (0), keep(format))
    'b': (-1, lambda f: f.get('vcodec') != 'none' and f.get('acodec') != 'none'),
    'best': (-1, lambda f: f.get('vcodec') != 'none' and f.get('acodec') != 'none'),
    'bv': (-1, lambda f: f.get('vcodec') != 'none' and f.get('acodec') == 'none'),
    'bestvideo': (-1, lambda f: f.get('vcodec') != 'none' and f.get('acodec') == 'none'),
    'bv*': (-1, lambda f: f.get('vcodec') != 'none'),
    'ba': (-1, lambda f: f.get('vcodec') == 'none' and f.get('acodec') != 'none'),
    'bestaudio': (-1, lambda f: f.get('vcodec') == 'none' and f.get('acodec') != 'none'),
    'ba*': (-1, lambda f: f.get('acodec') != 'none'),
    'wv': (0, lambda f: f.get('vcodec') != 'none' and f.get('acodec') == 'none'),
    'wa': (0, lambda f: f.get('vcodec') == 'none' and f.get('acodec') != 'none'),
}
_OPS = {'<=': operator.le, '>=': operator.ge, '!=': operator.ne, '<': operator.lt, '>': operator.gt,
        '=': operator.eq}
_NUMERIC = {'width', 'height', 'tbr', 'abr', 'vbr', 'asr', 'fps', 'filesize', 'filesize_approx',
            'audio_channels'}
_TOKEN = re.compile(r"\s*(\(|\)|\+|/|\[[^\]]*\]|[A-Za-z0-9*_-]+)")
_FILTER = re.compile(r"\[\s*([a-z_]+)\s*(<=|>=|!=|<|>|=)\s*([^\]\s]+)\s*\]$")


def _tokens(spec: str) -> list[str]:
    out, pos = [], 0
    while pos < len(spec):
        m = _TOKEN.match(spec, pos)
        if not m:
            raise SpecError(f"format spec {spec!r}: can't read {spec[pos:]!r}")
        out.append(m.group(1))
        pos = m.end()
    return out


def _filter(text: str):
    m = _FILTER.match(text)
    if not m:
        raise SpecError(f"filter {text} not understood by the fake")
    key, op, raw = m.groups()
    if key in _NUMERIC:
        try:
            val = float(raw)
        except ValueError as e:
            raise SpecError(f"filter {text}: not a number") from e
    elif op in ('=', '!='):
        val = raw
    else:
        raise SpecError(f"filter {text}: {op} on a string field")
    fn = _OPS[op]
    return lambda f: f.get(key) is not None and fn(_num(f[key]) if key in _NUMERIC else f[key], val)


class _Parser:
    def __init__(self, spec: str):
        self.t, self.i = _tokens(spec), 0

    def peek(self):
        return self.t[self.i] if self.i < len(self.t) else None

    def take(self):
        if self.i >= len(self.t):
            raise SpecError("format spec ends early")
        self.i += 1
        return self.t[self.i - 1]

    def alternatives(self):
        alts = [self.merge()]
        while self.peek() == '/':
            self.take()
            alts.append(self.merge())
        return ('alt', alts)

    def merge(self):
        parts = [self.atom()]
        while self.peek() == '+':
            self.take()
            parts.append(self.atom())
        return ('merge', parts) if len(parts) > 1 else parts[0]

    def atom(self):
        tok = self.take() if self.peek() else None
        if tok == '(':
            inner = self.alternatives()
            if self.take() != ')':
                raise SpecError("unbalanced (")
            node = inner
        elif tok in _KINDS:
            node = ('kind', tok)
        elif tok and re.fullmatch(r"[0-9A-Za-z_-]+", tok):
            node = ('id', tok)
        else:
            raise SpecError(f"selector {tok!r} not understood by the fake")
        filters = []
        while self.peek() and self.peek().startswith('['):
            filters.append(_filter(self.take()))
        return ('filtered', node, filters) if filters else node


def parse(spec: str):
    p = _Parser(spec)
    tree = p.alternatives()
    if p.peek() is not None:
        raise SpecError(f"format spec {spec!r}: trailing {p.peek()!r}")
    return tree


def _eval(node, formats: list[dict], filters=()) -> list[dict] | None:
    kind = node[0]
    if kind == 'alt':
        for a in node[1]:
            got = _eval(a, formats, filters)
            if got:
                return got
        return None
    if kind == 'filtered':
        return _eval(node[1], formats, (*filters, *node[2]))
    if kind == 'merge':
        out = []
        for part in node[1]:
            got = _eval(part, formats, filters)
            if not got:
                return None
            out += got
        return out
    pool = [f for f in formats if all(flt(f) for flt in filters)]
    if kind == 'id':
        pool = [f for f in pool if f.get('format_id') == node[1]]
        return pool[-1:] or None
    idx, keep = _KINDS[node[1]]
    pool = [f for f in pool if keep(f)]
    return [pool[idx]] if pool else None


def select(formats: list[dict], spec: str) -> list[dict] | None:
    """The formats yt-dlp would pick for `spec` (in spec order), or None
    ("Requested format is not available")."""
    tree = parse(spec)
    usable = [f for f in formats if not f.get('has_drm')]
    ordered = sorted(usable, key=preference)
    return _eval(tree, ordered)
