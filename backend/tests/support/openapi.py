"""Validate payloads against an OpenAPI 3.0 document (the cached Sonarr/Radarr
specs, tests/support/specs.py) with jsonschema.

OpenAPI 3.0 schemas are JSON Schema plus `nullable`; that one keyword is
rewritten (type -> [type, "null"], a bare $ref -> anyOf [$ref, null]) and the
rest is handed to jsonschema as is. The arrs' specs (Swashbuckle) close every
resource with `additionalProperties: false`, so a field the spec doesn't know
is a validation error of its own kind ("additionalProperties") — that is how
unknown-to-spec fields in the fakes are found.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

from jsonschema import Draft202012Validator

_NAMED_MAPS = ("properties", "patternProperties", "$defs", "definitions")


def _convert(node, *, names: bool = False):
    if isinstance(node, list):
        return [_convert(x) for x in node]
    if not isinstance(node, dict):
        return node
    if names:  # a map of property names -> schemas: keys are data, not keywords
        return {k: _convert(v) for k, v in node.items()}
    out = {k: _convert(v, names=k in _NAMED_MAPS) for k, v in node.items() if k != "nullable"}
    if node.get("nullable") is True:
        if "type" in out:
            out["type"] = [out["type"], "null"] if isinstance(out["type"], str) else [*out["type"], "null"]
            if "enum" in out:
                out["enum"] = [*out["enum"], None]
        else:
            out = {"anyOf": [out, {"type": "null"}]}
    return out


@dataclass(frozen=True)
class Problem:
    where: str        # JSON path into the payload, e.g. "$[0].seasons[1].statistics"
    kind: str         # the jsonschema validator: "additionalProperties", "type", "enum", ...
    message: str

    def unknown_fields(self) -> list[str]:
        """For an additionalProperties problem: the unexpected names."""
        return re.findall(r"'([^']+)'", self.message.split("(", 1)[-1]) if self.kind == "additionalProperties" else []


class OpenApi:
    def __init__(self, doc: dict):
        self.doc = doc
        self.components = _convert(doc.get("components") or {})
        self._validators: dict[str, Draft202012Validator] = {}

    # ---- the document

    def operation(self, template: str, method: str) -> dict:
        try:
            return self.doc["paths"][template][method.lower()]
        except KeyError:
            raise AssertionError(f"{method} {template} is not in the spec") from None

    def has_operation(self, template: str, method: str) -> bool:
        return method.lower() in self.doc["paths"].get(template, {})

    def query_params(self, template: str, method: str) -> set[str]:
        return {p["name"] for p in self.operation(template, method).get("parameters", []) if p["in"] == "query"}

    def response_schema(self, template: str, method: str) -> dict | None:
        """The JSON schema of the 2xx answer (None: the spec documents no body)."""
        for status, resp in sorted(self.operation(template, method).get("responses", {}).items()):
            if status.startswith("2"):
                return ((resp.get("content") or {}).get("application/json") or {}).get("schema")
        return None

    def request_schema(self, template: str, method: str) -> dict | None:
        body = self.operation(template, method).get("requestBody") or {}
        return ((body.get("content") or {}).get("application/json") or {}).get("schema")

    def schema(self, name: str) -> dict:
        return {"$ref": f"#/components/schemas/{name}"}

    # ---- validation

    def _validator(self, schema: dict) -> Draft202012Validator:
        key = repr(sorted(schema.items()))
        v = self._validators.get(key)
        if v is None:
            v = Draft202012Validator({**_convert(schema), "components": self.components})
            self._validators[key] = v
        return v

    def problems(self, instance, schema: dict) -> list[Problem]:
        out = []
        for e in self._validator(schema).iter_errors(instance):
            # anyOf (nullable $ref) hides the real cause one level down
            leaves = [c for c in e.context if c.validator != "type" or c.validator_value != "null"] or [e]
            for leaf in leaves:
                out.append(Problem(leaf.json_path, leaf.validator, leaf.message))
        return sorted(set(out), key=lambda p: (p.where, p.kind, p.message))


def template_for(paths, path: str) -> str | None:
    """The spec path template ("/api/v3/series/{id}") matching a concrete path;
    a literal segment beats a parameter (/series/lookup is not /series/{id})."""
    segs = path.strip("/").split("/")
    hits = []
    for t in paths:
        ts = t.strip("/").split("/")
        if len(ts) == len(segs) and all(a == b or (a.startswith("{") and a.endswith("}")) for a, b in zip(ts, segs)):
            hits.append((sum(a.startswith("{") for a in ts), t))
    return min(hits)[1] if hits else None
