"""Core access functions for the Executive Social Media Database.

The dataset is not bundled with this package. On first use the package reads a
small manifest from the repository's latest GitHub release, then downloads the
Parquet tables it names and caches them on disk under the release version. A
new data release is picked up automatically; nothing here pins a tag.

    >>> import leaders_tweets as lt
    >>> lt.data_version()
    'v1.0.0'
    >>> lt.get_tweets("Modi", start="2022-01-01", end="2022-12-31").shape
    (..., 19)
"""

from __future__ import annotations

import json
import os
import time
import unicodedata
from pathlib import Path
from typing import Optional

import pandas as pd
import requests
from platformdirs import user_cache_dir

__all__ = [
    "load_leaders",
    "get_tweets",
    "get_sentiment",
    "data_version",
    "cache_dir",
    "clear_cache",
]

REPO = "juangomezcruces/Executive-Social-Media-Database"
MANIFEST_URL = f"https://github.com/{REPO}/releases/latest/download/manifest.json"

#: how long a cached manifest is trusted before we re-check for a new release
MANIFEST_TTL_SECONDS = 24 * 60 * 60

_MEMO: dict[str, pd.DataFrame] = {}


# --------------------------------------------------------------------------
# cache plumbing
# --------------------------------------------------------------------------

def cache_dir() -> Path:
    """Return the directory used to cache downloaded tables.

    Override with the ``LEADERS_TWEETS_CACHE`` environment variable.
    """
    override = os.environ.get("LEADERS_TWEETS_CACHE")
    path = Path(override) if override else Path(user_cache_dir("leaders_tweets", "esmd"))
    path.mkdir(parents=True, exist_ok=True)
    return path


def clear_cache() -> None:
    """Delete every cached manifest and table."""
    import shutil

    _MEMO.clear()
    shutil.rmtree(cache_dir(), ignore_errors=True)


def _download(url: str, dest: Path) -> Path:
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(dest.suffix + ".part")
    with requests.get(url, stream=True, timeout=120) as response:
        response.raise_for_status()
        with tmp.open("wb") as fh:
            for chunk in response.iter_content(chunk_size=1 << 20):
                fh.write(chunk)
    tmp.replace(dest)
    return dest


def _manifest(refresh: bool = False) -> dict:
    path = cache_dir() / "manifest.json"
    fresh = (
        path.exists()
        and not refresh
        and (time.time() - path.stat().st_mtime) < MANIFEST_TTL_SECONDS
    )
    if not fresh:
        try:
            _download(MANIFEST_URL, path)
        except Exception:
            if not path.exists():
                raise
            # Offline with a cached copy: keep using it rather than failing.
    return json.loads(path.read_text())


def _table(name: str) -> pd.DataFrame:
    if name in _MEMO:
        return _MEMO[name]
    manifest = _manifest()
    version = manifest["version"]
    entry = manifest["tables"][name]
    local = cache_dir() / version / f"{name}.parquet"
    if not local.exists():
        _download(entry["parquet"], local)
    frame = pd.read_parquet(local)
    _MEMO[name] = frame
    return frame


# --------------------------------------------------------------------------
# public API
# --------------------------------------------------------------------------

def data_version() -> str:
    """Return the release tag the cached data came from, e.g. ``'v1.0.0'``."""
    return _manifest()["version"]


def load_leaders() -> pd.DataFrame:
    """Return one row per executive in the dataset.

    Columns include ``leader_id``, ``name``, ``handle``, ``country``,
    ``country_iso3``, ``office``, ``n_tweets``, ``first_tweet``, ``last_tweet``
    and engagement totals. ``leader_id`` is the join key used by
    :func:`get_tweets` and :func:`get_sentiment`.
    """
    return _table("leaders").copy()


def _fold(value: object) -> str:
    """Lowercase and strip accents, so 'chavez' matches 'Hugo Chávez'.

    Many leaders in the dataset have accented names. Requiring the exact
    accents would make the obvious call fail, so both sides of every
    comparison are folded. The R package folds identically.
    """
    decomposed = unicodedata.normalize("NFKD", str(value))
    stripped = "".join(c for c in decomposed if not unicodedata.combining(c))
    return stripped.strip().lower()


def _resolve_leader(leader: str) -> str:
    """Map a leader_id, full name or handle to a leader_id.

    Matching ignores case and accents and also accepts a unique surname
    fragment, so ``"modi"``, ``"Narendra Modi"`` and ``"narendramodi"`` all
    resolve, as do ``"chavez"`` and ``"Chávez"``.
    """
    leaders = _table("leaders")
    needle = _fold(leader)

    for column in ("leader_id", "handle", "name"):
        folded = leaders[column].map(_fold, na_action="ignore")
        hit = leaders[folded == needle]
        if len(hit) == 1:
            return hit.iloc[0]["leader_id"]

    partial = leaders[
        leaders["name"].map(_fold, na_action="ignore").str.contains(
            needle, regex=False, na=False
        )
    ]
    if len(partial) == 1:
        return partial.iloc[0]["leader_id"]
    if len(partial) > 1:
        names = ", ".join(sorted(partial["name"]))
        raise ValueError(f"{leader!r} is ambiguous; it matches: {names}")

    raise ValueError(
        f"unknown leader {leader!r}. Call load_leaders() to see the "
        f"{len(leaders)} available leaders."
    )


def _filter(
    frame: pd.DataFrame,
    leader: Optional[str],
    start: Optional[str],
    end: Optional[str],
) -> pd.DataFrame:
    if leader is not None:
        frame = frame[frame["leader_id"] == _resolve_leader(leader)]
    if start is not None:
        frame = frame[frame["created_at"] >= pd.Timestamp(start, tz="UTC")]
    if end is not None:
        # `end` is inclusive of the whole calendar day.
        stop = pd.Timestamp(end, tz="UTC") + pd.Timedelta(days=1)
        frame = frame[frame["created_at"] < stop]
    return frame.reset_index(drop=True)


def get_tweets(
    leader: Optional[str] = None,
    start: Optional[str] = None,
    end: Optional[str] = None,
) -> pd.DataFrame:
    """Return tweets, optionally filtered by leader and date range.

    Parameters
    ----------
    leader:
        A ``leader_id``, full name, handle or unique surname. ``None`` returns
        every leader.
    start, end:
        ``YYYY-MM-DD`` bounds on ``created_at``, both inclusive. ``None``
        leaves that end of the range open.

    Returns
    -------
    pandas.DataFrame
        One row per tweet, keyed on ``tweet_uid``.
    """
    return _filter(_table("tweets").copy(), leader, start, end)


def get_sentiment(
    leader: Optional[str] = None,
    start: Optional[str] = None,
    end: Optional[str] = None,
) -> pd.DataFrame:
    """Return sentiment-classified tweets for the 11 leaders that have them.

    The sentiment table itself carries no timestamp, so it is joined to
    ``tweets`` on ``tweet_uid`` before the date filter is applied. Accepts the
    same arguments as :func:`get_tweets`.
    """
    sentiment = _table("sentiment")
    tweets = _table("tweets")[["tweet_uid", "created_at", "date", "text", "engagement"]]
    merged = sentiment.merge(tweets, on="tweet_uid", how="inner")
    return _filter(merged, leader, start, end)
