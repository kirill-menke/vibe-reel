"""Hand-written response schemas for the reel-api routes that declare no
response_model (their OpenAPI answer schema is `{}`), derived from the module
that builds each answer (its docstring + the dict it returns) and
backend/README.md. Plain JSON Schema dicts, no imports: besides the contract
tests (support/schemas.py re-exports them), the e2e harness reads them —
e2e/scripts/reelapi-spec.mjs dumps them into its spec as `x-documented`, and
e2e/server/reelspec.mjs checks the fake reel-api's answers on those routes
against them.
"""

from __future__ import annotations


def _obj(props: dict, *, closed: bool = True) -> dict:
    """An object with exactly these properties, all required (every reel-api
    answer below is a fixed dict literal: each key is always there)."""
    out = {"type": "object", "properties": props, "required": list(props)}
    if closed:
        out["additionalProperties"] = False
    return out


STR, INT, NUM, BOOL = {"type": "string"}, {"type": "integer"}, {"type": "number"}, {"type": "boolean"}


def opt(s: dict) -> dict:
    return {"anyOf": [s, {"type": "null"}]}



# streaming.py `_shape_probe`: ffprobe of the (partial) main file.
PROBE = _obj({
    "container": opt(STR),
    "duration_s": opt(NUM),
    "bitrate": opt(INT),
    "size_bytes": INT,
    "video": opt(_obj({
        "index": opt(INT), "codec": opt(STR), "width": opt(INT), "height": opt(INT),
        "hdr": opt({"enum": ["DV", "HDR10", "HLG"]}), "fps": opt(NUM),
    })),
    "audio": {"type": "array", "items": _obj({
        "index": opt(INT), "codec": opt(STR), "channels": opt(INT), "layout": opt(STR),
        "lang": opt(STR), "title": opt(STR), "atmos": BOOL, "default": BOOL,
    })},
    "subtitles": {"type": "array", "items": _obj({
        "index": opt(INT), "codec": opt(STR), "lang": opt(STR), "title": opt(STR),
        "forced": BOOL, "default": BOOL,
    })},
})

# livehls.py `Job.status()` (module docstring: "POST starts (or joins) ... GET
# polls the status"): one remux job per (download, audio track).
HLS_STATUS = _obj({
    "id": STR,
    "audio": INT,
    "state": {"enum": ["probing", "remuxing", "done", "error"]},
    "segments": INT,
    "buffered_s": NUM,
    "duration": opt(NUM),
    "complete": BOOL,
    "codecs": opt(STR),
    "video": opt(_obj({"codec": STR, "width": opt(INT), "height": opt(INT), "dv_profile": opt(INT)})),
    "audio_codec": opt(STR),
    "progress": opt(NUM),
    "error": opt(STR),
})

# trailers.py `Job.status()`; README "POST|GET /api/trailers/{youtube_id}".
TRAILER_STATUS = _obj({
    "id": STR,
    "state": {"enum": ["resolving", "downloading", "ready", "error"]},
    "segments": INT,
    "buffered_s": NUM,
    "duration": opt(NUM),
    "complete": BOOL,
    "width": opt(INT),
    "height": opt(INT),
    "vcodec": opt(STR),
    "codecs": opt(STR),
    "hdr": opt(STR),
    "subs": opt(_obj({"lang": STR, "kind": {"enum": ["manual", "auto", "translated"]}})),
    "subs_done": BOOL,
    "title": opt(STR),
    "error": opt(STR),
})

# push.py routes (module docstring + the dicts they return).
PUSH_CONFIG = _obj({"enabled": BOOL, "key": opt(STR)})
PUSH_SUBSCRIBED = _obj({"ok": {"const": True}, "user": STR})
PUSH_STATUS = _obj({"subscribed": BOOL, "ready": BOOL, "seasons": BOOL})
PUSH_OK = _obj({"ok": {"const": True}})

HEALTH = _obj({"ok": {"const": True}})

# (METHOD, route template, status) -> schema, for routes without response_model.
DOCUMENTED: dict[tuple[str, str, int], dict] = {
    ("GET", "/api/downloads/{gid}/probe", 200): PROBE,
    ("POST", "/api/downloads/{gid}/hls", 200): HLS_STATUS,
    ("GET", "/api/downloads/{gid}/hls", 200): HLS_STATUS,
    ("POST", "/api/trailers/{key}", 200): TRAILER_STATUS,
    ("GET", "/api/trailers/{key}", 200): TRAILER_STATUS,
    ("GET", "/api/push/config", 200): PUSH_CONFIG,
    ("POST", "/api/push/subscribe", 200): PUSH_SUBSCRIBED,
    ("POST", "/api/push/status", 200): PUSH_STATUS,
    ("POST", "/api/push/unsubscribe", 200): PUSH_OK,
    ("POST", "/api/push/test", 200): PUSH_OK,
    ("GET", "/health", 200): HEALTH,
}
