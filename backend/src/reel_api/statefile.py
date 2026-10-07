"""reel-api's persistent state directory and the one way files are written there.

systemd's StateDirectory= sets STATE_DIRECTORY (on the NAS /var/lib/reel-api,
behind DynamicUser /var/lib/private/reel-api); dev and test runs fall back to
CACHE_DIRECTORY, then $TMPDIR/reel-api-state. push.json (push.py) and
owners.json (ownership.py) live there.
"""

import json
import os
from pathlib import Path


def state_dir() -> Path:
    # systemd StateDirectory= sets STATE_DIRECTORY; else next to the cache
    # (dev runs: /tmp).
    base = os.environ.get("STATE_DIRECTORY") or os.environ.get("CACHE_DIRECTORY") or os.path.join(
        os.environ.get("TMPDIR", "/tmp"), "reel-api-state"
    )
    p = Path(base.split(":")[0])
    p.mkdir(parents=True, exist_ok=True)
    return p


def write_json_atomic(path: Path, obj) -> None:
    """Write `obj` as JSON to `path`, mode 0600, all or nothing: a temporary
    file beside it, flushed to disk, then renamed over it. A crash mid-write
    leaves the previous file intact. Raises OSError to the caller."""
    tmp = path.with_suffix(".tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        json.dump(obj, f, sort_keys=True, separators=(",", ":"))
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)
