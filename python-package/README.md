# leaders_tweets

Python access to the [Executive Social Media Database](https://github.com/juangomezcruces/Executive-Social-Media-Database):
498,605 tweets and their engagement metrics from 62 heads of government and
state across 34 countries, 2009–2023.

## Install

```bash
pip install "git+https://github.com/juangomezcruces/Executive-Social-Media-Database.git#subdirectory=python-package"
```

## You need an API key

This package downloads whole tables, which needs a key. Keys are **free for
research use** — open an issue on the repository or email
<juansalvadorgc@gmail.com>. (The website's 100-row browsing needs no key; this
package is the other tier.)

```python
import leaders_tweets as lt
lt.set_api_key("esmd_...", persist=True)   # saved on this machine, once
```

or set `LEADERS_TWEETS_KEY` in your environment. Without one you get a message
saying exactly that and how to fix it, not a stack trace.

## Use

```python
import leaders_tweets as lt

lt.data_version()          # 'v2.0.0' -- the release the cached data came from
lt.load_leaders()          # 62 rows, one per executive
lt.get_tweets("Modi", start="2022-01-01", end="2022-12-31")
lt.get_sentiment("Trudeau")
```

`leader` accepts a `leader_id`, a full name, an X handle or a unique surname,
case-insensitively and ignoring accents. `start` and `end` are `YYYY-MM-DD` and
both inclusive.

## How the data gets here

Nothing is bundled with the package. On first call it reads the manifest from
the project's API — that part needs no key — then downloads the Parquet tables
and caches them under the release version in your platform cache directory
(`platformdirs`). The manifest carries a SHA-256 per file, which is checked
before anything is cached, so a truncated download is caught at the point of
download rather than three lines into your analysis. Later calls read the
cache; when a new release is published the manifest changes and the new tables
are fetched automatically, with no version pinned in this package.

Point the cache somewhere else with `LEADERS_TWEETS_CACHE`, inspect it with
`lt.cache_dir()`, and empty it with `lt.clear_cache()` — which leaves a saved
key alone, because a key is a credential, not a cache.

## A note on tweet ids

`source_tweet_id` is the raw id from collection and is **not** unique in 12 of
the 52 source files. Use `tweet_uid` as the key, and check `source_id_reliable`
before rehydrating against the X API. See
[`schema.md`](https://github.com/juangomezcruces/Executive-Social-Media-Database/blob/main/schema.md).

## Tests

```bash
pip install -e ".[test]"
pytest
```

The suite runs entirely against fixtures with the network stubbed out.
