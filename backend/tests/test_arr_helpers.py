"""arr.py's pure helpers: rating pick, timestamps, the title/query normaliser."""

from datetime import datetime, timezone

import pytest

from reel_api.arr import _iso, _norm, _rating, _when


@pytest.mark.parametrize("ratings, want", [
    ({"votes": 10, "value": 8.66}, 8.7),  # Sonarr
    ({"imdb": {"value": 7.04}, "tmdb": {"value": 6.0}}, 7.0),  # Radarr: IMDb first
    ({"imdb": {"value": 0}, "tmdb": {"value": 6.55}}, 6.5),  # 6.55 is 6.5499... as a float; 0 is skipped
    ({"tmdb": {"value": "7.25"}}, 7.2),
    ({}, None),
    (None, None),
    ({"value": 0, "imdb": None}, None),
])
def test_rating_pick_order(ratings, want):
    assert _rating({"ratings": ratings}) == want


@pytest.mark.parametrize("s, want", [
    ("2026-09-04T04:00:00Z", datetime(2026, 9, 4, 4, tzinfo=timezone.utc)),
    ("2026-09-04T04:00:00+00:00", datetime(2026, 9, 4, 4, tzinfo=timezone.utc)),
    ("", None),
    (None, None),
    ("not a date", None),
])
def test_when_parses_arr_timestamps(s, want):
    assert _when(s) == want


def test_iso_round_trips():
    d = datetime(2026, 1, 2, 3, 4, 5, tzinfo=timezone.utc)
    assert _iso(d) == "2026-01-02T03:04:05Z" and _when(_iso(d)) == d
    assert _iso(None) is None


@pytest.mark.parametrize("s, want", [
    ("The Office (US)", "office"),
    ("Dune (2021)", "dune"),
    ("Amélie", "amelie"),
    ("Grey’s Anatomy", "greys anatomy"),
    ("Law & Order: SVU", "law and order svu"),
    ("A Quiet Place", "quiet place"),
    ("An Officer and a Gentleman", "officer and a gentleman"),
    ("Theodore", "theodore"),  # "the" only as a whole leading word
    ("  BREAKING   bad!! ", "breaking bad"),
    ("", ""),
    (None, ""),
])
def test_norm(s, want):
    assert _norm(s) == want
