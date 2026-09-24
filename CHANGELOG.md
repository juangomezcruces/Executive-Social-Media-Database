# Changelog

Every data release gets an entry here. The web app and both packages read the
manifest the API publishes, so deploying a new release is what propagates a
change — no downstream version bump is needed.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [v2.1.0] — 2026-09-24

Search across languages. No data changed; the release the API serves is still
v2.0.0.

### Added

- **Related-term search.** Tick *Also search related terms* and the search box
  offers three kinds of extra term: other ways of writing it, the concepts
  around it, and the same subject in the languages of the countries you have
  selected. The middle one is the point — `housing` brings *affordable
  housing*, *mortgage*, *rent*, *eviction*, *homelessness*, not a second word
  for *housing*, because a synonym mostly finds the tweets the term already
  found. On this corpus the languages are not a nicety either: 71% of the
  tweets are not in English, so `climate` alone matches 2,103 rows where the
  same concept across languages matches 4,064. In the web app the same query
  went from 1,639 rows to 2,997.
- **`GET /v1/expand`** — suggests the terms. It returns a flat `terms` array,
  which is what `also=` takes, and the same words again under `groups` as
  `synonyms`, `related` and `translations`, which is what the chips are
  labelled from. One Workers AI call, cached in R2 by term and language set, so
  a repeated search costs nothing. About fifty neurons a call against a free
  allowance of 10,000 a day, so ~200 fresh terms daily before the cache starts
  absorbing them. The model is held to a JSON schema, because asked politely
  for JSON it returned prose; the call falls back to an unconstrained one if a
  future model rejects the schema, and the parser copes with prose either way —
  anything that arrives ungrouped is filed under `related`, which is honest
  rather than guessed.
- **`GET /v1/languages`** and `public/languages.json` — which languages each
  country actually tweets in, at or above a 5% share, derived from the corpus
  rather than hardcoded. It gets Canada (en, fr), Belgium (nl, en, fr) and
  Switzerland (fr, de, en, it) right, and stays right as leaders are added.
- **`also=` on `/v1/tweets` and `/v1/count`** — extra terms, OR-ed into the
  full-text query, each matched as a quoted phrase so a term cannot alter the
  shape of the query.

### Fixed

- **`/v1/count` ignored the text search.** It built its WHERE clause from the
  structural filters only and never went through the full-text index, so the
  results header read "10,000+" no matter what you typed — a count of a
  different query from the one on screen. It now takes the same path as the
  rows it is counting.

### Notes

- The expansion is deliberately a separate step the user can see and edit
  rather than something applied silently. `/v1/tweets` remains a deterministic
  function of its parameters, so a cited result stays reproducible: the terms
  are in the URL. Broadening from synonyms to neighbouring concepts costs
  precision, which is exactly why the suggestions are grouped and every group
  can be dropped in one click.
- If Workers AI is unavailable or the daily allowance is spent, `/v1/expand`
  returns the term as typed with `degraded: true` and search continues as an
  ordinary keyword search. Search never depends on the model being up.

## [v2.0.1] — 2026-09-23

Site only. No data changed, and the release the API serves is still v2.0.0.

### Fixed

- **The Pages deploy could never succeed.** The workflow guarded against an
  unconfigured API address by grepping `config.js` for `REPLACE-ME`, but the
  line `API_CONFIGURED = !API_BASE.includes('REPLACE-ME')` contains that string
  permanently, so the guard tripped on a correctly configured file and every
  publish failed at that step. The old DuckDB site therefore stayed live —
  still serving `data/tweets.parquet` on an open URL, which made the API's
  100-row cap decoration. The guard now matches the assignment line only.

### Changed

- **Replies are excluded by default** in the web app. The control is now
  "Include replies", off unless asked. Replies are conversation rather than
  broadcast and have a median engagement of 3 against 303, so they belong
  behind an opt-in rather than in the baseline. The summary and the chart note
  now always state which population is on screen — "broadcast only" or
  "replies included" — instead of leaving it implied.
- **A favicon of the project's own**: a speech bubble with three rising bars,
  drawn for 16px, replacing the generic chart emoji.

### Documented

- **Trump's and Obama's replies are undercounted, by roughly 30%.** Their
  archive carries no reply metadata, so `is_reply` rests on the `@` prefix
  alone for those two; calibrated against the 440,004 rows that do have
  metadata, that rule misses about 30% of real replies. Now stated in
  `schema.md`, the README and under the toggle itself, and `export_data.py`
  prints which source files have the gap so a future batch cannot introduce it
  silently.

## [v2.0.0] — 2026-09-21

**Breaking.** The data is no longer a public file. Until v1.3.0 the Parquet
tables were committed to this repository and the CSVs were attached to every
release, so anyone who found the URL had the whole corpus. From v2.0.0 the
tables sit behind an API: browsing is open and capped at **100 rows a request**,
and whole tables need a key, which is free and issued on request.

No row of data changed. 62 leaders, 498,605 tweets, same schema, same digests.

### What you have to do

- **Using the packages?** Upgrade, then set a key once:
  `lt.set_api_key("esmd_...", persist=True)` / `set_api_key("esmd_...", persist = TRUE)`,
  or `export LEADERS_TWEETS_KEY=...`. Ask for one: see
  [API keys](README.md#api-keys). Without a key you get a message telling you
  exactly that, not a stack trace.
- **Using the website?** Nothing. Browsing, filtering, sorting and the charts
  all work as before, without a key.
- **Using the release assets or a `git clone` for the data?** Those are gone —
  that is the point of the release. Ask for a key.

### Added

- **The API** (`api/`), a Cloudflare Worker: `/v1/leaders`, `/v1/tweets`,
  `/v1/count`, `/v1/summary`, `/v1/volume`, `/v1/engagement`, `/v1/manifest`,
  `/v1/download/{table}.{parquet|csv}` and `POST /v1/sql`. Filters, full-text
  search, sorting and paging as the web app had them, plus a hard row cap and
  bounded offsets.
- **API keys**, stored as SHA-256 hashes only, with every download logged
  against the key. `scripts/keys.py` issues, lists, revokes, exports and
  restores them.
- **`set_api_key()` / `api_key()`** in both packages, reading a key from the
  call, an R option, an environment variable or a file saved on the machine.
- **Digest verification** in both packages: the manifest now carries a SHA-256
  per file and a download that does not match is discarded rather than cached.
- **`api/DEPLOY.md`**, the runbook, and `scripts/set_api_url.py`, which points
  all three clients at the deployed API in one command so they cannot drift
  apart.
- **`scripts/scrub_history.sh`**, which removes the tables from this
  repository's history after backing the whole thing up to a bundle.

### Changed

- **The web app is a thin client.** It no longer ships the dataset. Earlier
  versions loaded the whole Parquet corpus into DuckDB-Wasm in the browser,
  which meant every visitor had already downloaded it before typing anything.
  Filters, multi-select, sorting and both charts work exactly as before.
- **The charts and the summary are computed in the browser** from one
  precomputed 75 KB monthly object, so moving a filter costs the database
  nothing. The cost of that: it has no text column, so a text search or a
  minimum-engagement filter applies to the results table only — and the page
  says so rather than showing a summary that disagrees with the table beneath
  it.
- **The SQL console needs a key** and runs against the live database rather
  than DuckDB in the browser. Tables are `tweets` and `leaders`; `sentiment` is
  a download.
- **`manifest.json` carries no URLs**, only version, row counts and digests per
  format. Each client already knows the API address and builds download URLs
  itself, so a redeployed Worker cannot leave a stale URL inside the data.
- **`data/` is git-ignored**, and the Pages workflow fails the build if a table
  or anything over 2 MB reaches the site.
- **The R package gains `openssl`** as a dependency, for digest verification.

### Removed

- DuckDB-Wasm, and with it the 1.28.0 pin and the reason for it.
- The committed Parquet tables and the release assets.
- `scripts/make_api_key.py`, replaced by `scripts/keys.py`.

### Why Turso and not Cloudflare D1

The rest of the stack is Cloudflare, and D1 would have been one account fewer.
It does not fit: loading this dataset costs about 4.5 million row-writes once
the seven indexes and the full-text index are counted, and D1's free plan
allows 100,000 a day — about 45 days of trickle-loading — with a 500 MB ceiling
that 326 MB of database was already two thirds of. Turso's free plan allows 10
million writes a month and takes the finished SQLite file in one upload. The
Worker, R2 and Pages stay where they were.

## [v1.3.0] — 2026-09-21

Adds **Donald Trump and Barack Obama**, from an archive export that finally
carries all four engagement metrics — the gap that kept Trump out of v1.1.0.
62 leaders, 498,605 tweets. No existing row changed.

### Added

- **Donald Trump** — `@realDonaldTrump`, **58,249 tweets**, 2009-05-04 to
  2021-01-08, ending with his suspension. Mean engagement 38,690; 54,940 of the
  tweets are broadcast rather than replies, making him the most prolific
  broadcaster in the dataset.
- **Barack Obama** — `@POTUS`, **352 tweets**, 2015-05-18 to 2017-01-20. Mean
  engagement 73,136, the highest of any leader here.
- **`tweets.is_deleted`** — true where the archive records a tweet as later
  deleted: 1,354 rows, 1,353 of them Trump's. Null for every leader outside this
  batch, meaning *unknown*, not false, since no other source records deletions.
- `scripts/leaders_us.py`, and a `build_us()` stage in `export_data.py`.

### Judgement calls, and why

- **`ObamaWhiteHouse` was not imported.** The archive contains it — 27,347
  tweets — but it is the institutional White House feed: its first tweet is
  "Welcome to the official Twitter page for the White House!" and it retweets
  federal agencies. Its mean engagement is **713**, against **73,136** for
  `@POTUS`: a hundredfold gap. Folding it into "Obama" would have made his
  record 99% staff-written and wrecked every engagement comparison, in exactly
  the way Modi's automated replies did before `is_reply` existed.
- **`POTUS45` was not imported.** Trump's official presidential account overlaps
  `@realDonaldTrump` by only 610 texts, so it would have added roughly 4,290
  distinct official tweets. Left out to keep Trump a single-account record.
- **`@BarackObama` is absent from the source entirely.** It is the account that
  would be most comparable with the rest of the dataset, and Obama's 352 rows
  are a placeholder until an archive of it turns up. Treat his figures as
  representative of his `@POTUS` output only.

### Data quality notes

- **Tweet ids in this batch are genuinely unique** — 90,852 ids across 90,852
  rows — so `source_id_reliable` is **true** for Trump and Obama. They are the
  first leaders in the dataset whose `source_tweet_id` can be used to rehydrate.
- **1,021 Trump rows carry no quote or reply count** (1.7% of his total, dated
  2016-01-13 to 2020-11-25). They are recorded as 0, matching how every other
  batch treats a missing count, so his engagement is marginally understated on
  those rows.
- **Timestamps are naive in the source** and are read as UTC, which is how the
  archive publishes them.
- **Half of Trump's record predates his presidency**: 31,955 tweets before
  2017-01-20. That is consistent with the rest of the dataset, which already
  includes pre-office tweets for Meloni, Bolsonaro and others, but it matters
  for any in-office comparison. Filter on `created_at` if you need one.
- `lang`, `possibly_sensitive` and `in_reply_to_user_id` are null for this
  batch — the archive does not carry them. `is_reply` therefore rests on the
  `@`-prefix convention alone here (5.7% of Trump's tweets, 2.0% of Obama's),
  which is a weaker signal than for leaders with reply metadata.

### Still not included

- Iván Duque, Alberto Fernández and Juan Guaidó, who appear only in timeline
  files with retweets and favourites but no reply or quote counts.

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

[v1.3.0]: https://github.com/juangomezcruces/Executive-Social-Media-Database/releases/tag/v1.3.0
[v1.2.0]: https://github.com/juangomezcruces/Executive-Social-Media-Database/releases/tag/v1.2.0
[v1.1.0]: https://github.com/juangomezcruces/Executive-Social-Media-Database/releases/tag/v1.1.0
[v1.0.0]: https://github.com/juangomezcruces/Executive-Social-Media-Database/releases/tag/v1.0.0
