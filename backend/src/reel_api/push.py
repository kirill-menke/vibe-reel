"""Web Push for VibeReel's iPhone app — "Ready to watch" (and new seasons).

  GET  /api/push/config        {enabled, key}: the VAPID public key the client
                               subscribes with (enabled=false: no key set up)
  POST /api/push/subscribe     {subscription, token, user_id, device_id,
                               ready, seasons} -> {ok, user}
  POST /api/push/status        {endpoint} -> {subscribed, ready, seasons}
  POST /api/push/unsubscribe   {endpoint}
  POST /api/push/test          {endpoint}: one test notification to it

A subscription belongs to a Jellyfin user: `token` is that user's Jellyfin
access token, checked against /Users/Me on subscribe (so user_id can't be
made up) and used afterwards to look landed titles up *as that user*. A token
Jellyfin later rejects drops the user's subscriptions — a signed-out phone
stops getting notifications; the app re-registers on its next start.

What counts as "ready": the same thing as the bell's "Ready to watch" on the
TV (landed.svelte.js) — a download that has been imported *and* is in
Jellyfin. The client diffs the activity queue; the server doesn't have to:
Sonarr/Radarr keep an import history (`downloadFolderImported` events, with
series/episode or movie attached), which is polled every POLL_S from a
persisted watermark. That is more reliable than a queue diff (a grab that
comes and goes between two polls is still in the history, and so is anything
imported while this service was down) and needs no webhook set up in the arrs.
Each import is then looked up in Jellyfin until the library scan has it
(CONFIRM_FOR_S at most), as each subscribed user:

  - episodes of one series found in the same pass become one notification
    ("Season 2 · 3 new episodes"); an episode whose siblings from the same
    import batch are still missing waits up to HOLD_SIBLINGS_S for them;
  - an upgrade (the arr deleted the old file for this one, reason "Upgrade")
    and anything the user has already watched never notifies;
  - every (user, title, episode) notifies once — the sent set is persisted.

New seasons (optional, per subscription): the bell's /api/news "aired" items,
diffed every NEWS_POLL_S; the first pass after start-up only takes a baseline.

VAPID: the private key is VAPID_PRIVATE_KEY in the service's environment file
(raw P-256 scalar, base64url; see generate_key()), the public key is derived
from it. VAPID_SUBJECT is the contact claim push services want (https: or
mailto:). Subscriptions and watcher state live in $STATE_DIRECTORY/push.json.
"""

import asyncio
import base64
import json
import logging
import os
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

import httpx
from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

log = logging.getLogger("reel_api")

POLL_S = 60
NEWS_POLL_S = 600
CONFIRM_FOR_S = 45 * 60      # a Jellyfin scan takes seconds to minutes
HOLD_SIBLINGS_S = 180
UPGRADE_WINDOW_S = 15 * 60   # file deleted as "Upgrade" this close to an import
SEEN_KEEP = 2000
SENT_KEEP = 3000
TTL_READY = 24 * 3600        # a notification nobody could deliver for a day is stale
TTL_NEWS = 3 * 24 * 3600
ICON = "/icons/icon-192.png"

router = APIRouter()
_push: "Push | None" = None


def _b64u(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()


def _unb64u(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def generate_key() -> tuple[str, str]:
    """(private, public) as base64url — for provisioning the env file:
    python -c 'from reel_api.push import generate_key; print(generate_key()[0])'"""
    from cryptography.hazmat.primitives.asymmetric import ec

    k = ec.generate_private_key(ec.SECP256R1())
    raw = k.private_numbers().private_value.to_bytes(32, "big")
    return _b64u(raw), _public_of(_b64u(raw))


def _public_of(private_b64: str) -> str:
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric import ec

    k = ec.derive_private_key(int.from_bytes(_unb64u(private_b64), "big"), ec.SECP256R1())
    return _b64u(
        k.public_key().public_bytes(
            serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint
        )
    )


def _state_dir() -> Path:
    # systemd StateDirectory= sets STATE_DIRECTORY; else next to the cache
    # (dev runs: /tmp).
    base = os.environ.get("STATE_DIRECTORY") or os.environ.get("CACHE_DIRECTORY") or os.path.join(
        os.environ.get("TMPDIR", "/tmp"), "reel-api-state"
    )
    p = Path(base.split(":")[0])
    p.mkdir(parents=True, exist_ok=True)
    return p


def _iso(d: datetime) -> str:
    return d.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _parse(s: str | None) -> datetime | None:
    if not s:
        return None
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00"))
    except ValueError:
        return None


def _norm(s: str) -> str:
    return "".join(ch for ch in (s or "").casefold() if ch.isalnum())


class Push:
    def __init__(self, arr_clients: dict):
        self.arr = arr_clients
        self.priv = (os.environ.get("VAPID_PRIVATE_KEY") or "").strip()
        # The VAPID `sub` claim: a mailto: or https: URL push services can
        # reach you at. Apple rejects placeholder domains, so set it.
        self.subject = os.environ.get("VAPID_SUBJECT") or "mailto:admin@localhost"
        self.jf = (os.environ.get("JELLYFIN_URL") or "http://127.0.0.1:8096").rstrip("/")
        self.public = None
        if self.priv and not os.environ.get("VAPID_SUBJECT"):
            log.warning("push: VAPID_SUBJECT unset — Apple's push service may reject %s", self.subject)
        if self.priv:
            try:
                self.public = _public_of(self.priv)
            except Exception as e:  # noqa: BLE001
                log.error("push: VAPID_PRIVATE_KEY unusable (%s) — push disabled", e)
        self.path = _state_dir() / "push.json"
        self.state = self._load()
        self.lock = asyncio.Lock()
        self.http = httpx.AsyncClient(timeout=20)
        self.task: asyncio.Task | None = None

    # ---------------- persistence ----------------

    def _load(self) -> dict:
        try:
            st = json.loads(self.path.read_text())
            if isinstance(st, dict):
                st.setdefault("subs", {})
                st.setdefault("since", {})
                st.setdefault("seen", {})
                st.setdefault("cands", [])
                st.setdefault("upgrades", [])
                st.setdefault("sent", {})
                st.setdefault("news", None)
                return st
        except (OSError, ValueError):
            pass
        return {"subs": {}, "since": {}, "seen": {}, "cands": [], "upgrades": [], "sent": {}, "news": None}

    def _save(self) -> None:
        tmp = self.path.with_suffix(".tmp")
        try:
            fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
            with os.fdopen(fd, "w") as f:
                json.dump(self.state, f)
            os.replace(tmp, self.path)
        except OSError as e:
            log.warning("push: could not save state: %s", e)

    @property
    def enabled(self) -> bool:
        return bool(self.public)

    # ---------------- Jellyfin ----------------

    def _auth(self, token: str) -> dict:
        return {"Authorization": f'MediaBrowser Client="reel-api", Device="NAS", DeviceId="reel-api-push", Version="1", Token="{token}"'}

    async def _jf(self, token: str, path: str, params: dict | None = None):
        """GET as a user. Returns the JSON, None on 401 (token gone), raises on
        anything else (the pass is retried later)."""
        r = await self.http.get(self.jf + path, params=params or {}, headers=self._auth(token))
        if r.status_code == 401:
            return None
        r.raise_for_status()
        return r.json()

    # ---------------- sending ----------------

    def _send_sync(self, sub: dict, payload: dict, ttl: int) -> int:
        from pywebpush import WebPushException, webpush

        try:
            webpush(
                subscription_info={"endpoint": sub["endpoint"], "keys": sub["keys"]},
                data=json.dumps(payload),
                vapid_private_key=self.priv,
                vapid_claims={"sub": self.subject},  # a fresh dict: webpush() adds aud/exp to it
                ttl=ttl,
                timeout=15,
            )
            return 201
        except WebPushException as e:
            code = e.response.status_code if e.response is not None else 0
            body = (e.response.text[:200] if e.response is not None else str(e))
            log.warning("push: %s answered %s: %s", sub["endpoint"].split("/")[2], code, body)
            return code
        except Exception as e:  # noqa: BLE001 — network
            log.warning("push: send failed: %s", e)
            return 0

    async def send(self, sub: dict, payload: dict, ttl: int) -> int:
        code = await asyncio.to_thread(self._send_sync, sub, payload, ttl)
        if code in (404, 410):  # the browser dropped this subscription
            self.state["subs"].pop(sub["endpoint"], None)
            log.info("push: subscription gone (%s), removed", code)
        elif 200 <= code < 300:
            sub["last_ok"] = time.time()
        return code

    # ---------------- subscriptions ----------------

    async def subscribe(self, body: dict) -> JSONResponse | dict:
        sub = body.get("subscription") or {}
        endpoint = sub.get("endpoint") or ""
        keys = sub.get("keys") or {}
        token = body.get("token") or ""
        if not endpoint.startswith("https://") or not keys.get("p256dh") or not keys.get("auth") or not token:
            return JSONResponse(status_code=400, content={"error": "bad_request", "detail": "subscription and token required"})
        try:
            me = await self._jf(token, "/Users/Me")
        except httpx.HTTPError as e:
            log.warning("push: Jellyfin check failed: %s", e)
            return JSONResponse(status_code=503, content={"error": "temporarily_unavailable", "detail": "Jellyfin unreachable"})
        if not me or not me.get("Id"):
            return JSONResponse(status_code=401, content={"error": "unauthorized", "detail": "Jellyfin rejected the token"})
        uid = str(me["Id"]).replace("-", "").lower()
        if body.get("user_id") and str(body["user_id"]).replace("-", "").lower() != uid:
            return JSONResponse(status_code=403, content={"error": "forbidden", "detail": "token belongs to another user"})
        # no lock: nothing below awaits, and the watcher only iterates copies
        old = self.state["subs"].get(endpoint) or {}
        self.state["subs"][endpoint] = {
            "endpoint": endpoint,
            "keys": {"p256dh": keys["p256dh"], "auth": keys["auth"]},
            "user_id": uid,
            "user_name": me.get("Name") or "",
            "token": token,
            "device_id": str(body.get("device_id") or "")[:100],
            "ready": bool(body.get("ready", True)),
            "seasons": bool(body.get("seasons", False)),
            "created": old.get("created") or time.time(),
            "last_ok": old.get("last_ok"),
        }
        # one browser subscription per device: a re-subscribe (new endpoint
        # after iOS rotated it) replaces the device's old one
        dev = self.state["subs"][endpoint]["device_id"]
        if dev:
            for ep in [ep for ep, s in self.state["subs"].items() if ep != endpoint and s.get("device_id") == dev]:
                del self.state["subs"][ep]
        self._save()
        return {"ok": True, "user": me.get("Name") or ""}

    def status(self, endpoint: str) -> dict:
        s = self.state["subs"].get(endpoint)
        return {"subscribed": bool(s), "ready": bool(s and s["ready"]), "seasons": bool(s and s["seasons"])}

    async def unsubscribe(self, endpoint: str) -> dict:
        if self.state["subs"].pop(endpoint, None):
            self._save()
        return {"ok": True}

    async def test(self, endpoint: str):
        s = self.state["subs"].get(endpoint)
        if not s:
            return JSONResponse(status_code=404, content={"error": "not_found", "detail": "not subscribed"})
        code = await self.send(s, {
            "title": "VibeReel",
            "body": "Notifications work. You’ll hear from VibeReel when a download is ready to watch.",
            "tag": "test",
            "open": {"type": "home"},
        }, 600)
        self._save()
        if not 200 <= code < 300:
            return JSONResponse(status_code=502, content={"error": "push_failed", "detail": f"push service answered {code}"})
        return {"ok": True}

    # ---------------- the watcher ----------------

    def start(self) -> None:
        if self.enabled and self.task is None:
            self.task = asyncio.create_task(self._loop())

    async def _loop(self) -> None:
        await asyncio.sleep(15)
        last_news = 0.0
        while True:
            try:
                async with self.lock:
                    await self.tick()
                    if time.monotonic() - last_news >= NEWS_POLL_S or last_news == 0:
                        last_news = time.monotonic()
                        await self.news_tick()
                    self._save()
            except asyncio.CancelledError:
                raise
            except Exception as e:  # noqa: BLE001 — a failed pass only logs
                log.warning("push watcher: %s", e)
            await asyncio.sleep(POLL_S)

    def _users(self, want: str) -> dict[str, list[dict]]:
        """user_id -> that user's subscriptions with `want` switched on."""
        out: dict[str, list[dict]] = {}
        for s in self.state["subs"].values():
            if s.get(want):
                out.setdefault(s["user_id"], []).append(s)
        return out

    async def tick(self) -> None:
        now = datetime.now(timezone.utc)
        wanted = bool(self._users("ready"))
        for kind, client in self.arr.items():
            since = _parse(self.state["since"].get(kind))
            if since is None:
                # first start: nothing before now is news
                self.state["since"][kind] = _iso(now)
                continue
            params = {"date": _iso(since - timedelta(minutes=2))}
            if kind == "tv":
                params.update(includeSeries="true", includeEpisode="true")
            else:
                params.update(includeMovie="true")
            events = await client._get("/api/v3/history/since", params)
            seen = self.state["seen"].setdefault(kind, [])
            seen_set = set(seen)
            newest = since
            for ev in events:
                hid = ev.get("id")
                if hid in seen_set:
                    continue
                seen.append(hid)
                seen_set.add(hid)
                when = _parse(ev.get("date")) or now
                newest = max(newest, when)
                et = ev.get("eventType")
                if et in ("episodeFileDeleted", "movieFileDeleted"):
                    if ((ev.get("data") or {}).get("reason") or "").lower() == "upgrade":
                        self.state["upgrades"].append({"k": self._ref(kind, ev), "t": when.timestamp()})
                elif et == "downloadFolderImported" and wanted:
                    c = self._candidate(kind, ev, when)
                    if c:
                        self.state["cands"].append(c)
            del seen[:-SEEN_KEEP]
            self.state["since"][kind] = _iso(min(newest, now))
        cut = time.time() - 2 * UPGRADE_WINDOW_S
        self.state["upgrades"] = [u for u in self.state["upgrades"] if u["t"] > cut]
        if self.state["cands"]:
            await self._confirm()

    @staticmethod
    def _ref(kind: str, ev: dict) -> str:
        return f"{kind}:{ev.get('episodeId') if kind == 'tv' else ev.get('movieId')}"

    def _candidate(self, kind: str, ev: dict, when: datetime) -> dict | None:
        if kind == "tv":
            s, e = ev.get("series") or {}, ev.get("episode") or {}
            if not s.get("tvdbId") or e.get("seasonNumber") is None:
                return None
            return {
                "kind": "tv", "ref": self._ref(kind, ev), "gk": f"tv:{s['tvdbId']}",
                "ext": str(s["tvdbId"]), "title": s.get("title") or "", "year": s.get("year"),
                "s": e.get("seasonNumber"), "e": e.get("episodeNumber"), "ep_title": e.get("title") or "",
                "at": when.timestamp(), "first": time.time(), "done": [],
            }
        m = ev.get("movie") or {}
        if not m.get("tmdbId"):
            return None
        return {
            "kind": "movie", "ref": self._ref(kind, ev), "gk": f"movie:{m['tmdbId']}",
            "ext": str(m["tmdbId"]), "title": m.get("title") or "", "year": m.get("year"),
            "at": when.timestamp(), "first": time.time(), "done": [],
        }

    def _is_upgrade(self, c: dict) -> bool:
        return any(u["k"] == c["ref"] and abs(u["t"] - c["at"]) <= UPGRADE_WINDOW_S for u in self.state["upgrades"])

    def _sent(self, uid: str) -> list:
        return self.state["sent"].setdefault(uid, [])

    @staticmethod
    def _key(c: dict) -> str:
        return f"{c['gk']}:{c['s']}x{c['e']}" if c["kind"] == "tv" else c["gk"]

    async def _find(self, token: str, uid: str, c: dict):
        """The Jellyfin series/movie for a candidate, as that user (None if not
        there yet, False if the token is dead)."""
        r = await self._jf(token, "/Items", {
            "SearchTerm": c["title"], "IncludeItemTypes": "Series" if c["kind"] == "tv" else "Movie",
            "Recursive": "true", "Fields": "ProviderIds", "Limit": 20, "userId": uid,
        })
        if r is None:
            return False
        items = r.get("Items") or []
        pk = "Tvdb" if c["kind"] == "tv" else "Tmdb"
        hit = next((i for i in items if str((i.get("ProviderIds") or {}).get(pk) or "") == c["ext"]), None)
        if hit is None:
            hit = next((i for i in items if _norm(i.get("Name")) == _norm(c["title"])), None)
        return hit

    async def _confirm(self) -> None:
        users = self._users("ready")
        now = time.time()
        cands = self.state["cands"]
        # upgrades never notify
        cands[:] = [c for c in cands if not self._is_upgrade(c)]
        for uid, subs in users.items():
            token = max(subs, key=lambda s: s.get("created") or 0)["token"]
            sent = set(self._sent(uid))
            groups: dict[str, list[dict]] = {}
            for c in cands:
                if uid not in c["done"]:
                    if self._key(c) in sent:
                        c["done"].append(uid)
                    else:
                        groups.setdefault(c["gk"], []).append(c)
            for gk, group in groups.items():
                try:
                    found = await self._find(token, uid, group[0])
                    if found is False:
                        self._drop_user(uid)
                        break
                    if not found:
                        continue
                    ready = []
                    if group[0]["kind"] == "movie":
                        ud = found.get("UserData") or {}
                        if not ud.get("Played"):
                            ready = group
                        for c in group:
                            c["done"].append(uid)
                    else:
                        er = await self._jf(token, f"/Shows/{found['Id']}/Episodes", {
                            "userId": uid, "IsMissing": "false", "Fields": "DateCreated",
                        })
                        if er is None:
                            self._drop_user(uid)
                            break
                        eps = er.get("Items") or []
                        for c in group:
                            ep = next((x for x in eps if x.get("ParentIndexNumber") == c["s"] and (
                                x.get("IndexNumber") == c["e"]
                                or ((x.get("IndexNumber") or 0) < (c["e"] or 0) <= (x.get("IndexNumberEnd") or -1)))), None)
                            if ep is None:
                                continue
                            c["done"].append(uid)
                            if not (ep.get("UserData") or {}).get("Played"):
                                ready.append(c)
                        # an import batch arrives over a minute or two: hold the
                        # found ones back while young siblings are still missing
                        waiting = [c for c in group if uid not in c["done"] and now - c["first"] < HOLD_SIBLINGS_S]
                        if waiting and ready:
                            for c in ready:
                                c["done"].remove(uid)
                            continue
                    if ready:
                        await self._notify_ready(uid, users.get(uid, []), found, ready)
                        self._sent(uid).extend(self._key(c) for c in ready)
                except httpx.HTTPError as e:
                    log.info("push: Jellyfin lookup failed (%s), retrying next pass", e)
                    break
            del self._sent(uid)[:-SENT_KEEP]
        live = set(self._users("ready"))
        cands[:] = [c for c in cands if now - c["first"] < CONFIRM_FOR_S and not live.issubset(c["done"])]

    def _drop_user(self, uid: str) -> None:
        log.info("push: Jellyfin rejected the token of user %s — dropping their subscriptions", uid)
        for ep in [ep for ep, s in self.state["subs"].items() if s["user_id"] == uid]:
            del self.state["subs"][ep]

    async def _notify_ready(self, uid: str, subs: list[dict], item: dict, ready: list[dict]) -> None:
        c0 = ready[0]
        if c0["kind"] == "movie":
            title = item.get("Name") or c0["title"]
            body = "Ready to watch" + (f" · {item['ProductionYear']}" if item.get("ProductionYear") else "")
        else:
            title = item.get("Name") or c0["title"]
            eps = sorted({(c["s"], c["e"]) for c in ready})
            if len(eps) == 1:
                body = f"S{eps[0][0]}E{eps[0][1]}" + (f" · {c0['ep_title']}" if c0.get("ep_title") else "") + " is ready to watch"
            else:
                seasons = {s for s, _ in eps}
                n = f"{len(eps)} new episodes are ready to watch"
                body = (f"Season {next(iter(seasons))} · " + n) if len(seasons) == 1 else n
        payload = {
            "title": title,
            "body": body,
            "tag": "ready:" + c0["gk"],
            "open": {"type": "item", "id": item["Id"], "itemType": item.get("Type") or ("Series" if c0["kind"] == "tv" else "Movie")},
        }
        for s in list(subs):
            await self.send(s, payload, TTL_READY)
        log.info("push: ready %s (%d) -> user %s", title, len(ready), uid)

    async def news_tick(self) -> None:
        client = self.arr.get("tv")
        if client is None:
            return
        items = await client.season_news()
        aired = {i["id"]: i for i in items if i.get("kind") == "aired"}
        known = self.state["news"]
        self.state["news"] = sorted(aired)
        if known is None:
            return  # baseline
        fresh = [aired[k] for k in aired if k not in set(known)]
        if not fresh:
            return
        for uid, subs in self._users("seasons").items():
            sent = self._sent(uid)
            for it in fresh:
                key = "news:" + it["id"]
                if key in sent:
                    continue
                sent.append(key)
                payload = {
                    "title": it.get("title") or "New season",
                    "body": f"Season {it['season']} is out — tap to get it",
                    "tag": "news:" + it["id"],
                    "open": {"type": "bell"},
                }
                for s in list(subs):
                    await self.send(s, payload, TTL_NEWS)


def start(arr_clients: dict) -> None:
    """Called from app.py's lifespan, once the arr clients exist."""
    global _push
    _push = Push(arr_clients)
    _push.start()
    if not _push.enabled:
        log.info("push: VAPID_PRIVATE_KEY not set — /api/push disabled")


def _need():
    if _push is None or not _push.enabled:
        return None, JSONResponse(status_code=503, content={"error": "not_available", "detail": "push notifications are not set up"})
    return _push, None


async def _json(request: Request) -> dict:
    try:
        b = await request.json()
        return b if isinstance(b, dict) else {}
    except ValueError:
        return {}


@router.get("/api/push/config")
async def push_config():
    return {"enabled": bool(_push and _push.enabled), "key": _push.public if _push else None}


@router.post("/api/push/subscribe")
async def push_subscribe(request: Request):
    p, err = _need()
    return err or await p.subscribe(await _json(request))


@router.post("/api/push/status")
async def push_status(request: Request):
    p, err = _need()
    return err or p.status(str((await _json(request)).get("endpoint") or ""))


@router.post("/api/push/unsubscribe")
async def push_unsubscribe(request: Request):
    p, err = _need()
    return err or await p.unsubscribe(str((await _json(request)).get("endpoint") or ""))


@router.post("/api/push/test")
async def push_test(request: Request):
    p, err = _need()
    return err or await p.test(str((await _json(request)).get("endpoint") or ""))
