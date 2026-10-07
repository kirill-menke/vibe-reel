"""Access to the public upstream API specs cached by tests/specs/fetch_specs.py.

The cache (tests/.spec-cache/, git-ignored) is optional: tests marked `spec`
take the `spec_cache` fixture, which skips them when a file is missing. A file
that IS there but doesn't match its manifest sha256 fails loudly instead — a
truncated or hand-edited spec must not silently validate the mocks.
"""

from __future__ import annotations

import hashlib
import json
from functools import cached_property
from pathlib import Path

from tests.specs.fetch_specs import CACHE, MANIFEST, SOURCES

FETCH_HINT = "cd backend && uv run python tests/specs/fetch_specs.py"

SONARR_SPEC = "sonarr-v4.openapi.json"
RADARR_SPEC = "radarr-v5.openapi.json"
QBIT_DOC = "qbittorrent-webui-api-5.0.md"
QBIT_DOC_41 = "qbittorrent-webui-api-4.1.md"


class SpecMissing(Exception):
    pass


class SpecCache:
    def __init__(self, root: Path = CACHE):
        self.root = root

    def missing(self) -> list[str]:
        return [n for n in SOURCES if not (self.root / n).is_file()]

    def _manifest(self) -> dict:
        try:
            return json.loads((self.root / MANIFEST.name).read_text())
        except (OSError, ValueError) as e:
            raise SpecMissing(f"no readable manifest in {self.root}") from e

    def path(self, name: str) -> Path:
        p = self.root / name
        if not p.is_file():
            raise SpecMissing(f"{name} not cached")
        entry = self._manifest().get(name)
        if entry is None:
            raise SpecMissing(f"{name} not in the manifest")
        digest = hashlib.sha256(p.read_bytes()).hexdigest()
        assert digest == entry["sha256"], f"{name}: sha256 differs from manifest.json (re-run {FETCH_HINT} --refresh)"
        return p

    def json(self, name: str) -> dict:
        return json.loads(self.path(name).read_text())

    def text(self, name: str) -> str:
        return self.path(name).read_text()

    @cached_property
    def sonarr(self) -> dict:
        return self.json(SONARR_SPEC)

    @cached_property
    def radarr(self) -> dict:
        return self.json(RADARR_SPEC)

    @cached_property
    def qbit(self) -> str:
        return self.text(QBIT_DOC)

    @cached_property
    def qbit41(self) -> str:
        return self.text(QBIT_DOC_41)


# ---------------------------------------------------------------- qBittorrent WebUI API markdown

import re  # noqa: E402

_GROUP = re.compile(r'under "(\w+)"')
_NAME = re.compile(r"^Name: `(\w+)`", re.M)
_CELL = re.compile(r"`([A-Za-z_][\w.]*)`")


class QbitEndpoint:
    def __init__(self, path: str, title: str, body: str):
        self.path, self.title, self.body = path, title, body

    def tables(self) -> list[list[list[str]]]:
        """Every markdown table in the section, as rows of cells (header and rule rows dropped)."""
        out, cur = [], []
        for line in self.body.splitlines():
            if line.lstrip().startswith("|"):
                cells = [c.strip() for c in re.split(r"(?<!\\)\|", line.strip())[1:-1]]
                if not all(set(c) <= set("-: ") for c in cells):
                    cur.append(cells)
            elif cur:
                out.append(cur[1:])  # drop the header row
                cur = []
        if cur:
            out.append(cur[1:])
        return out

    def _first_col_names(self, after: str | None) -> set[str]:
        body = self.body
        if after is not None:
            i = body.find(after)
            if i < 0:
                return set()
            body = body[i:]
            j = body.find("**", len(after))  # up to the next bold heading
            body = body if j < 0 else body[:j]
        names = set()
        for table in QbitEndpoint(self.path, self.title, body).tables():
            for row in table:
                if row:
                    names.update(_CELL.findall(row[0]))
        return names

    @property
    def params(self) -> set[str]:
        """The request parameters: the **Parameters:** table, or (Add new torrent has no such
        heading) every table before **Returns:**; plus the names in the section's HTTP example
        bodies / query strings (createCategory, setForceStart document theirs only that way)."""
        if "**Parameters:**" in self.body:
            names = self._first_col_names("**Parameters:**")
        else:
            head = self.body.split("**Returns:**", 1)[0]
            names = QbitEndpoint(self.path, self.title, head)._first_col_names(None)
        return names | self.example_params()

    def example_params(self) -> set[str]:
        names: set[str] = set()
        for block in re.findall(r"```http\n(.*?)```", self.body, re.S):
            lines = block.splitlines()
            req = lines[0].split()[1] if lines and len(lines[0].split()) > 1 else ""
            parts = [req.split("?", 1)[1]] if "?" in req else []
            if "" in lines:  # the body after the blank line (form-encoded examples only)
                parts += [ln for ln in lines[lines.index("") + 1:] if "=" in ln and ":" not in ln.split("=", 1)[0]]
            for part in parts:
                for kv in re.split(r"[&?]", part):
                    k = kv.split("=", 1)[0].strip()
                    if re.fullmatch(r"[A-Za-z_]\w*", k) and "=" in kv:
                        names.add(k)
        return names

    @property
    def fields(self) -> set[str]:
        """Names in the first column of every table of the section (parameters and response fields)."""
        return self._first_col_names(None)


def qbit_endpoints(md: str) -> dict[str, QbitEndpoint]:
    """Parse the WebUI API page into {"/api/v2/<group>/<name>": QbitEndpoint}."""
    out: dict[str, QbitEndpoint] = {}
    for chapter in re.split(r"^## ", md, flags=re.M)[1:]:
        g = _GROUP.search(chapter)
        if not g:
            continue
        for section in re.split(r"^### ", chapter, flags=re.M)[1:]:
            title = section.split("\n", 1)[0].strip("# ").strip()
            # "Name: `files`"; a few sections (Add new torrent) only show an HTTP example
            names = _NAME.findall(section) or sorted(set(re.findall(rf"/api/v2/{g.group(1)}/(\w+)", section)))
            for name in names:
                out[f"/api/v2/{g.group(1)}/{name}"] = QbitEndpoint(f"/api/v2/{g.group(1)}/{name}", title, section)
    return out
