"""Tests for leaders_tweets.

Every test runs against a fixture dataset written to a temporary cache
directory; the network is stubbed out so nothing here touches GitHub.
"""

from __future__ import annotations

import json

import pandas as pd
import pytest

import leaders_tweets as lt
from leaders_tweets import core


LEADERS = pd.DataFrame([
    dict(leader_id="modi", name="Narendra Modi", handle="narendramodi",
         country="India", country_iso3="IND", office="Prime Minister",
         n_tweets=3, source_id_reliable=False, has_sentiment=True),
    dict(leader_id="trudeau", name="Justin Trudeau", handle="JustinTrudeau",
         country="Canada", country_iso3="CAN", office="Prime Minister",
         n_tweets=1, source_id_reliable=True, has_sentiment=True),
    dict(leader_id="may", name="Theresa May", handle="theresa_may",
         country="United Kingdom", country_iso3="GBR", office="Prime Minister",
         n_tweets=0, source_id_reliable=False, has_sentiment=False),
])

TWEETS = pd.DataFrame([
    dict(tweet_uid="a1", leader_id="modi", country="India",
         created_at=pd.Timestamp("2022-03-01T10:00:00Z"), text="one",
         engagement=10),
    dict(tweet_uid="a2", leader_id="modi", country="India",
         created_at=pd.Timestamp("2022-06-15T10:00:00Z"), text="two",
         engagement=20),
    dict(tweet_uid="a3", leader_id="modi", country="India",
         created_at=pd.Timestamp("2023-01-02T10:00:00Z"), text="three",
         engagement=30),
    dict(tweet_uid="b1", leader_id="trudeau", country="Canada",
         created_at=pd.Timestamp("2022-06-15T12:00:00Z"), text="four",
         engagement=40),
])
TWEETS["date"] = TWEETS["created_at"].dt.date

SENTIMENT = pd.DataFrame([
    dict(tweet_uid="a1", leader_id="modi", sentiment="POS",
         prob_neg=0.01, prob_neu=0.09, prob_pos=0.90),
    dict(tweet_uid="b1", leader_id="trudeau", sentiment="NEG",
         prob_neg=0.80, prob_neu=0.15, prob_pos=0.05),
])


@pytest.fixture(autouse=True)
def fixture_dataset(tmp_path, monkeypatch):
    """Point the package at a temp cache pre-filled with fixture tables.

    The download helper is replaced with one that fails loudly, so any test
    that unexpectedly reaches for the network will surface it.
    """
    monkeypatch.setenv("LEADERS_TWEETS_CACHE", str(tmp_path))
    core._MEMO.clear()

    version = "v9.9.9"
    (tmp_path / version).mkdir(parents=True, exist_ok=True)
    LEADERS.to_parquet(tmp_path / version / "leaders.parquet", index=False)
    TWEETS.to_parquet(tmp_path / version / "tweets.parquet", index=False)
    SENTIMENT.to_parquet(tmp_path / version / "sentiment.parquet", index=False)

    manifest = {
        "dataset": "Executive Social Media Database",
        "version": version,
        "tables": {
            name: {"parquet": f"https://example.invalid/{name}.parquet", "rows": 0}
            for name in ("leaders", "tweets", "sentiment")
        },
    }
    (tmp_path / "manifest.json").write_text(json.dumps(manifest))

    def _no_network(url, dest):
        raise AssertionError(f"unexpected network fetch: {url}")

    monkeypatch.setattr(core, "_download", _no_network)
    monkeypatch.setattr(core, "MANIFEST_TTL_SECONDS", 10**9)
    yield
    core._MEMO.clear()


def test_data_version_reads_the_manifest():
    assert lt.data_version() == "v9.9.9"


def test_load_leaders_returns_every_leader():
    leaders = lt.load_leaders()
    assert len(leaders) == 3
    assert set(leaders["leader_id"]) == {"modi", "trudeau", "may"}


def test_load_leaders_returns_a_copy():
    first = lt.load_leaders()
    first.loc[:, "name"] = "mutated"
    assert "Narendra Modi" in set(lt.load_leaders()["name"])


def test_get_tweets_unfiltered_returns_everything():
    assert len(lt.get_tweets()) == 4


def test_get_tweets_filters_by_leader_id():
    assert set(lt.get_tweets("modi")["tweet_uid"]) == {"a1", "a2", "a3"}


@pytest.mark.parametrize("alias", ["modi", "MODI", "Narendra Modi", "narendramodi"])
def test_leader_accepts_id_name_and_handle(alias):
    assert len(lt.get_tweets(alias)) == 3


def test_get_tweets_end_bound_is_inclusive_of_the_whole_day():
    # a2 is at 10:00 on 2022-06-15; an end of that date must include it.
    got = lt.get_tweets("modi", start="2022-06-15", end="2022-06-15")
    assert list(got["tweet_uid"]) == ["a2"]


def test_get_tweets_date_range_filters_both_ends():
    got = lt.get_tweets("modi", start="2022-01-01", end="2022-12-31")
    assert set(got["tweet_uid"]) == {"a1", "a2"}


def test_get_tweets_open_ended_start():
    assert set(lt.get_tweets(start="2023-01-01")["tweet_uid"]) == {"a3"}


def test_unknown_leader_raises_with_a_helpful_message():
    with pytest.raises(ValueError, match="unknown leader"):
        lt.get_tweets("Winston Churchill")


def test_ambiguous_leader_raises():
    # "prime" is not a name fragment; use one that hits two fixtures instead.
    with pytest.raises(ValueError):
        core._resolve_leader("a")  # matches Narendra, Justin and Theresa


def test_get_sentiment_joins_tweet_timestamps():
    got = lt.get_sentiment("modi")
    assert list(got["tweet_uid"]) == ["a1"]
    assert "created_at" in got.columns


def test_get_sentiment_respects_the_date_range():
    assert len(lt.get_sentiment(start="2023-01-01")) == 0


def test_manifest_falls_back_to_cache_when_offline(monkeypatch):
    monkeypatch.setattr(core, "MANIFEST_TTL_SECONDS", -1)  # force a refresh

    def _offline(url, dest):
        raise ConnectionError("no network")

    monkeypatch.setattr(core, "_download", _offline)
    assert lt.data_version() == "v9.9.9"
