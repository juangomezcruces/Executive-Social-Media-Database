# Executive Social Media Database

**498,605 tweets and their engagement metrics from 62 heads of government and
state across 34 countries, May 2009 – June 2023.**

Three ways in, all reading the same versioned dataset:

| | |
| --- | --- |
| **Browse & query** | <https://juangomezcruces.github.io/Executive-Social-Media-Database/> — filter by any combination of leaders and countries, sort by any column, chart, no install, no key. Replies are excluded unless you ask for them |
| **Python** | `pip install "git+https://github.com/juangomezcruces/Executive-Social-Media-Database.git#subdirectory=python-package"` |
| **R** | `remotes::install_github("juangomezcruces/Executive-Social-Media-Database", subdir = "r-package")` |

Browsing is open and capped at 100 rows a request. **Whole tables are free but
need a key** — see [API keys](#api-keys). The cap exists so that the corpus is
read by people who say who they are, rather than scraped by anyone who finds
the URL.

Column-by-column documentation: **[`schema.md`](schema.md)**.
Release history: **[`CHANGELOG.md`](CHANGELOG.md)**.

---

## What's in it

Three tables, in Parquet (canonical) and CSV, downloadable in full with a key.

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

lt.set_api_key("esmd_...", persist=True)                 # once per machine
lt.data_version()                                        # 'v2.0.0'
lt.load_leaders()                                        # 62 rows
lt.get_tweets("Modi", start="2022-01-01", end="2022-12-31")
lt.get_sentiment("Trudeau")
```

```r
library(leaderstweets)

set_api_key("esmd_...", persist = TRUE)                  # once per machine
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

**Trump and Obama are the exception, and it matters.** Their archive carries no
reply metadata at all — no `in_reply_to_user_id`, no `replied_to` type — so for
those two the `@` prefix is the only signal there is. It flags 3,309 of Trump's
58,249 tweets and 7 of Obama's 352. Measured against the 440,004 rows that *do*
have metadata, the `@` rule on its own catches 65,135 of 92,601 real replies, so
it misses about **30%**. Read their reply counts as floors rather than totals,
and treat a Trump broadcast-only figure as including perhaps 1,400 replies that
could not be identified. Closing the gap needs a source with reply metadata, not
a better rule.

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
data/                  the built tables — NOT committed (see below)
api/
  src/index.js         the Worker: filters, paging, the cap, keys, downloads
  src/db.js            libSQL client, shaped like the binding it replaced
  schema.sql           tables, indexes and the full-text index
  wrangler.toml        Worker configuration; holds nothing secret
  DEPLOY.md            the runbook: build, upload, deploy, issue keys
scripts/
  export_data.py       raw CSVs -> canonical tables + schema.json
  leaders.py           the original 38-leader registry and file mapping
  leaders_latam.py     the 22 Latin American presidents added in v1.1.0
  leaders_us.py        Trump and Obama, added in v1.3.0
  make_manifest.py     writes the release pointer every client reads
  make_schema_md.py    renders schema.md from schema.json
  build_api_data.py    tables -> one SQLite file + the precomputed aggregates
  keys.py              issue, list, revoke and carry over API keys
  set_api_url.py       points all three clients at the deployed API at once
  scrub_history.sh     removes the tables from this repository's history
webapp/                the static site (plain ES modules, no build step)
python-package/        leaders_tweets
r-package/             leaderstweets
.github/workflows/     Pages deployment
```

**`data/` is git-ignored from v2.0.0.** Until v1.3.0 the Parquet tables were
committed here and the CSVs were attached to releases, which meant anyone could
take the whole corpus without asking. They now live in a private bucket behind
the API. Committing one again would undo the cap in a single push, so the Pages
workflow fails the build if a table ever reaches the site.

### Regenerating the dataset

```bash
python scripts/export_data.py    --source /path/to/raw/csvs --out data
python scripts/make_manifest.py  --data data --version v2.0.0
python scripts/make_schema_md.py --data data --out schema.md
python scripts/build_api_data.py --data data --out api/build
```

`export_data.py` refuses to write a CSV that does not survive a read-back, so a
quoting bug cannot ship silently, and `build_api_data.py` refuses to finish if
the row counts or the search index do not match the source.

### Previewing the site locally

```bash
python -m http.server -d webapp 8000
```

It talks to the deployed API. To point it somewhere else — a `wrangler dev`
Worker, say — set this in the browser console and reload:

```js
localStorage.setItem('esmd.api_base', 'http://127.0.0.1:8787/v1')
```

It is read from local storage rather than a `?api=` parameter on purpose: a
query parameter would let anyone hand a visitor a link that points the page,
and any key it holds, at a server of their choosing.

---

## API keys

Browsing the site and calling the API without a key works and is capped at
**100 rows a request**. That is enough to search the corpus, read it, chart it
and check whether it answers your question. It is not enough to copy it.

A key lifts the cap and unlocks the complete tables — 498,605 rows of Parquet
or CSV in one download. Keys are **free for research use**. To get one, open an
issue or email <juansalvadorgc@gmail.com> with who you are and roughly what you
are doing; there is no application to fill in and no approval criteria beyond
being a real person with a real use.

Once you have one:

```bash
export LEADERS_TWEETS_KEY=esmd_...
```

```python
import leaders_tweets as lt
lt.set_api_key("esmd_...", persist=True)    # saved for future sessions
lt.get_tweets()                             # the whole table
```

```r
library(leaderstweets)
set_api_key("esmd_...", persist = TRUE)
get_tweets()
```

On the website, paste it into the **API key** box; it is stored in that browser
only and unlocks the SQL console and the download buttons.

Only a SHA-256 hash of each key is ever stored, so a lost key cannot be
recovered — ask for another and the old one gets revoked. Downloads are logged
against the key, which is the whole point: the aim is to know who is using the
data, not to stop anyone from using it.

---

## The API

Base: `https://esmd-api.<subdomain>.workers.dev/v1` — the current address is in
[`webapp/src/config.js`](webapp/src/config.js).

| endpoint | what it returns | key |
| --- | --- | --- |
| `GET /v1/leaders` | all 62 leaders with their totals | no |
| `GET /v1/tweets` | filtered, sorted tweets — **max 100 rows** | no |
| `GET /v1/count` | how many rows match, ceilinged at 10,000 | no |
| `GET /v1/summary` `volume` `engagement` | precomputed aggregates | no |
| `GET /v1/manifest` | the current release | no |
| `GET /v1/download/{table}.{parquet\|csv}` | the whole table | **yes** |
| `POST /v1/sql` | read-only `SELECT`, max 1,000 rows | **yes** |

`/v1/tweets` takes `leader`, `country` (both comma-separated for several),
`start`, `end`, `min_engagement`, `q` (full-text), `exclude_replies`,
`exclude_deleted`, `sort`, `direction`, `limit` and `offset`. Send a key as
`Authorization: Bearer esmd_...`.

```bash
curl "$API/v1/tweets?leader=modi,trudeau&q=climate&exclude_replies=true&limit=5"
curl -H "Authorization: Bearer $KEY" "$API/v1/download/tweets.parquet" -o tweets.parquet
```

### How it is put together

Four free tiers, each doing the one thing it is good at:

- **Turso** holds the queryable database — the whole corpus as a single 285 MB
  SQLite file, with the indexes and the full-text index. Not Cloudflare D1,
  which would have been one account fewer: loading this dataset costs about 4.5
  million row-writes once the seven indexes and the search index are counted,
  and D1's free plan allows 100,000 a day. Turso takes the finished file in one
  upload.
- **A Cloudflare Worker** is the API. Every query it runs is bounded by an
  index — a filtered page of 50 reads about 50 rows, not 498,605 — because the
  database is metered by rows read and fails when the allowance is spent.
- **Cloudflare R2** holds the full tables and the precomputed aggregates. R2
  egress is free, which is why a 52 MB download costs nothing to serve.
- **GitHub Pages** serves the web app, which ships no data at all.

The charts and the summary on the site are computed in the browser from one
precomputed 75 KB object, so moving a filter costs the database nothing. The
cost of that: the object is monthly and has no text column, so a text search or
a minimum-engagement filter applies to the results table only — and the page
says so rather than showing numbers that disagree with the table beneath them.

### How the three clients find the data

Each client holds the API address, because each has to start somewhere, and
`scripts/set_api_url.py` rewrites all three at once so they cannot drift apart.
From there, everything is resolved through `GET /v1/manifest`, which needs no
key: it names the version, the row counts and a SHA-256 digest per file. The
packages cache tables under the version, re-download only when it changes, and
check the digest before caching, so a truncated download is caught at the point
of download rather than three lines into someone's analysis.
`data_version()` reports which release the local cache came from.

**The R package treats `arrow` as optional.** With `arrow` installed it reads
Parquet; without it, it falls back to the CSV. `arrow` is a heavy dependency
and many R users will not have it, so requiring it would make the package hard
to install for no gain. Both paths verify the digest.

---

## Updating the data

1. Re-run the four scripts above with the new `--version`.
2. Add a `CHANGELOG.md` entry.
3. Follow [`api/DEPLOY.md`](api/DEPLOY.md) §9 — save the keys, rebuild the
   database, re-import, re-upload, and put the keys back.
4. Commit and tag.

Both packages notice the new manifest within a day (or immediately after
`clear_cache()`), and the site reads the version on load. Nothing needs to be
re-released or re-installed downstream.

---

## Licence and reuse

Code is MIT (see [`LICENSE`](LICENSE)). The tweet text is the work of its
authors and is redistributed here for research use; X's developer terms restrict
bulk redistribution of tweet content, so if you plan to republish this dataset
rather than analyse it, check those terms and consider distributing ids for
rehydration instead — bearing in mind the id caveat above.

Those terms are also part of why the tables sit behind a key rather than on an
open URL. A key costs nothing and is not a judgement about you; it means the
corpus leaves here attached to a name.

If you use the dataset, please cite this repository and the release tag you
used, which `data_version()` will tell you.
