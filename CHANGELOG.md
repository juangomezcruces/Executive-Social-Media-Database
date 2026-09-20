# Changelog

Every data release gets an entry here. The web app and both packages read the
`manifest.json` attached to the **latest** release, so publishing a new tagged
release is what propagates a change — no downstream version bump is needed.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [v1.0.0] — 2026-09-20

First public release.

### Added

- **`leaders`** — 38 rows, one per head of government or state, across 22
  countries: `leader_id`, name, X handle, country, ISO3, office, per-leader
  tweet counts, engagement totals and date range.
- **`tweets`** — 327,900 rows. Text, language, UTC timestamp and retweet /
  reply / like / quote counts, plus a derived `engagement` total. Spans
  2010-01-04 to 2023-06-20.
- **`sentiment`** — 142,623 rows. `pysentimiento` POS/NEU/NEG label and the
  three class probabilities, covering 11 of the 38 leaders.
- Python package `leaders_tweets` and R package `leaderstweets`, with matching
  function names and arguments.
- Static web app on GitHub Pages: filters, two charts, paginated results and an
  in-browser SQL console over DuckDB-Wasm.

### Data quality notes

- **`source_tweet_id` is not unique in 12 of the 52 source collection files.**
  The worst case, `tweetsModi.csv`, has 3,921 distinct ids across 56,941
  distinct tweets. Rows are therefore keyed on `tweet_uid`, a BLAKE2b-64 digest
  of `leader_id | created_at | text`, and `source_id_reliable` flags the
  affected leaders. Do not rehydrate from `source_tweet_id` where that flag is
  false.
- **362 duplicate rows removed** (0.09% of 407,427 raw rows), deduplicated on
  `(leader_id, created_at, text)` rather than on id.
- **Coverage is uneven.** The 21 leaders from the 2023 collection run begin at
  2018-01-01; the 17 from the 2022 run reach back to 2010 but end 2023-06-07.
  Fourteen leaders appear in both runs and are merged. Use
  `leaders.first_tweet` / `leaders.last_tweet` rather than assuming a common
  window.
- **Engagement counts are as of collection time**, not live, so older tweets
  have had far longer to accumulate.
- Sentiment covers only 11 leaders; `leaders.has_sentiment` marks which.

### Known gaps

- No approval-rating series in this release. The Morning Consult approval data
  in the source material is a commercial product and is not redistributed here.
- No pre-aggregated daily or weekly tables; aggregate from `tweets` (the web app
  does this in DuckDB at query time).
- `tweet_type` and `in_reply_to_user_id` are frequently null — the collector did
  not populate them consistently.

[v1.0.0]: https://github.com/juangomezcruces/Executive-Social-Media-Database/releases/tag/v1.0.0
