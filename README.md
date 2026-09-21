# Executive Social Media Database

**498,605 tweets and their engagement metrics from 62 heads of government and
state across 34 countries, May 2009 – June 2023.**

Three ways in, all reading the same versioned dataset:

| | |
| --- | --- |
| **Browse & query** | <https://juangomezcruces.github.io/Executive-Social-Media-Database/> — filter by any combination of leaders and countries, sort by any column, chart and run SQL in the browser, no install |
| **Python** | `pip install "git+https://github.com/juangomezcruces/Executive-Social-Media-Database.git#subdirectory=python-package"` |
| **R** | `remotes::install_github("juangomezcruces/Executive-Social-Media-Database", subdir = "r-package")` |

Column-by-column documentation: **[`schema.md`](schema.md)**.
Release history: **[`CHANGELOG.md`](CHANGELOG.md)**.

---

## What's in it

Three tables, published as Parquet (canonical) and CSV on every tagged release.

| table | rows | what it is |
| --- | --- | --- |
| `leaders` | 62 | one row per executive: identifiers, country, office, per-leader totals |
| `tweets` | 498,605 | one row per tweet: text, language, timestamp, retweets, replies, likes, quotes, plus `is_reply` and `is_deleted` flags |
| `sentiment` | 142,623 | POS/NEU/NEG label and class probabilities, for the 11 leaders that were classified |

`leaders` is the dimension table. `tweets` and `sentiment` join to it on
`leader_id`; `sentiment` joins to `tweets` on `tweet_uid`.

**Coverage is uneven by design.** The dataset was assembled from three
collections. The 21 leaders in the 2023 run start at 2018-01-01; the 17 from the
2022 run reach back as far as 2010 but stop at 2023-06-07; the 22 Latin American
presidents added in v1.1.0 each span only their own time in office, from
Chávez's 1,000 tweets ending in February 2013 to Maduro's 11,724 across
2021–2022; and the two US presidents added in v1.3.0 are asymmetric by
necessity — Trump's 58,249 tweets against Obama's 352, because Obama's personal
account is not in the available archive (see below). `leaders.first_tweet` and `leaders.last_tweet` give each leader's
real window — check them before comparing leaders across time, because a leader
with fewer tweets usually had a shorter collected period, not a quieter one.

```python
import leaders_tweets as lt

lt.data_version()                                        # 'v1.3.0'
lt.load_leaders()                                        # 62 rows
lt.get_tweets("Modi", start="2022-01-01", end="2022-12-31")
lt.get_sentiment("Trudeau")
```

```r
library(leaderstweets)

data_version()
load_leaders()
get_tweets("Modi", start = "2022-01-01", end = "2022-12-31")
get_sentiment("Trudeau")
```

The two packages take the same arguments and return the same rows; `leader`
accepts a `leader_id`, a full name, an X handle or a unique surname, and ignores
case and accents — `"chavez"`, `"Chavez"` and `"Chávez"` all resolve to the same
leader in both languages.

---

## How the data was collected

Tweets were pulled from the X/Twitter API in two passes — one in 2022 keyed on
account handles, one in 2023 keyed on leaders, restricted to 2018 onward — as
part of research forecasting executive approval from social media activity.
Engagement counts (retweets, replies, likes, quotes) are **as of collection
time**, not live: a 2010 tweet's likes reflect twelve years of accumulation, a
2023 tweet's only days. Do not compare raw counts across very different tweet
ages without accounting for that.

The 22 Latin American presidents added in v1.1.0 come from a separate
collection covering 2010–2023, assembled for research on populist communication.
Its `type_of_leader` coding is preserved as the `populist` column on `leaders`
— it is the dataset author's own research classification, not an external
standard, and it is null for every leader outside that batch.

**Trump and Obama** (v1.3.0) come from a separate archive export with all four
engagement metrics and, unusually, genuinely unique tweet ids. Trump is
`@realDonaldTrump`, 2009–2021, ending with his suspension. Obama is `@POTUS`
during his term — **352 tweets**, because the archive does not contain
`@BarackObama`, his main personal account. The archive's `ObamaWhiteHouse`
account (27,347 tweets) was deliberately **not** imported: it is the
institutional White House feed, staff-written, with a mean engagement of 713
against `@POTUS`'s 73,136. Attributing it to Obama would have made his record
overwhelmingly institutional and destroyed any engagement comparison.

That archive also marks tweets later deleted, preserved as **`is_deleted`**
(1,354 rows, 1,353 of them Trump's). It is null — meaning *unknown*, not false —
for every leader outside that batch, because no other source records deletions.

Sentiment labels come from a `pysentimiento` classifier run over the tweet text
for 11 leaders; the three probabilities sum to 1.

Rows are deduplicated on `(leader_id, created_at, text)`, which removed 362 rows
(0.09%) from the original 407,427 and 11 rows from the 112,115 in the Latin
America batch.

### Replies are not broadcast tweets — read this before comparing volume

**21% of the dataset (92,735 rows) is conversational replies**, and they behave
nothing like a leader's ordinary posts: median engagement **3**, against **303**
for everything else. The `is_reply` flag marks them, so

```sql
SELECT leader_id, COUNT(*) FROM tweets WHERE NOT is_reply GROUP BY 1
```

is the honest way to compare how much leaders actually posted.

The clearest case is **Narendra Modi on 16 March 2019**: 38,090 tweets in 9.7
hours — 65 a minute — every one an `@`-reply, 92% of them mentioning
"Chowkidar". They are automated personalised replies from the
[#MainBhiChowkidar campaign](https://en.wikipedia.org/wiki/Main_Bhi_Chowkidar),
launched two days earlier. They are genuine, distinct tweets, but they are not
comparable to anything else in the dataset: their median engagement is 1 and 40%
have none at all.

That single day is **67% of Modi's record** and **8.7% of the entire dataset**.
Counting it, Modi is the most prolific leader here and his mean engagement is
8,486. Excluding replies he is third, with a mean of 26,307 — a threefold
difference produced entirely by one afternoon of automation. Other reply-heavy
accounts include Solberg (66%), Correa (59%) and Ardern (57%).

`is_reply` is true when the API's own `in_reply_to_user_id` or
`tweet_type = 'replied_to'` says so, **or** the text begins with `@`. All three
are needed: metadata alone misses 134 rows, and the `@` test alone misses 27,466
replies that open differently (`.@someone Thank you...`).

### The tweet id problem

The raw collection files carry an `id` column that is **not a usable primary
key**. In 12 of the 52 source files the same value is attached to several
distinct tweets; `tweetsModi.csv` is the extreme case, with 3,921 distinct ids
across 56,941 distinct tweets — three different Modi tweets (Tamil, Sinhala and
English versions of one message) share a single id. The collector appears to
have written something other than the tweet id for those runs.

So the dataset keys on **`tweet_uid`**, a BLAKE2b-64 digest of
`leader_id | created_at | text`. The raw value is kept as `source_tweet_id`, and
`source_id_reliable` marks whether it can be trusted for that leader. **Check
that flag before using ids to rehydrate against the X API** — for the 12
affected leaders those ids will fetch the wrong tweets.

---

## Repository layout

```
data/                  canonical tables (Parquet committed; CSV is release-only)
scripts/
  export_data.py       raw CSVs -> canonical tables + schema.json
  leaders.py           the original 38-leader registry and file mapping
  leaders_latam.py     the 22 Latin American presidents added in v1.1.0
  leaders_us.py        Trump and Obama, added in v1.3.0
  make_manifest.py     writes the release pointer every client reads
  make_schema_md.py    renders schema.md from schema.json
  serve_site.py        local preview server with HTTP Range support
webapp/                the static site (plain ES modules, no build step)
python-package/        leaders_tweets
r-package/             leaderstweets
.github/workflows/     Pages deployment
```

`data/*.csv` is git-ignored: `tweets.csv` is 182 MB, past GitHub's hard 100 MB
per-file limit. The CSVs are attached to each release instead. The Parquet files
(55 MB total) **are** committed, because the web app has to read them
same-origin — see below.

### Regenerating the dataset

```bash
python scripts/export_data.py --source /path/to/raw/csvs --out data
python scripts/make_manifest.py --data data --version v1.3.0
python scripts/make_schema_md.py --data data --out schema.md
```

`export_data.py` refuses to write a CSV that does not survive a read-back, so a
quoting bug cannot ship silently.

---

## How the three clients find the data

Every client resolves the dataset through a small `manifest.json` attached to
the **latest** release:

```
https://github.com/juangomezcruces/Executive-Social-Media-Database/releases/latest/download/manifest.json
```

GitHub redirects `latest/download/...` to the newest release, so no tag is
hardcoded anywhere and no GitHub API call is made (nothing to rate-limit). The
manifest names the version, the table URLs, row counts and SHA-256 digests. The
packages cache tables under the version and re-download only when it changes;
`data_version()` reports which release the local cache came from.

**The web app is the exception, and for a specific reason.** GitHub's release
asset CDN sends no `Access-Control-Allow-Origin` header, so a browser cannot
read release assets cross-origin — DuckDB-Wasm fetching them would fail in every
browser. The site therefore serves the Parquet from its own origin, which is why
those files are committed and copied into the published site by the deploy
workflow.

### Two pins worth knowing about

- **DuckDB-Wasm is pinned to 1.28.0.** It is the last release with the Parquet
  reader statically linked. From 1.29.0 DuckDB auto-downloads
  `parquet.duckdb_extension.wasm` from `extensions.duckdb.org` on first query,
  adding a third-party runtime dependency that fails closed on networks that
  block it. Verify Parquet still works before bumping.
- **The R package treats `arrow` as optional.** With `arrow` installed it reads
  Parquet; without it, it falls back to the CSV release asset. `arrow` is a
  heavy dependency and many R users won't have it, so requiring it would make
  the package hard to install for no gain.

---

## Updating the data

1. Re-run the three scripts above with the new `--version`.
2. Add a `CHANGELOG.md` entry.
3. Commit, tag, and publish a release with the six table files, `manifest.json`
   and `schema.json` attached.

The web app redeploys on `release: published`, and both packages notice the new
manifest within a day (or immediately after `clear_cache()`). Nothing needs to
be re-released or re-installed downstream.

---

## Licence and reuse

Code is MIT (see [`LICENSE`](LICENSE)). The tweet text is the work of its
authors and is redistributed here for research use; X's developer terms restrict
bulk redistribution of tweet content, so if you plan to republish this dataset
rather than analyse it, check those terms and consider distributing ids for
rehydration instead — bearing in mind the id caveat above.

If you use the dataset, please cite this repository and the release tag you
used, which `data_version()` will tell you.
