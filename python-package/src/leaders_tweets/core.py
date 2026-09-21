"""Core access functions for the Executive Social Media Database.

The dataset is not bundled with this package and is no longer a public file.
On first use the package reads a small manifest from the project's API, then
downloads the Parquet tables and caches them on disk under the release version.
A new data release is picked up automatically; nothing here pins a tag.

Downloading a full table needs an API key. Keys are free for research use --
see the repository README -- and identify who is using the data, which is the
whole reason the anonymous web API is capped at 100 rows a request. Set one
with the ``LEADERS_TWEETS_KEY`` environment variable or :func:`set_api_key`.

    >>> import leaders_tweets as lt
    >>> lt.set_api_key("esmd_...", persist=True)   # once per machine
    >>> lt.data_version()
    'v2.0.0'
    >>> lt.get_tweets("Modi", start="2022-01-01", end="2022-12-31").shape
    (..., 19)
"""

from __future__ import annotations

import hashlib
import json
import os
import stat
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
    "api_key",
    "set_api_key",
    "MissingKeyError",
]

REPO = "juangomezcruces/Executive-Social-Media-Database"

#: The deployed Worker. Override for a local API with LEADERS_TWEETS_API.
#: scripts/set_api_url.py rewrites this line, webapp/src/config.js and the R
#: package together, so the three clients cannot drift apart.
API_BASE = "https://esmd-api.REPLACE-ME.workers.dev/v1"

#: how long a cached manifest is trusted before we re-check for a new release
MANIFEST_TTL_SECONDS = 24 * 60 * 60

_MEMO: dict[str, pd.DataFrame] = {}
_SESSION_KEY: Optional[str] = None


class MissingKeyError(RuntimeError):
    """Raised when a full table is requested without an API key."""


def api_base() -> str:
    """Return the API root, without a trailing slash."""
    return os.environ.get("LEADERS_TWEETS_API", API_BASE).rstrip("/")


def _key_file() -> Path:
    return cache_dir() / "api_key"


def api_key() -> Optional[str]:
    """Return the API key in effect, or ``None``.

    Looked up in order: the key set by :func:`set_api_key` in this session, the
    ``LEADERS_TWEETS_KEY`` environment variable, then a key persisted on this
    machine by ``set_api_key(..., persist=True)``.
    """
    if _SESSION_KEY:
        return _SESSION_KEY
    from_env = os.environ.get("LEADERS_TWEETS_KEY")
    if from_env:
        return from_env.strip()
    path = _key_file()
    if path.exists():
        stored = path.read_text().strip()
        if stored:
            return stored
    return None


def set_api_key(key: Optional[str], persist: bool = False) -> None:
    """Set the API key for this session, optionally saving it on this machine.

    ``persist=True`` writes the key to a file in the cache directory, readable
    only by the current user. Pass ``None`` to clear both.
    """
    global _SESSION_KEY
    _SESSION_KEY = key.strip() if key else None
    if persist:
        path = _key_file()
        if _SESSION_KEY:
            path.write_text(_SESSION_KEY + "\n")
            path.chmod(stat.S_IRUSR | stat.S_IWUSR)
        elif path.exists():
            path.unlink()


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
    """Delete every cached manifest and table.

    A persisted API key is left alone: it is a credential, not a cache, and
    silently throwing it away would be a surprising thing for this to do.
    """
    import shutil

    _MEMO.clear()
    root = cache_dir()
    for child in root.iterdir():
        if child == _key_file():
            continue
        if child.is_dir():
            shutil.rmtree(child, ignore_errors=True)
        else:
            child.unlink(missing_ok=True)


def _download(url: str, dest: Path) -> Path:
    """Fetch ``url`` to ``dest``, sending the API key if there is one."""
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(dest.suffix + ".part")
    key = api_key()
    headers = {"Authorization": f"Bearer {key}"} if key else {}
    with requests.get(url, stream=True, timeout=300, headers=headers) as response:
        if response.status_code in (401, 403):
            raise MissingKeyError(_KEY_HELP.format(status=response.status_code))
        response.raise_for_status()
        with tmp.open("wb") as fh:
            for chunk in response.iter_content(chunk_size=1 << 20):
                fh.write(chunk)
    tmp.replace(dest)
    return dest


_KEY_HELP = (
    "the API rejected this request (HTTP {status}).\n\n"
    "Full tables need an API key. They are free for research use -- ask at\n"
    f"    https://github.com/{REPO}#api-keys\n"
    "then either\n"
    "    export LEADERS_TWEETS_KEY=esmd_...\n"
    "or, once per machine,\n"
    "    import leaders_tweets as lt; lt.set_api_key('esmd_...', persist=True)\n"
    "If you already set one, it may have been revoked or mistyped."
)


def _manifest(refresh: bool = False) -> dict:
    path = cache_dir() / "manifest.json"
    fresh = (
        path.exists()
        and not refresh
        and (time.time() - path.stat().st_mtime) < MANIFEST_TTL_SECONDS
    )
    if not fresh:
        try:
            _download(f"{api_base()}/manifest", path)
        except Exception:
            if not path.exists():
                raise
            # Offline with a cached copy: keep using it rather than failing.
    return json.loads(path.read_text())


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _table(name: str) -> pd.DataFrame:
    if name in _MEMO:
        return _MEMO[name]
    manifest = _manifest()
    version = manifest["version"]
    entry = manifest["tables"][name]
    local = cache_dir() / version / f"{name}.parquet"
    if not local.exists():
        if api_key() is None:
            raise MissingKeyError(_KEY_HELP.format(status=401))
        _download(f"{api_base()}/download/{name}.parquet", local)
        # The manifest names the digest, so a truncated or corrupted download
        # is caught here rather than three lines into someone's analysis.
        expected = (entry.get("parquet") or {}).get("sha256")
        if expected and _sha256(local) != expected:
            local.unlink(missing_ok=True)
            raise OSError(
                f"{name}.parquet did not match the digest in the manifest; "
                "the download was discarded. Try again."
            )
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
