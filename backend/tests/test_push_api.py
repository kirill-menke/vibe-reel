"""Web Push HTTP surface (push.py): config, subscribe, status, unsubscribe, test.

Jellyfin is respx at JELLYFIN; the push service is a `responses` mock at
https://push.test (pywebpush uses `requests`). The test notification is a
real pywebpush request: the test decrypts its aes128gcm body with the
subscription's own keys and verifies the VAPID JWT against the public key
/api/push/config hands out.
"""

from __future__ import annotations

import base64
import json
import os
import stat
import time
from pathlib import Path

import http_ece
import httpx
import pytest
from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.asymmetric.utils import encode_dss_signature

from reel_api import push
from tests.conftest import JELLYFIN

PUSH = "https://push.test"
SUBJECT = "mailto:test@example.com"
USER_ID = "0123456789abcdef0123456789abcdef"
USER_ID_DASHED = "01234567-89AB-CDEF-0123-456789ABCDEF"


def b64u(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()


def unb64u(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


class Browser:
    """One browser push subscription: its own P-256 key pair + auth secret."""

    def __init__(self, n: int = 1):
        self.key = ec.generate_private_key(ec.SECP256R1())
        self.auth = os.urandom(16)
        self.endpoint = f"{PUSH}/sub/{n}"

    @property
    def subscription(self) -> dict:
        pub = self.key.public_key().public_bytes(
            serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint
        )
        return {"endpoint": self.endpoint, "keys": {"p256dh": b64u(pub), "auth": b64u(self.auth)}}

    def decrypt(self, body: bytes) -> dict:
        return json.loads(http_ece.decrypt(body, private_key=self.key, auth_secret=self.auth, version="aes128gcm"))


@pytest.fixture
def vapid():
    return push.generate_key()


@pytest.fixture
def jf_me(upstream):
    """GET /Users/Me: token "tok" -> the user, anything else -> 401."""
    state = {"me": {"Id": USER_ID_DASHED, "Name": "Kirill"}}

    def handler(request):
        if 'Token="tok"' in request.headers.get("Authorization", ""):
            return httpx.Response(200, json=state["me"])
        return httpx.Response(401)

    state["route"] = upstream.get(f"{JELLYFIN}/Users/Me").mock(side_effect=handler)
    return state


@pytest.fixture
def push_api(make_api, vapid):
    def factory(**env):
        return make_api(VAPID_PRIVATE_KEY=vapid[0], VAPID_SUBJECT=SUBJECT, **env)

    return factory


def sub_body(browser: Browser, **extra) -> dict:
    return {"subscription": browser.subscription, "token": "tok", "device_id": "dev-1", **extra}


def state_file(reel_env):
    return reel_env.state / "push.json"


# ---------------------------------------------------------------- disabled


async def test_disabled_without_key(api):
    r = await api.get("/api/push/config")
    assert r.status_code == 200
    assert r.json() == {"enabled": False, "key": None}
    for path in ("subscribe", "status", "unsubscribe", "test"):
        r = await api.post(f"/api/push/{path}", json={"endpoint": f"{PUSH}/x"})
        assert r.status_code == 503, path
        assert r.json()["error"] == "not_available"
    assert push._push.task is None  # no watcher without a key


@pytest.mark.parametrize("bad", [b64u(b"\xff" * 32), b64u(b"\x00" * 32)], ids=["above-order", "zero"])
async def test_unusable_key_disables_push(make_api, caplog, bad):
    async with make_api(VAPID_PRIVATE_KEY=bad, VAPID_SUBJECT=SUBJECT) as api:
        assert (await api.get("/api/push/config")).json() == {"enabled": False, "key": None}
        r = await api.post("/api/push/subscribe", json={})
        assert r.status_code == 503 and r.json()["error"] == "not_available"
    assert "VAPID_PRIVATE_KEY unusable" in caplog.text
    assert push._push.task is None


async def test_config_returns_the_public_key_of_the_private_one(push_api, vapid):
    priv, pub = vapid
    # independent derivation: scalar * G with `cryptography`
    k = ec.derive_private_key(int.from_bytes(unb64u(priv), "big"), ec.SECP256R1())
    expect = k.public_key().public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)
    assert len(unb64u(priv)) == 32 and "=" not in priv and "=" not in pub
    assert unb64u(pub) == expect and len(expect) == 65 and expect[0] == 4
    async with push_api() as api:
        assert (await api.get("/api/push/config")).json() == {"enabled": True, "key": pub}
        assert push._push.task is not None  # the watcher runs while enabled


async def test_missing_subject_warns_and_defaults(make_api, vapid, caplog):
    async with make_api(VAPID_PRIVATE_KEY=vapid[0]) as api:
        assert (await api.get("/api/push/config")).json()["enabled"] is True
        assert push._push.subject == "mailto:admin@localhost"
    assert "VAPID_SUBJECT unset" in caplog.text


def test_generate_key_pairs_are_fresh():
    a, b = push.generate_key(), push.generate_key()
    assert a != b
    assert push._public_of(a[0]) == a[1]


# ---------------------------------------------------------------- subscribe


@pytest.mark.parametrize("mutate", [
    lambda b: b["subscription"].update(endpoint="http://push.test/sub/1"),
    lambda b: b["subscription"].update(endpoint=""),
    lambda b: b["subscription"]["keys"].pop("p256dh"),
    lambda b: b["subscription"]["keys"].pop("auth"),
    lambda b: b.pop("token"),
    lambda b: b.pop("subscription"),
], ids=["http-endpoint", "no-endpoint", "no-p256dh", "no-auth", "no-token", "no-subscription"])
async def test_subscribe_rejects_incomplete_bodies(push_api, jf_me, mutate):
    body = sub_body(Browser())
    mutate(body)
    async with push_api() as api:
        r = await api.post("/api/push/subscribe", json=body)
    assert r.status_code == 400
    assert r.json()["error"] == "bad_request"
    assert not jf_me["route"].called


@pytest.mark.parametrize("raw", [b"not json", b"[1, 2]", b'"x"'])
async def test_subscribe_non_object_body_is_400(push_api, raw):
    async with push_api() as api:
        r = await api.post("/api/push/subscribe", content=raw, headers={"content-type": "application/json"})
    assert r.status_code == 400


async def test_subscribe_checks_the_token_with_jellyfin(push_api, jf_me, reel_env):
    b = Browser()
    async with push_api() as api:
        r = await api.post("/api/push/subscribe", json=sub_body(b, token="stolen"))
        assert r.status_code == 401
        assert r.json()["error"] == "unauthorized"
        assert (await api.post("/api/push/status", json={"endpoint": b.endpoint})).json()["subscribed"] is False
    req = jf_me["route"].calls.last.request
    auth = req.headers["Authorization"]
    assert auth.startswith("MediaBrowser ") and 'Token="stolen"' in auth and 'Client="reel-api"' in auth
    assert not state_file(reel_env).exists()


async def test_subscribe_401_when_jellyfin_answers_without_an_id(push_api, jf_me):
    jf_me["me"] = {"Name": "ghost"}
    async with push_api() as api:
        r = await api.post("/api/push/subscribe", json=sub_body(Browser()))
    assert r.status_code == 401


@pytest.mark.parametrize("fault", [httpx.ConnectError("down"), httpx.Response(500)], ids=["unreachable", "500"])
async def test_subscribe_503_when_jellyfin_fails(push_api, upstream, fault):
    route = upstream.get(f"{JELLYFIN}/Users/Me")
    if isinstance(fault, Exception):
        route.mock(side_effect=fault)
    else:
        route.mock(return_value=fault)
    async with push_api() as api:
        r = await api.post("/api/push/subscribe", json=sub_body(Browser()))
    assert r.status_code == 503
    assert r.json()["error"] == "temporarily_unavailable"


async def test_subscribe_takes_the_user_from_jellyfin_not_the_body(push_api, jf_me, reel_env):
    b = Browser()
    async with push_api() as api:
        r = await api.post("/api/push/subscribe", json=sub_body(b, user_id=USER_ID_DASHED.lower()))
        assert r.status_code == 200
        assert r.json() == {"ok": True, "user": "Kirill"}
        r = await api.post("/api/push/subscribe", json=sub_body(b, user_id="ffffffffffffffffffffffffffffffff"))
        assert r.status_code == 403
        assert r.json()["error"] == "forbidden"
    saved = json.loads(state_file(reel_env).read_text())
    s = saved["subs"][b.endpoint]
    assert s["user_id"] == USER_ID  # dashes stripped, lower-case, from /Users/Me
    assert s["user_name"] == "Kirill" and s["token"] == "tok" and s["device_id"] == "dev-1"
    assert s["keys"] == b.subscription["keys"]
    assert s["ready"] is True and s["seasons"] is False  # defaults
    assert s["last_ok"] is None and s["created"] == pytest.approx(time.time(), abs=60)


async def test_subscribe_without_body_user_id_is_fine(push_api, jf_me, reel_env):
    b = Browser()
    async with push_api() as api:
        r = await api.post("/api/push/subscribe", json=sub_body(b, ready=False, seasons=True, device_id="d" * 500))
        assert r.status_code == 200
        st = (await api.post("/api/push/status", json={"endpoint": b.endpoint})).json()
    assert st == {"subscribed": True, "ready": False, "seasons": True}
    saved = json.loads(state_file(reel_env).read_text())["subs"][b.endpoint]
    assert saved["device_id"] == "d" * 100  # capped


async def test_state_file_is_0600_and_replaced_atomically(push_api, jf_me, reel_env, monkeypatch):
    replaced = []
    real_replace = os.replace

    def spy(src, dst):
        replaced.append((str(src), str(dst)))
        assert json.loads(Path(src).read_text())["subs"]  # complete before it becomes push.json
        return real_replace(src, dst)

    monkeypatch.setattr(push.os, "replace", spy)
    async with push_api() as api:
        assert (await api.post("/api/push/subscribe", json=sub_body(Browser()))).status_code == 200
    p = state_file(reel_env)
    assert replaced == [(str(p.with_suffix(".tmp")), str(p))]
    assert stat.S_IMODE(p.stat().st_mode) == 0o600
    assert not p.with_suffix(".tmp").exists()
    assert set(json.loads(p.read_text())) == {"subs", "since", "seen", "cands", "upgrades", "sent", "news"}


async def test_unwritable_state_only_logs(push_api, jf_me, reel_env, caplog):
    reel_env.state.chmod(0o500)
    try:
        async with push_api() as api:
            b = Browser()
            r = await api.post("/api/push/subscribe", json=sub_body(b))
            assert r.status_code == 200  # kept in memory
            assert (await api.post("/api/push/status", json={"endpoint": b.endpoint})).json()["subscribed"]
    finally:
        reel_env.state.chmod(0o700)
    assert "could not save state" in caplog.text
    assert not state_file(reel_env).exists()


async def test_subscriptions_survive_a_restart(push_api, jf_me):
    b = Browser()
    async with push_api() as api:
        assert (await api.post("/api/push/subscribe", json=sub_body(b, seasons=True))).status_code == 200
    push._push.task.cancel()  # the first instance's watcher
    async with push_api() as api:  # a new Push loads push.json
        st = (await api.post("/api/push/status", json={"endpoint": b.endpoint})).json()
    assert st == {"subscribed": True, "ready": True, "seasons": True}


@pytest.mark.parametrize("content", ["{not json", "[1, 2, 3]", "", '{"subs": {}}'],
                         ids=["corrupt", "list", "empty", "partial"])
async def test_corrupt_or_partial_state_falls_back_to_defaults(push_api, reel_env, content):
    state_file(reel_env).write_text(content)
    async with push_api() as api:
        assert (await api.get("/api/push/config")).json()["enabled"]
        assert push._push.state == {"subs": {}, "since": {}, "seen": {}, "cands": [], "upgrades": [],
                                    "sent": {}, "news": None}
        r = await api.post("/api/push/status", json={"endpoint": f"{PUSH}/sub/1"})
    assert r.json() == {"subscribed": False, "ready": False, "seasons": False}


async def test_missing_state_dir_is_created(push_api, reel_env, jf_me, tmp_path):
    target = tmp_path / "new" / "state"
    # systemd may list several directories; the first one is used (and created)
    async with push_api(STATE_DIRECTORY=f"{target}:{tmp_path / 'other'}") as api:
        assert (await api.post("/api/push/subscribe", json=sub_body(Browser()))).status_code == 200
    assert (target / "push.json").exists()
    assert not (tmp_path / "other").exists()


async def test_resubscribe_keeps_created_and_replaces_the_devices_old_endpoint(push_api, jf_me, reel_env):
    old, new, other = Browser(1), Browser(2), Browser(3)
    async with push_api() as api:
        await api.post("/api/push/subscribe", json=sub_body(old))
        await api.post("/api/push/subscribe", json=sub_body(other, device_id="dev-2"))
        created = push._push.state["subs"][old.endpoint]["created"]
        push._push.state["subs"][old.endpoint]["last_ok"] = 123.0
        # the same endpoint again: settings change, created/last_ok kept
        await api.post("/api/push/subscribe", json=sub_body(old, seasons=True))
        s = push._push.state["subs"][old.endpoint]
        assert s["created"] == created and s["last_ok"] == 123.0 and s["seasons"] is True
        # iOS rotated the endpoint of dev-1: the old one goes, dev-2 stays
        await api.post("/api/push/subscribe", json=sub_body(new))
        assert set(push._push.state["subs"]) == {new.endpoint, other.endpoint}
        # no device id: nothing else is replaced
        anon = Browser(4)
        await api.post("/api/push/subscribe", json=sub_body(anon, device_id=""))
        assert set(push._push.state["subs"]) == {new.endpoint, other.endpoint, anon.endpoint}
    assert set(json.loads(state_file(reel_env).read_text())["subs"]) == {new.endpoint, other.endpoint, anon.endpoint}


# ---------------------------------------------------------------- status / unsubscribe


async def test_status_and_unsubscribe_by_endpoint(push_api, jf_me, reel_env):
    a, b = Browser(1), Browser(2)
    async with push_api() as api:
        await api.post("/api/push/subscribe", json=sub_body(a))
        await api.post("/api/push/subscribe", json=sub_body(b, device_id="dev-2", ready=False))
        assert (await api.post("/api/push/status", json={"endpoint": a.endpoint})).json() == {
            "subscribed": True, "ready": True, "seasons": False}
        assert (await api.post("/api/push/status", json={})).json()["subscribed"] is False
        r = await api.post("/api/push/unsubscribe", json={"endpoint": a.endpoint})
        assert r.status_code == 200 and r.json() == {"ok": True}
        assert (await api.post("/api/push/status", json={"endpoint": a.endpoint})).json()["subscribed"] is False
        assert (await api.post("/api/push/status", json={"endpoint": b.endpoint})).json() == {
            "subscribed": True, "ready": False, "seasons": False}
    assert set(json.loads(state_file(reel_env).read_text())["subs"]) == {b.endpoint}


@pytest.fixture
def jf_two(upstream):
    """GET /Users/Me for two accounts: token "tok-a" -> Anna, "tok-b" -> Ben."""
    users = {"tok-a": {"Id": "a" * 32, "Name": "Anna"}, "tok-b": {"Id": "b" * 32, "Name": "Ben"}}

    def handler(request):
        auth = request.headers.get("Authorization", "")
        for tok, me in users.items():
            if f'Token="{tok}"' in auth:
                return httpx.Response(200, json=me)
        return httpx.Response(401)

    upstream.get(f"{JELLYFIN}/Users/Me").mock(side_effect=handler)


async def test_subscription_is_keyed_by_endpoint_with_the_users_token(push_api, jf_two, reel_env):
    """By design (README, phone push.js): one subscription per push endpoint,
    holding the token of whoever registered it last; the watcher looks titles
    up — and notifies — as that user. So an account switch on the phone
    re-subscribing the same endpoint replaces the old user, and sign-out
    (pushSignOut -> /unsubscribe {endpoint}) takes the old user's token off
    the server altogether, before anyone signs in again."""
    b = Browser()
    async with push_api() as api:
        assert (await api.post("/api/push/subscribe", json=sub_body(b, token="tok-a"))).json()["user"] == "Anna"
        subs = push._push.state["subs"]
        assert list(subs) == [b.endpoint]
        assert (subs[b.endpoint]["user_id"], subs[b.endpoint]["token"]) == ("a" * 32, "tok-a")
        assert set(push._push._users("ready")) == {"a" * 32}

        # an account switch that re-registers the endpoint: Ben replaces Anna
        assert (await api.post("/api/push/subscribe", json=sub_body(b, token="tok-b"))).json()["user"] == "Ben"
        assert list(subs) == [b.endpoint]
        assert (subs[b.endpoint]["user_id"], subs[b.endpoint]["token"]) == ("b" * 32, "tok-b")
        assert set(push._push._users("ready")) == {"b" * 32}

        # sign-out: the endpoint, and with it Ben's token, leaves the server
        r = await api.post("/api/push/unsubscribe", json={"endpoint": b.endpoint})
        assert r.json() == {"ok": True}
        assert subs == {} and push._push._users("ready") == {}
        assert (await api.post("/api/push/status", json={"endpoint": b.endpoint})).json()["subscribed"] is False
    saved = state_file(reel_env).read_text()
    assert json.loads(saved)["subs"] == {}
    assert "tok-a" not in saved and "tok-b" not in saved


async def test_unsubscribe_unknown_endpoint_is_ok_without_a_save(push_api, reel_env):
    async with push_api() as api:
        r = await api.post("/api/push/unsubscribe", json={"endpoint": f"{PUSH}/nobody"})
        r2 = await api.post("/api/push/unsubscribe", content=b"garbage")
    assert r.json() == {"ok": True} and r2.json() == {"ok": True}
    assert not state_file(reel_env).exists()


# ---------------------------------------------------------------- test notification


def verify_vapid(auth: str, public_b64: str) -> dict:
    """Check `vapid t=<jwt>, k=<key>` (RFC 8292) with `cryptography`; return the claims."""
    assert auth.startswith("vapid ")
    parts = dict(p.strip().split("=", 1) for p in auth[len("vapid "):].split(","))
    assert parts["k"] == public_b64
    head_b64, claims_b64, sig_b64 = parts["t"].split(".")
    assert json.loads(unb64u(head_b64)) == {"typ": "JWT", "alg": "ES256"}
    sig = unb64u(sig_b64)
    assert len(sig) == 64
    der = encode_dss_signature(int.from_bytes(sig[:32], "big"), int.from_bytes(sig[32:], "big"))
    pub = ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), unb64u(public_b64))
    try:
        pub.verify(der, f"{head_b64}.{claims_b64}".encode(), ec.ECDSA(hashes.SHA256()))
    except InvalidSignature:  # pragma: no cover - the assertion message is the point
        pytest.fail("VAPID JWT signature does not verify against the advertised key")
    return json.loads(unb64u(claims_b64))


async def test_test_notification_is_a_real_encrypted_vapid_push(push_api, jf_me, requests_mock, vapid, reel_env):
    b = Browser()
    requests_mock.post(b.endpoint, status=201)
    async with push_api() as api:
        await api.post("/api/push/subscribe", json=sub_body(b))
        r = await api.post("/api/push/test", json={"endpoint": b.endpoint})
    assert r.status_code == 200 and r.json() == {"ok": True}
    assert len(requests_mock.calls) == 1
    req = requests_mock.calls[0].request
    assert req.method == "POST" and req.url == b.endpoint
    assert req.headers["TTL"] == "600"
    assert req.headers["Content-Encoding"] == "aes128gcm"
    payload = b.decrypt(req.body)
    assert payload["title"] == "VibeReel" and payload["tag"] == "test"
    assert payload["open"] == {"type": "home"}
    claims = verify_vapid(req.headers["Authorization"], vapid[1])
    assert claims["aud"] == PUSH and claims["sub"] == SUBJECT
    assert time.time() < claims["exp"] <= time.time() + 24 * 3600
    # success is stamped and persisted
    saved = json.loads(state_file(reel_env).read_text())["subs"][b.endpoint]
    assert saved["last_ok"] == pytest.approx(time.time(), abs=60)


async def test_test_unknown_endpoint_is_404(push_api, requests_mock):
    async with push_api() as api:
        r = await api.post("/api/push/test", json={"endpoint": f"{PUSH}/nobody"})
    assert r.status_code == 404 and r.json()["error"] == "not_found"
    assert not requests_mock.calls


@pytest.mark.parametrize("code", [404, 410])
async def test_gone_subscription_is_dropped(push_api, jf_me, requests_mock, reel_env, code):
    b = Browser()
    requests_mock.post(b.endpoint, status=code, body="gone")
    async with push_api() as api:
        await api.post("/api/push/subscribe", json=sub_body(b))
        r = await api.post("/api/push/test", json={"endpoint": b.endpoint})
        assert r.status_code == 502
        assert r.json() == {"error": "push_failed", "detail": f"push service answered {code}"}
        assert (await api.post("/api/push/status", json={"endpoint": b.endpoint})).json()["subscribed"] is False
    assert json.loads(state_file(reel_env).read_text())["subs"] == {}


@pytest.mark.parametrize("code", [400, 403, 413, 429, 500, 503])
async def test_other_push_errors_are_502_and_keep_the_subscription(push_api, jf_me, requests_mock, code, caplog):
    b = Browser()
    requests_mock.post(b.endpoint, status=code, body="nope")
    async with push_api() as api:
        await api.post("/api/push/subscribe", json=sub_body(b))
        r = await api.post("/api/push/test", json={"endpoint": b.endpoint})
        assert r.status_code == 502
        assert r.json()["detail"] == f"push service answered {code}"
        st = (await api.post("/api/push/status", json={"endpoint": b.endpoint})).json()
    assert st["subscribed"] is True
    assert push._push.state["subs"][b.endpoint]["last_ok"] is None
    assert f"push.test answered {code}: nope" in caplog.text


async def test_unreachable_push_service_is_502_code_0(push_api, jf_me, requests_mock, caplog):
    import requests

    b = Browser()
    requests_mock.post(b.endpoint, body=requests.ConnectionError("no route"))
    async with push_api() as api:
        await api.post("/api/push/subscribe", json=sub_body(b))
        r = await api.post("/api/push/test", json={"endpoint": b.endpoint})
    assert r.status_code == 502 and r.json()["detail"] == "push service answered 0"
    assert "send failed" in caplog.text
    assert b.endpoint in push._push.state["subs"]


async def test_send_with_202_counts_as_delivered(push_api, jf_me, requests_mock):
    b = Browser()
    requests_mock.post(b.endpoint, status=202)
    async with push_api() as api:
        await api.post("/api/push/subscribe", json=sub_body(b))
        r = await api.post("/api/push/test", json={"endpoint": b.endpoint})
    assert r.status_code == 200
    assert push._push.state["subs"][b.endpoint]["last_ok"] is not None
