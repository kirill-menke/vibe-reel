"""A small GraphQL executable-document parser for the fakes (no dependencies).

Enough of the spec (October 2021, "Executable Definitions") for what a client
sends: operations with variable definitions, fields with aliases, arguments
(variables, ints, floats, strings, block strings, booleans, null, enums, lists,
input objects), directives (parsed and ignored), fragment spreads, inline
fragments and fragment definitions. Anything else is a `GraphQLSyntaxError`.

    doc = parse(text)
    op = doc.operation(name=None)          # the only one, or by name
    op.variables                           # {name: VarDef(type, default)}
    for f in doc.fields(op.selections, "Title"):   # fragments expanded
        f.alias, f.name, f.key, f.args, f.selections
    value(f.args["first"], variables)      # a literal or $var, resolved

`Var(name)` / `Enum(name)` mark variables and enum literals in raw argument
values; `value()` turns variables into their JSON value and enums into str.
`used_variables(op)` lists every $var an operation references (fragments
included).
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field


class GraphQLSyntaxError(ValueError):
    pass


_TOKEN = re.compile(r"""
    (?P<ws>[\s,﻿]+|\#[^\n\r]*)
  | (?P<spread>\.\.\.)
  | (?P<punct>[!$&()\:=@\[\]{}|])
  | (?P<name>[_A-Za-z][_0-9A-Za-z]*)
  | (?P<number>-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)
  | (?P<block>\"\"\"(?:\\\"\"\"|[^"]|"(?!""))*\"\"\")
  | (?P<string>"(?:\\["\\/bfnrtu]|[^"\\\n\r])*")
""", re.VERBOSE)


@dataclass(frozen=True)
class Var:
    name: str


@dataclass(frozen=True)
class Enum:
    name: str


@dataclass
class Field:
    name: str
    alias: str | None = None
    args: dict = field(default_factory=dict)
    selections: list | None = None  # None = a leaf

    @property
    def key(self) -> str:
        return self.alias or self.name


@dataclass
class Spread:
    fragment: str


@dataclass
class Inline:
    type_condition: str | None
    selections: list


@dataclass
class VarDef:
    type: str  # e.g. "[String!]!"
    default: object = None
    has_default: bool = False


@dataclass
class Operation:
    kind: str
    name: str | None
    variables: dict
    selections: list


@dataclass
class Fragment:
    name: str
    type_condition: str
    selections: list


@dataclass
class Document:
    operations: list
    fragments: dict

    def operation(self, name: str | None = None) -> Operation:
        if name is None:
            if len(self.operations) != 1:
                raise GraphQLSyntaxError("Must provide operation name if query contains multiple operations.")
            return self.operations[0]
        for op in self.operations:
            if op.name == name:
                return op
        raise GraphQLSyntaxError(f'Unknown operation named "{name}".')

    def fields(self, selections: list, type_name: str | None = None) -> list[Field]:
        """The fields of a selection set with fragments expanded (a type
        condition other than `type_name` is skipped when one is given)."""
        out: list[Field] = []
        for s in selections:
            if isinstance(s, Field):
                out.append(s)
            elif isinstance(s, Spread):
                frag = self.fragments.get(s.fragment)
                if frag is None:
                    raise GraphQLSyntaxError(f'Unknown fragment "{s.fragment}".')
                if type_name is None or frag.type_condition == type_name:
                    out += self.fields(frag.selections, type_name)
            elif type_name is None or s.type_condition in (None, type_name):
                out += self.fields(s.selections, type_name)
        return out


class _Parser:
    def __init__(self, text: str):
        self.toks: list[tuple[str, str]] = []
        pos = 0
        while pos < len(text):
            m = _TOKEN.match(text, pos)
            if not m:
                raise GraphQLSyntaxError(f"Syntax Error: Unexpected character {text[pos]!r} at {pos}.")
            pos = m.end()
            if m.lastgroup != "ws":
                self.toks.append((m.lastgroup, m.group()))
        self.i = 0

    # -- token helpers
    def peek(self, value: str | None = None, kind: str | None = None) -> bool:
        if self.i >= len(self.toks):
            return False
        k, v = self.toks[self.i]
        return (value is None or v == value) and (kind is None or k == kind)

    def take(self, value: str | None = None, kind: str | None = None) -> str:
        if not self.peek(value, kind):
            got = self.toks[self.i][1] if self.i < len(self.toks) else "<EOF>"
            raise GraphQLSyntaxError(f"Syntax Error: Expected {value or kind}, found {got!r}.")
        self.i += 1
        return self.toks[self.i - 1][1]

    def opt(self, value: str) -> bool:
        if self.peek(value):
            self.i += 1
            return True
        return False

    # -- grammar
    def document(self) -> Document:
        ops, frags = [], {}
        while self.i < len(self.toks):
            if self.peek("fragment", "name"):
                f = self.fragment()
                if f.name in frags:
                    raise GraphQLSyntaxError(f'There can be only one fragment named "{f.name}".')
                frags[f.name] = f
            else:
                ops.append(self.operation())
        if not ops:
            raise GraphQLSyntaxError("Syntax Error: no operation.")
        return Document(ops, frags)

    def operation(self) -> Operation:
        if self.peek("{"):
            return Operation("query", None, {}, self.selection_set())
        kind = self.take(kind="name")
        if kind not in ("query", "mutation", "subscription"):
            raise GraphQLSyntaxError(f"Syntax Error: Unexpected Name {kind!r}.")
        name = self.take(kind="name") if self.peek(kind="name") else None
        variables = {}
        if self.opt("("):
            while not self.opt(")"):
                self.take("$")
                vname = self.take(kind="name")
                self.take(":")
                vtype = self.type_ref()
                vd = VarDef(vtype)
                if self.opt("="):
                    vd.default, vd.has_default = self.value(const=True), True
                self.directives()
                variables[vname] = vd
        self.directives()
        return Operation(kind, name, variables, self.selection_set())

    def fragment(self) -> Fragment:
        self.take("fragment")
        name = self.take(kind="name")
        if name == "on":
            raise GraphQLSyntaxError("Syntax Error: Unexpected Name 'on'.")
        self.take("on")
        tc = self.take(kind="name")
        self.directives()
        return Fragment(name, tc, self.selection_set())

    def type_ref(self) -> str:
        if self.opt("["):
            inner = self.type_ref()
            self.take("]")
            t = f"[{inner}]"
        else:
            t = self.take(kind="name")
        return t + "!" if self.opt("!") else t

    def directives(self) -> None:
        while self.opt("@"):
            self.take(kind="name")
            if self.peek("("):
                self.arguments()

    def selection_set(self) -> list:
        self.take("{")
        out = []
        while not self.opt("}"):
            out.append(self.selection())
        if not out:
            raise GraphQLSyntaxError("Syntax Error: Expected Name, found '}'.")
        return out

    def selection(self):
        if self.opt("..."):
            if self.peek("on"):
                self.take("on")
                tc = self.take(kind="name")
                self.directives()
                return Inline(tc, self.selection_set())
            if self.peek("{") or self.peek("@"):
                self.directives()
                return Inline(None, self.selection_set())
            name = self.take(kind="name")
            self.directives()
            return Spread(name)
        name = self.take(kind="name")
        alias = None
        if self.opt(":"):
            alias, name = name, self.take(kind="name")
        args = self.arguments() if self.peek("(") else {}
        self.directives()
        sels = self.selection_set() if self.peek("{") else None
        return Field(name, alias, args, sels)

    def arguments(self) -> dict:
        self.take("(")
        out = {}
        while not self.opt(")"):
            k = self.take(kind="name")
            self.take(":")
            if k in out:
                raise GraphQLSyntaxError(f'There can be only one argument named "{k}".')
            out[k] = self.value()
        return out

    def value(self, const: bool = False):
        if self.opt("$"):
            if const:
                raise GraphQLSyntaxError("Syntax Error: Unexpected variable in a constant value.")
            return Var(self.take(kind="name"))
        if self.opt("["):
            items = []
            while not self.opt("]"):
                items.append(self.value(const))
            return items
        if self.opt("{"):
            obj = {}
            while not self.opt("}"):
                k = self.take(kind="name")
                self.take(":")
                obj[k] = self.value(const)
            return obj
        if self.peek(kind="number"):
            t = self.take()
            return float(t) if any(c in t for c in ".eE") else int(t)
        if self.peek(kind="string"):
            import json

            return json.loads(self.take())
        if self.peek(kind="block"):
            return self.take()[3:-3].replace('\\"""', '"""')
        name = self.take(kind="name")
        return {"true": True, "false": False, "null": None}.get(name, Enum(name))


def parse(text: str) -> Document:
    return _Parser(text).document()


def value(raw, variables: dict):
    """A raw argument value with variables substituted and enums as str."""
    if isinstance(raw, Var):
        return variables.get(raw.name)
    if isinstance(raw, Enum):
        return raw.name
    if isinstance(raw, list):
        return [value(v, variables) for v in raw]
    if isinstance(raw, dict):
        return {k: value(v, variables) for k, v in raw.items()}
    return raw


def _vars_in(raw, out: set) -> None:
    if isinstance(raw, Var):
        out.add(raw.name)
    elif isinstance(raw, list):
        for v in raw:
            _vars_in(v, out)
    elif isinstance(raw, dict):
        for v in raw.values():
            _vars_in(v, out)


def used_variables(doc: Document, op: Operation) -> set[str]:
    out: set[str] = set()
    seen: set[str] = set()

    def walk(sels):
        for s in sels or []:
            if isinstance(s, Field):
                for v in s.args.values():
                    _vars_in(v, out)
                walk(s.selections)
            elif isinstance(s, Inline):
                walk(s.selections)
            elif s.fragment not in seen and s.fragment in doc.fragments:
                seen.add(s.fragment)
                walk(doc.fragments[s.fragment].selections)

    walk(op.selections)
    return out
