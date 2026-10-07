"""Push for new seasons (push.py news_tick): the bell's /api/news "aired"
items, diffed pass to pass; the first pass is a baseline.

Note: only `aired` items notify (module docstring: "the bell's /api/news
"aired" items"); an `upcoming` season notifies once, when it turns aired —
its id carries the kind, so that is a new id.
"""

from __future__ import annotations

from datetime import timedelta

import pytest

from reel_api import push
from reel_api.arr import ArrError
from tests.support.arr import episode_obj, season_obj, series_obj
from tests.test_push_watcher import NOW, Phone, frozen, jf, make_push  # noqa: F401 (fixtures)


def ago(**kw):
    return NOW - timedelta(**kw)


def ahead(**kw):
    return NOW + timedelta(**kw)


def show(sonarr, tvdb, title, seasons: dict):
    """seasons: {n: [air datetime | (air, has_file), ...]}"""
    eps = []
    for n, airs in seasons.items():
        for i, a in enumerate(airs, 1):
            a, has = a if isinstance(a, tuple) else (a, False)
            eps.append(episode_obj(n, i, air=a, has_file=has))
    return sonarr.add_series(series_obj(tvdb, title, seasons=[season_obj(n) for n in seasons]), eps)


def season_pushes(phone):
    return [(p, ttl) for p, ttl in phone.received() if p["tag"].startswith("news:")]


@pytest.fixture
def setup(make_push, sonarr, jf, requests_mock):
    p = make_push()
    anna, ben = jf.add_user("anna", "tok-a"), jf.add_user("ben", "tok-b")
    phones = {
        "anna1": Phone(p, anna, 1, requests_mock, seasons=True),
        "anna2": Phone(p, anna, 2, requests_mock, seasons=True, ready=False),
        "ben": Phone(p, ben, 3, requests_mock, seasons=False),
    }
    show(sonarr, 100, "Old Show", {1: [(ago(days=400), True)], 2: [ago(days=20)]})  # aired before start
    return p, phones


async def test_first_pass_is_a_baseline(setup, sonarr):
    p, phones = setup
    await p.news_tick()
    assert p.state["news"] == ["100:2:aired"]
    assert all(season_pushes(ph) == [] for ph in phones.values())
    await p.news_tick()
    assert all(season_pushes(ph) == [] for ph in phones.values())


async def test_a_new_aired_season_notifies_seasons_subscribers_once(setup, sonarr, frozen):
    p, phones = setup
    await p.news_tick()
    show(sonarr, 200, "New Show", {1: [(ago(days=300), True)], 2: [ago(days=1), ahead(days=6)]})
    await p.news_tick()
    for name in ("anna1", "anna2"):  # every device with seasons on, ready on or off
        [(payload, ttl)] = season_pushes(phones[name])
        assert ttl == str(push.TTL_NEWS)
        assert payload == {"title": "New Show", "body": "Season 2 is out — tap to get it",
                           "tag": "news:200:2:aired", "open": {"type": "bell"}}
    assert season_pushes(phones["ben"]) == []
    assert p.state["sent"][phones["anna1"].sub["user_id"]] == ["news:200:2:aired"]
    assert "ben" not in p.state["sent"]
    assert sorted(p.state["news"]) == ["100:2:aired", "200:2:aired"]
    await p.news_tick()
    assert len(season_pushes(phones["anna1"])) == 1


async def test_upcoming_does_not_notify_until_it_airs(setup, sonarr, frozen):
    p, phones = setup
    await p.news_tick()
    show(sonarr, 300, "Soon", {1: [(ago(days=300), True)], 2: [ahead(days=3), ahead(days=10)]})
    await p.news_tick()
    assert season_pushes(phones["anna1"]) == []  # upcoming: in the bell, but no push
    assert "300:2:upcoming" not in p.state["news"]
    frozen.shift(timedelta(days=4))  # the premiere aired: kind upcoming -> aired, a new id
    await p.news_tick()
    [(payload, _)] = season_pushes(phones["anna1"])
    assert payload["tag"] == "news:300:2:aired" and payload["title"] == "Soon"
    frozen.shift(timedelta(days=7))
    await p.news_tick()
    assert len(season_pushes(phones["anna1"])) == 1


async def test_a_season_that_leaves_and_returns_is_not_repeated(setup, sonarr):
    p, phones = setup
    await p.news_tick()
    s = show(sonarr, 400, "Back Again", {1: [(ago(days=300), True)], 2: [ago(days=2)]})
    await p.news_tick()
    assert len(season_pushes(phones["anna1"])) == 1
    ep = sonarr.episode(s["id"], 2, 1)
    ep["hasFile"] = True  # downloaded: out of the feed
    await p.news_tick()
    assert "400:2:aired" not in p.state["news"]
    ep["hasFile"] = False  # file deleted: in the feed again, already announced
    await p.news_tick()
    assert "400:2:aired" in p.state["news"]
    assert len(season_pushes(phones["anna1"])) == 1


async def test_baseline_is_taken_without_subscribers(make_push, sonarr, jf, requests_mock):
    p = make_push()
    show(sonarr, 100, "Old Show", {1: [(ago(days=400), True)], 2: [ago(days=20)]})
    await p.news_tick()  # nobody wants seasons yet
    assert p.state["news"] == ["100:2:aired"]
    late = Phone(p, jf.add_user("anna", "tok-a"), 1, requests_mock, seasons=True)
    await p.news_tick()
    assert season_pushes(late) == []  # no flood of what was already out
    show(sonarr, 500, "Fresh", {1: [ago(days=1)]})
    await p.news_tick()
    assert [x["tag"] for x, _ in season_pushes(late)] == ["news:500:1:aired"]


async def test_title_fallback_and_sonarr_failures(setup, monkeypatch, sonarr):
    p, phones = setup
    await p.news_tick()
    tv = p.arr["tv"]

    async def feed():
        return [{"id": "9:3:aired", "kind": "aired", "title": "", "season": 3},
                {"id": "9:4:upcoming", "kind": "upcoming", "title": "x", "season": 4}]

    monkeypatch.setattr(tv, "season_news", feed)
    await p.news_tick()
    [(payload, _)] = season_pushes(phones["anna1"])
    assert payload["title"] == "New season" and payload["body"] == "Season 3 is out — tap to get it"
    assert p.state["news"] == ["9:3:aired"]

    async def down():
        raise ArrError("tv backend unreachable")

    monkeypatch.setattr(tv, "season_news", down)
    with pytest.raises(ArrError):  # the loop logs it; the diff state is untouched
        await p.news_tick()
    assert p.state["news"] == ["9:3:aired"]


async def test_no_sonarr_no_news(make_push, sonarr):
    p = make_push(SONARR_URL=None, SONARR_API_KEY=None)
    assert "tv" not in p.arr
    await p.news_tick()
    assert p.state["news"] is None
    assert not sonarr.calls
