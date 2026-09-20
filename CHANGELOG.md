# Changelog

Every data release gets an entry here. The web app and both packages read the
`manifest.json` attached to the **latest** release, so publishing a new tagged
release is what propagates a change — no downstream version bump is needed.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [v1.2.0] — 2026-09-21

Adds an `is_reply` flag to `tweets`, after finding that a single day of
automated replies was distorting the headline figures. No row was added,
removed or otherwise changed.

### Added

- **`tweets.is_reply`** — true for conversational replies, false for broadcast
  tweets. **92,735 rows (21.1%)** are replies, and they behave nothing like
  ordinary posts: median engagement **3**, against **303** for everything else.
  Compare posting volume with `WHERE NOT is_reply`.
  The flag is the union of three signals, because none is complete on its own:
  `in_reply_to_user_id` is set, `tweet_type = 'replied_to'`, or the text begins
  with `@`. Metadata alone would miss 134 rows; the `@` test alone would miss
  27,466 replies that open differently (`.@someone Thank you...`).
- **Web app**: leaders and countries are now multi-select with search and
  select-all/clear; every result column sorts, ascending and descending, with
  `aria-sort` for screen readers; an "Exclude replies" toggle; a reply tag in
  the results table; and a replies count in the summary tiles.
- `export_data.py` now refuses to publish a half-populated `is_reply`, and
  recomputes derived columns when `--base-tweets` reuses an export that predates
  them — otherwise the reused batch would have silently carried the column
  through as all-null, which is exactly what happened on the first run.

### The Modi anomaly this came from

On **16 March 2019** Modi's account has **38,090 tweets in 9.7 hours** — 65 a
minute. Every one begins with `@`, 92% mention "Chowkidar", and their median
engagement is 1 with 40% at zero. They are automated personalised replies from
the [#MainBhiChowkidar campaign](https://en.wikipedia.org/wiki/Main_Bhi_Chowkidar),
launched two days before. They are genuine, distinct tweets — not duplicates —
but they are not comparable to anything else in the dataset.

That one day is **67% of Modi's record** and **8.7% of the whole dataset**.
With it, Modi is the most prolific leader here and his mean engagement reads
8,486. Excluding replies he is third, at 26,307 — a threefold difference from a
single afternoon. The next-largest single day for any leader in the dataset is
Lula with 263.

Nothing was removed: the rows are real and are still published. The flag simply
makes them separable. Other reply-heavy accounts: Solberg 66%, Correa 59%,
Ardern 57%.

### Fixed

- The web app's headline sentence was hardcoded and still read "327,900 tweets
  from 38 heads of government across 22 countries" after v1.1.0. It is now
  derived from the data, so it cannot go stale again.

## [v1.1.0] — 2026-09-21

Adds 22 Latin American presidents. The dataset goes from 38 leaders in 22
countries to **60 leaders in 34 countries**, and from 327,900 to **440,004
tweets**. No existing row changed.

### Added

- **22 presidents**, 112,104 tweets, from a separate collection
  (`entiredatasetCH1.csv`) covering 2010–2023: Bachelet, Calderón, Cartes,
  Chávez, Chinchilla, Correa, Cristina Fernández de Kirchner, Kuczynski, Lobo,
  Macri, Maduro, Evo Morales, Jimmy Morales, Moreno, Peña Nieto, Pérez Molina,
  Piñera, Rousseff, Santos, Solís, Temer and Varela.
- **12 new countries**: Argentina, Bolivia, Chile, Colombia, Costa Rica,
  Ecuador, Guatemala, Honduras, Panama, Paraguay, Peru, Venezuela.
- **`leaders.populist`** — the `type_of_leader` coding carried in that source
  file. It is the dataset author's own research classification, not an external
  standard, and is null for the 38 leaders outside that batch.
- `scripts/leaders_latam.py`, the registry for the new batch, and
  `--base-tweets` / `--base-sentiment` options on `export_data.py` for
  re-exporting one batch when the other batch's raw files aren't to hand.

### Fixed

- **Leader lookup broke on accented names in the R package.** Under a C locale
  `tolower()` and `grepl()` could not handle a multi-byte name, and
  `get_tweets("Chávez")` returned the *entire* table instead of erroring. Both
  packages now fold case and accents at the codepoint level, so `"chavez"`,
  `"Chavez"` and `"Chávez"` are equivalent in either language, and a filtered
  query that cannot resolve its leader now errors instead of silently returning
  everything. This bug could have silently corrupted any R analysis that
  filtered on an accented name — which is every new leader in this release.
- Parquet row groups are now set in `export_data.py` (25,000 rows) rather than
  applied by hand, so browser range-request pruning survives a re-export.

### Data quality notes

- **Three date formats** appeared in the new source file and are parsed
  explicitly: ISO-8601 with a time, bare `YYYY-MM-DD` (Bolsonaro's rows), and
  R's numeric date serial (Macri's rows, days since 1970-01-01). Macri's 2,476
  tweets therefore carry **date-only precision** — midnight UTC, not a real
  time of day. The exporter refuses to write a row whose timestamp it cannot
  parse.
- **Bolsonaro and López Obrador appear in the new source file but were not
  imported.** Both are already present from the original collection with wider
  coverage and full timestamps (Bolsonaro 2010–2023 there versus 2019–2023
  here). 6,666 of the new file's 9,417 Bolsonaro texts and 2,454 of its 2,668
  AMLO texts were already in the dataset; importing them would have added
  roughly 9,100 duplicates, because the date-only timestamps do not deduplicate
  against the existing full ones.
- **`id` is not a key in this batch either**: 95,966 distinct ids across
  124,179 distinct tweets. Same treatment as before — `tweet_uid` is the key and
  `source_id_reliable` is false for Calderón, Evo Morales, Moreno, Pérez Molina,
  Piñera and Varela.
- **11 duplicate rows** removed from 112,115, deduplicated on
  `(leader_id, created_at, text)`.
- **Quote counts are sparse for older tweets** — 0% for Chinchilla, 2–3% for
  Lobo, Pérez Molina and Calderón — because quote tweets did not exist as a
  counted metric for most of their terms. Treat a zero quote count before
  roughly 2015 as "not measured", not "not quoted".
- **`handle` is null for Jimmy Morales.** It could not be confirmed against a
  live account, and his account has since been reported compromised, so it was
  left empty rather than guessed. Every other handle was taken from the
  collection's own timeline files or verified against the account.

### Not included

- Donald Trump. The available files carry retweets and favourites but **no
  reply or quote counts at all**, so his engagement would not be comparable
  with any other leader in the dataset. Pending a decision on how to represent
  partial-metric leaders.
- Iván Duque, Alberto Fernández and Juan Guaidó, who appear only in the
  timeline files in this collection and have the same missing-metric problem.

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

[v1.2.0]: https://github.com/juangomezcruces/Executive-Social-Media-Database/releases/tag/v1.2.0
[v1.1.0]: https://github.com/juangomezcruces/Executive-Social-Media-Database/releases/tag/v1.1.0
[v1.0.0]: https://github.com/juangomezcruces/Executive-Social-Media-Database/releases/tag/v1.0.0
