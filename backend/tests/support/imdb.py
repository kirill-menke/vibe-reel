"""A fake of IMDb's GraphQL API (caching.graphql.imdb.com) for the queries
reel-api sends (trending.py, charts.py), checked against recorded real answers
(tests/recorded/imdb/, test_imdb_recorded.py).

It executes the query it is sent rather than recognising it:

  * the document is parsed (tests/support/graphql.py: aliases, fragments,
    inline fragments, variables, literals) and validated against a small
    schema of what the sim models — a field or argument the schema doesn't
    have is the real edge's answer, HTTP 400 with
    `Cannot query field "x" on type "T".` (recorded), a variable that is
    undeclared, unused, missing or of the wrong type likewise;
  * the answer holds exactly the selection set — the fields asked for, under
    their aliases, nothing else — so a query that stops asking for
    `ratingsSummary` gets no ratings;
  * `advancedTitleSearch` honours the constraints it is given (title types,
    *any* release date in a range — a superset, trending narrows it — rating
    and vote floors, genres) and the sort (POPULARITY = meter rank, unranked
    last; USER_RATING); `chartTitles` serves the list set with `set_chart()`;
    `first` slices every connection (releaseDates too);
  * without an `x-imdb-client-name` header -> 403 with the edge's HTML page;
  * ratings are JSON numbers as IMDb writes them (8, not 8.0).

Input the sim can't honour (a real constraint or sort it doesn't model) raises
AssertionError in the test instead of being ignored.

Only the type name "Title" is confirmed by a real error message; the other
type names are this file's.

Faults: `fail(status=|exc=|errors=|body=, times=1)`. `requests` records
(variables, headers) of every call; `ops` the operation names; `errors` the
validation errors answered.
"""

from __future__ import annotations

import datetime as dt
import json
import re
from dataclasses import dataclass, field

import httpx

from tests.support import graphql as gql

URL = "https://caching.graphql.imdb.com/"
IMG = "https://m.media-amazon.test/images/M/{id}@._V1_.jpg"
DISCLAIMER = {"disclaimer": "Public, commercial, and/or non-private use of the IMDb data provided by this "
                            "API is not allowed. (fake)"}
FORBIDDEN_HTML = ("<html>\r\n<head><title>403 Forbidden</title></head>\r\n<body>\r\n"
                  "<center><h1>403 Forbidden</h1></center>\r\n</body>\r\n</html>\r\n")

# type -> field -> (type, {argument names})
SCHEMA: dict[str, dict[str, tuple[str, frozenset]]] = {
    "Query": {
        "advancedTitleSearch": ("AdvancedTitleSearchConnection!",
                                frozenset({"first", "after", "constraints", "sort"})),
        "chartTitles": ("ChartTitleConnection", frozenset({"chart", "first", "after"})),
    },
    "AdvancedTitleSearchConnection": {"edges": ("[AdvancedTitleSearchEdge!]!", frozenset())},
    "AdvancedTitleSearchEdge": {"node": ("AdvancedTitleSearch!", frozenset())},
    "AdvancedTitleSearch": {"title": ("Title!", frozenset())},
    "ChartTitleConnection": {"edges": ("[ChartTitleEdge!]!", frozenset())},
    "ChartTitleEdge": {"currentRank": ("Int!", frozenset()), "node": ("Title!", frozenset())},
    "Title": {
        "id": ("ID!", frozenset()),
        "titleText": ("TitleText", frozenset()),
        "releaseYear": ("YearRange", frozenset()),
        "ratingsSummary": ("RatingsSummary", frozenset()),
        "primaryImage": ("Image", frozenset()),
        "releaseDate": ("ReleaseDate", frozenset()),
        "releaseDates": ("ReleaseDatesConnection", frozenset({"first", "after"})),
        "meterRanking": ("TitleMeterRanking", frozenset()),
    },
    "TitleText": {"text": ("String!", frozenset())},
    "YearRange": {"year": ("Int!", frozenset()), "endYear": ("Int", frozenset())},
    "RatingsSummary": {"aggregateRating": ("Float", frozenset()), "voteCount": ("Int!", frozenset())},
    "Image": {"url": ("String!", frozenset())},
    "ReleaseDate": {"year": ("Int", frozenset()), "month": ("Int", frozenset()), "day": ("Int", frozenset())},
    "ReleaseDatesConnection": {"edges": ("[ReleaseDateEdge!]!", frozenset())},
    "ReleaseDateEdge": {"node": ("ReleaseDate!", frozenset())},
    "TitleMeterRanking": {"currentRank": ("Int!", frozenset())},
}
SCALARS = {"ID", "String", "Int", "Float", "Boolean", "Date"}
ENUMS = {
    "ChartTitleType": {"TOP_RATED_MOVIES", "TOP_RATED_TV_SHOWS", "TOP_RATED_ENGLISH_MOVIES",
                       "TOP_RATED_INDIAN_MOVIES", "LOWEST_RATED_MOVIES", "MOST_POPULAR_MOVIES",
                       "MOST_POPULAR_TV_SHOWS"},
    "AdvancedTitleSearchSortBy": {"POPULARITY", "USER_RATING", "USER_RATING_COUNT", "RELEASE_DATE",
                                  "TITLE_REGIONAL", "RUNTIME", "YEAR", "BOX_OFFICE_GROSS_DOMESTIC",
                                  "METACRITIC_SCORE", "RANKING"},
    "SortOrder": {"ASC", "DESC"},
}
_RANGE_F = {"min": "Float", "max": "Float"}
_RANGE_I = {"min": "Int", "max": "Int"}
# input types by position: (field, argument) -> a type name or {key: type}
INPUTS: dict[tuple[str, str], object] = {
    ("advancedTitleSearch", "first"): "Int",
    ("advancedTitleSearch", "after"): "String",
    ("advancedTitleSearch", "constraints"): {
        "titleTypeConstraint": {"anyTitleTypeIds": "[String!]", "excludeTitleTypeIds": "[String!]"},
        "releaseDateConstraint": {"releaseDateRange": {"start": "Date", "end": "Date"}},
        "userRatingsConstraint": {"aggregateRatingRange": _RANGE_F, "ratingsCountRange": _RANGE_I},
        "genreConstraint": {"allGenreIds": "[String!]", "anyGenreIds": "[String!]",
                            "excludeGenreIds": "[String!]"},
    },
    ("advancedTitleSearch", "sort"): {"sortBy": "AdvancedTitleSearchSortBy!", "sortOrder": "SortOrder!"},
    ("chartTitles", "chart"): {"chartType": "ChartTitleType!"},
    ("chartTitles", "first"): "Int",
    ("chartTitles", "after"): "String",
    ("releaseDates", "first"): "Int",
    ("releaseDates", "after"): "String",
}


@dataclass
class ImdbTitle:
    id: str
    text: str
    type: str = "movie"  # movie | tvSeries | tvMiniSeries
    year: int | None = None
    rating: float | None = 8.0
    votes: int = 100_000
    rank: int | None = 100  # meterRanking.currentRank
    release: dt.date | tuple | None = None  # primary releaseDate; a tuple = partial (y,) / (y, m)
    releases: list = field(default_factory=list)  # every release date (dates or partial tuples)
    genres: list = field(default_factory=list)
    image: str | None = "default"
    end_year: int | None = None

    @staticmethod
    def _d(d) -> dict | None:
        if d is None:
            return None
        if isinstance(d, dt.date):
            return {"year": d.year, "month": d.month, "day": d.day}
        y, m, dd = (tuple(d) + (None, None, None))[:3]
        return {"year": y, "month": m, "day": dd}

    def node(self) -> dict:
        """Every field the schema models, with IMDb's JSON shapes."""
        rel = self.releases or ([self.release] if self.release is not None else [])
        img = IMG.format(id=self.id) if self.image == "default" else self.image
        rating = self.rating
        if isinstance(rating, float) and rating.is_integer():
            rating = int(rating)  # IMDb writes 8, not 8.0 (recorded)
        return {
            "id": self.id,
            "titleText": {"text": self.text},
            "releaseYear": {"year": self.year, "endYear": self.end_year} if self.year else None,
            "ratingsSummary": {"aggregateRating": rating, "voteCount": self.votes},
            "primaryImage": {"url": img} if img else None,
            "releaseDate": self._d(self.release),
            "releaseDates": {"edges": [{"node": self._d(d)} for d in rel]},
            "meterRanking": {"currentRank": self.rank} if self.rank else None,
        }

    def full_dates(self) -> list[dt.date]:
        rel = self.releases or ([self.release] if self.release is not None else [])
        return [d for d in rel if isinstance(d, dt.date)]

    @classmethod
    def from_node(cls, t: dict, *, type: str = "movie", genres: list | None = None) -> ImdbTitle:
        """A title rebuilt from a recorded node (fields the query didn't ask
        for get the dataclass defaults; they are never answered for it)."""

        def date(d):
            if d is None:
                return None
            parts = tuple(x for x in (d.get("year"), d.get("month"), d.get("day")) if x is not None)
            return dt.date(*parts) if len(parts) == 3 else parts

        rs = t.get("ratingsSummary") or {}
        return cls(
            id=t["id"], text=(t.get("titleText") or {}).get("text") or t["id"], type=type,
            year=(t.get("releaseYear") or {}).get("year"), end_year=(t.get("releaseYear") or {}).get("endYear"),
            rating=rs.get("aggregateRating"), votes=rs.get("voteCount") or 0,
            rank=(t.get("meterRanking") or {}).get("currentRank"),
            release=date(t.get("releaseDate")),
            releases=[date(e["node"]) for e in (t.get("releaseDates") or {}).get("edges", [])],
            genres=list(genres or []),
            image=(t.get("primaryImage") or {}).get("url") if "primaryImage" in t else "default",
        )


class GraphQLError(Exception):
    def __init__(self, message: str, code: str = "GRAPHQL_VALIDATION_FAILED"):
        super().__init__(message)
        self.code = code


def _base(t: str) -> str:
    return t.strip("[]!")


def _check_type(t: str, v, where: str) -> None:
    """A JSON value against a GraphQL input type ("[String!]!", "Date", an enum)."""
    if v is None:
        if t.endswith("!"):
            raise GraphQLError(f'Expected non-nullable type "{t}" not to be null at {where}.', "BAD_USER_INPUT")
        return
    t = t.rstrip("!")
    if t.startswith("["):
        for i, x in enumerate(v if isinstance(v, list) else [v]):  # input coercion: a scalar is a 1-list
            _check_type(t[1:-1], x, f"{where}[{i}]")
        return
    ok = {
        "Int": lambda x: isinstance(x, int) and not isinstance(x, bool) and -2**31 <= x < 2**31,
        "Float": lambda x: isinstance(x, (int, float)) and not isinstance(x, bool),
        "String": lambda x: isinstance(x, str),
        "ID": lambda x: isinstance(x, (str, int)) and not isinstance(x, bool),
        "Boolean": lambda x: isinstance(x, bool),
        "Date": lambda x: isinstance(x, str) and re.fullmatch(r"\d{4}-\d{2}-\d{2}", x) is not None,
    }.get(t)
    if ok is None:
        if t not in ENUMS:
            raise AssertionError(f"ImdbSim: unknown input type {t}")
        ok = lambda x: x in ENUMS[t]  # noqa: E731
    if not ok(v):
        raise GraphQLError(f'Expected type "{t}" at {where}, found {json.dumps(v)}.', "BAD_USER_INPUT")


class ImdbSim:
    def __init__(self, router):
        self.titles: list[ImdbTitle] = []
        self.charts: dict[str, list[str]] = {}
        self.requests: list[tuple[dict, httpx.Headers]] = []
        self.ops: list[str] = []
        self.errors: list[str] = []
        self._faults: list = []
        self.route = router.post(URL).mock(side_effect=self._handle)

    def add(self, *titles: ImdbTitle) -> None:
        self.titles.extend(titles)

    def set_chart(self, chart_type: str, ids: list[str]) -> None:
        assert chart_type in ENUMS["ChartTitleType"], chart_type
        self.charts[chart_type] = list(ids)

    def fail(self, *, status: int | None = None, exc: Exception | None = None, errors: list | None = None,
             body=None, times: int = 1) -> None:
        self._faults.extend([(status, exc, errors, body)] * times)

    def by_id(self, tid: str) -> ImdbTitle:
        return next(t for t in self.titles if t.id == tid)

    # ---- HTTP ----
    def _handle(self, request: httpx.Request) -> httpx.Response:
        payload = json.loads(request.content)
        q, v = payload["query"], payload.get("variables") or {}
        m = re.search(r"(?:query|mutation)\s+(\w+)", q)
        self.ops.append(m.group(1) if m else "?")
        self.requests.append((v, request.headers))
        if not request.headers.get("x-imdb-client-name"):
            return httpx.Response(403, text=FORBIDDEN_HTML, headers={"content-type": "text/html"})
        if self._faults:
            status, exc, errors, body = self._faults.pop(0)
            if exc is not None:
                raise exc
            if errors is not None:
                return httpx.Response(200, json={"errors": errors, "data": None})
            if body is not None:
                return httpx.Response(status or 200, json=body)
            return httpx.Response(status, text="error")
        try:
            data = self.execute(q, v, payload.get("operationName"))
        except GraphQLError as e:
            self.errors.append(str(e))
            err = {"message": str(e), "extensions": {"code": e.code, "errorType": "CLIENT", "isRetryable": False}}
            return httpx.Response(400, json={"errors": [err], "extensions": DISCLAIMER})
        return httpx.Response(200, json={"data": data, "extensions": DISCLAIMER})

    # ---- GraphQL ----
    def execute(self, query: str, variables: dict, operation_name: str | None = None) -> dict:
        try:
            doc = gql.parse(query)
            op = doc.operation(operation_name)
        except gql.GraphQLSyntaxError as e:
            raise GraphQLError(str(e), "GRAPHQL_PARSE_FAILED") from e
        if op.kind != "query":
            raise GraphQLError(f"The {op.kind} type is not supported by this fake.")
        used = gql.used_variables(doc, op)
        for name in used - set(op.variables):
            raise GraphQLError(f'Variable "${name}" is not defined by operation "{op.name}".')
        for name in set(op.variables) - used:
            raise GraphQLError(f'Variable "${name}" is never used in operation "{op.name}".')
        for name, vd in op.variables.items():
            if name not in variables:
                if vd.type.endswith("!") and not vd.has_default:
                    raise GraphQLError(f'Variable "${name}" of required type "{vd.type}" was not provided.',
                                       "BAD_USER_INPUT")
                variables = {**variables, name: vd.default}
            _check_type(vd.type, variables[name], f'variable "${name}"')
        self._validate(doc, op, op.selections, "Query")
        out = {}
        for f in doc.fields(op.selections, "Query"):
            args = {k: gql.value(a, variables) for k, a in f.args.items()}
            for k, a in args.items():
                self._check_input(f.name, k, a)
            raw = self._advanced(args) if f.name == "advancedTitleSearch" else self._chart(args)
            out[f.key] = self._project(doc, raw, SCHEMA["Query"][f.name][0], f.selections, variables)
        return out

    def _validate(self, doc, op, selections, type_name: str) -> None:
        for f in doc.fields(selections, type_name):
            fdef = SCHEMA[type_name].get(f.name)
            if fdef is None:
                raise GraphQLError(f'Cannot query field "{f.name}" on type "{type_name}".')
            ftype, fargs = fdef
            for a, raw in f.args.items():
                if a not in fargs:
                    raise GraphQLError(f'Unknown argument "{a}" on field "{type_name}.{f.name}".')
                self._check_var_positions(f.name, a, raw, INPUTS.get((f.name, a)), op)
            leaf = _base(ftype) in SCALARS
            if leaf and f.selections is not None:
                raise GraphQLError(f'Field "{f.name}" must not have a selection since type "{ftype}" '
                                   'has no subfields.')
            if not leaf and f.selections is None:
                raise GraphQLError(f'Field "{f.name}" of type "{ftype}" must have a selection of subfields. '
                                   f'Did you mean "{f.name} {{ ... }}"?')
            if not leaf:
                self._validate(doc, op, f.selections, _base(ftype))

    def _check_var_positions(self, fname: str, arg: str, raw, expected, op, path: str = "") -> None:
        """A variable must be declared with the type of the position it is used in."""
        if isinstance(raw, gql.Var):
            declared = op.variables[raw.name].type
            if isinstance(expected, str):
                want = expected
                nullable_into_nonnull = want.endswith("!") and not declared.endswith("!")
                if declared.rstrip("!") != want.rstrip("!") or nullable_into_nonnull:
                    raise GraphQLError(f'Variable "${raw.name}" of type "{declared}" used in position '
                                       f'expecting type "{want}".')
            return
        if isinstance(raw, dict):
            if not isinstance(expected, dict):
                raise GraphQLError(f'Expected value of type "{expected}", found an object at {fname}.{arg}{path}.')
            for k, x in raw.items():
                if k not in expected:
                    raise GraphQLError(f'Field "{k}" is not defined by the input type at {fname}.{arg}{path}.')
                self._check_var_positions(fname, arg, x, expected[k], op, f"{path}.{k}")
        elif isinstance(raw, list) and isinstance(expected, str):
            for x in raw:
                self._check_var_positions(fname, arg, x, expected.rstrip("!")[1:-1], op, path + "[]")

    def _check_input(self, fname: str, arg: str, val, expected=None, where: str = "") -> None:
        expected = INPUTS[(fname, arg)] if expected is None else expected
        where = where or f"{fname}({arg})"
        if isinstance(expected, dict):
            if val is None:
                return
            if not isinstance(val, dict):
                raise GraphQLError(f"Expected an input object at {where}.", "BAD_USER_INPUT")
            for k, t in expected.items():
                if isinstance(t, str) and t.endswith("!") and k not in val:
                    raise GraphQLError(f'Field "{k}" of required type "{t}" was not provided at {where}.',
                                       "BAD_USER_INPUT")
            for k, x in val.items():
                self._check_input(fname, arg, x, expected[k], f"{where}.{k}")
        else:
            _check_type(expected, val, where)

    def _project(self, doc, value, type_ref: str, selections, variables):
        """Exactly the selection set of `value` (a full resolved object)."""
        if value is None or selections is None:
            return value
        if isinstance(value, list):
            return [self._project(doc, x, type_ref.rstrip("!")[1:-1], selections, variables) for x in value]
        tname = _base(type_ref)
        out = {}
        for f in doc.fields(selections, tname):
            if f.key in out:
                continue  # merged duplicates (same field asked twice)
            ftype = SCHEMA[tname][f.name][0]
            if f.name not in value:
                raise AssertionError(f"ImdbSim models {tname}.{f.name} in SCHEMA but has no data for it")
            v = value[f.name]
            first = gql.value(f.args.get("first"), variables) if "first" in f.args else None
            if first is not None and isinstance(v, dict) and "edges" in v:
                v = {**v, "edges": v["edges"][:first]}
            out[f.key] = self._project(doc, v, ftype, f.selections, variables)
        return out

    # ---- resolvers (full objects; _project cuts them to the selection) ----
    def _advanced(self, args: dict) -> dict:
        c = args.get("constraints") or {}
        pool = list(self.titles)
        known = {"titleTypeConstraint", "releaseDateConstraint", "userRatingsConstraint", "genreConstraint"}
        assert set(c) <= known, f"ImdbSim: constraints {set(c) - known} not modelled"
        if "titleTypeConstraint" in c:
            ttc = c["titleTypeConstraint"]
            assert set(ttc) <= {"anyTitleTypeIds"}, f"ImdbSim: titleTypeConstraint {ttc} not modelled"
            types = set(ttc.get("anyTitleTypeIds") or [])
            pool = [t for t in pool if t.type in types]
        if "releaseDateConstraint" in c:
            r = c["releaseDateConstraint"]["releaseDateRange"]
            start = dt.date.fromisoformat(r["start"]) if r.get("start") else dt.date.min
            end = dt.date.fromisoformat(r["end"]) if r.get("end") else dt.date.max
            pool = [t for t in pool if any(start <= d <= end for d in t.full_dates())]
        if "userRatingsConstraint" in c:
            ur = c["userRatingsConstraint"]
            for rng, get in (("aggregateRatingRange", lambda t: t.rating), ("ratingsCountRange", lambda t: t.votes)):
                if rng in ur:
                    lo, hi = ur[rng].get("min"), ur[rng].get("max")
                    pool = [t for t in pool if get(t) is not None
                            and (lo is None or get(t) >= lo) and (hi is None or get(t) <= hi)]
        if "genreConstraint" in c:
            gc = c["genreConstraint"]
            assert set(gc) <= {"allGenreIds"}, f"ImdbSim: genreConstraint {gc} not modelled"
            pool = [t for t in pool if set(gc["allGenreIds"]) <= set(t.genres)]
        sort = args.get("sort")
        assert sort, "ImdbSim: advancedTitleSearch without a sort is not modelled"
        desc = sort["sortOrder"] == "DESC"
        if sort["sortBy"] == "POPULARITY":  # unranked last either way
            pool.sort(key=lambda t: (t.rank is None, -(t.rank or 0) if desc else (t.rank or 0)))
        elif sort["sortBy"] == "USER_RATING":
            pool.sort(key=lambda t: (t.rating is None, -(t.rating or 0) if desc else (t.rating or 0)))
        else:
            raise AssertionError(f"ImdbSim: sortBy {sort['sortBy']} not modelled")
        first = args.get("first")
        assert first is not None, "ImdbSim: advancedTitleSearch's default page size is not modelled"
        return {"edges": [{"node": {"title": t.node()}} for t in pool[:first]]}

    def _chart(self, args: dict) -> dict:
        ids = self.charts.get(args["chart"]["chartType"], [])
        first = args.get("first")
        assert first is not None, "ImdbSim: chartTitles' default page size is not modelled"
        return {"edges": [{"currentRank": i, "node": self.by_id(t).node()}
                          for i, t in enumerate(ids[:first], 1)]}
