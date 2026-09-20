# leaders_tweets

Python access to the [Executive Social Media Database](https://github.com/juangomezcruces/Executive-Social-Media-Database):
327,900 tweets and their engagement metrics from 38 heads of government and
state across 22 countries, 2010–2023.

## Install

```bash
pip install "git+https://github.com/juangomezcruces/Executive-Social-Media-Database.git#subdirectory=python-package"
```

## Use

```python
import leaders_tweets as lt

lt.data_version()          # 'v1.0.0' -- the release the cached data came from
lt.load_leaders()          # 38 rows, one per executive
lt.get_tweets("Modi", start="2022-01-01", end="2022-12-31")
lt.get_sentiment("Trudeau")
```

`leader` accepts a `leader_id`, a full name, an X handle or a unique surname,
case-insensitively. `start` and `end` are `YYYY-MM-DD` and both inclusive.

## How the data gets here

Nothing is bundled with the package. On first call it reads `manifest.json`
from the repository's **latest** GitHub release, downloads the Parquet tables
that manifest names, and caches them under the release version in your platform
cache directory (`platformdirs`). Later calls read the cache. When a new data
release is tagged, the manifest changes and the new tables are fetched
automatically — no version is pinned in this package.

Point the cache somewhere else with `LEADERS_TWEETS_CACHE`, inspect it with
`lt.cache_dir()`, and empty it with `lt.clear_cache()`.

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
