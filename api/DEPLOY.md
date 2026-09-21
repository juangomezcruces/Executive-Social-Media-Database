# Deploying the API

This is the runbook for standing the whole thing up from nothing, and for
publishing a new data release afterwards. Work through it in order; each step
ends with something you can check.

Everything here is on a free plan. Nothing in this document asks you for a
credit card.

## What you are building

| Piece | What it does | Plan |
| --- | --- | --- |
| **Turso** | the queryable database: 498,605 tweets, the indexes and the search index, in one 285 MB SQLite file | free — 5 GB, 500M rows read/month, 10M written/month |
| **Cloudflare Worker** | the API: filters, paging, the 100-row cap, key checks | free — 100,000 requests/day |
| **Cloudflare R2** | the full Parquet and CSV tables, and the precomputed chart data | free — 10 GB, egress free |
| **GitHub Pages** | the web app, which is now a thin client | free |

Why Turso and not Cloudflare D1, which would have been one account fewer:
loading this dataset costs about 4.5 million row-writes once the seven indexes
and the full-text index are counted, and D1's free plan allows 100,000 a day —
about 45 days of trickle-loading. Turso takes the finished SQLite file in one
upload. Everything else stays on Cloudflare.

## About your Cloudflare token

Do not paste it into a chat, a commit, an issue, or `wrangler.toml`. It belongs
in your shell for the length of a deploy, or nowhere:

```bash
export CLOUDFLARE_API_TOKEN=...      # this shell only, not your .zshrc
```

`npx wrangler login` is the alternative and avoids handling the token at all —
it opens a browser and authorises Wrangler against your account. Use that
unless you have a reason not to.

If the token has already been somewhere public, roll it in the Cloudflare
dashboard before going further.

## 0. Prerequisites

```bash
node --version                        # 18 or newer
python3 -c "import pandas, pyarrow"   # silence means you have them
                                      # if not: pip3 install pandas pyarrow

# the Turso CLI, either way
brew install tursodatabase/tap/turso
# or: curl -sSfL https://get.tur.so/install.sh | bash
```

`npx wrangler` needs no install; it fetches on first use.

## 1. Build the artefacts

From the repository root:

```bash
python3 scripts/build_api_data.py --data data --out api/build
```

That is the only build step when `data/` already holds the tables from the
last export — v2.0.0 changed how the data is reached, not a row of the data
itself. After a genuinely new collection, run all three:

```bash
python3 scripts/export_data.py    --source <collection folders> --out data --version vX.Y.Z
python3 scripts/make_manifest.py  --data data --version vX.Y.Z
python3 scripts/build_api_data.py --data data --out api/build
```

You should end up with:

```
data/{tweets,leaders,sentiment}.{parquet,csv}   the tables
data/manifest.json                              the release pointer
api/build/esmd.db                               285 MB — the whole database
api/build/esmd.sql                              155 MB — the same, as a dump
api/build/public/*.json                         summary, volume, engagement, manifest
```

`build_api_data.py` refuses to finish if the row counts or the search index
don't match the source, so if it printed a size, the file is complete.

## 2. Create the database

```bash
turso auth signup                  # or: turso auth login
turso db import api/build/esmd.sql # names it after the file: "esmd"
```

Note the `.sql`, not the `.db`: `turso db import` takes a **SQL dump** and
rejects a SQLite file outright, with `first line should be 'PRAGMA
foreign_keys=OFF;'`. `build_api_data.py` renders the dump from the database it
just built, so the two cannot disagree — and orders it so the rows go into bare
tables with the indexes created afterwards, which is both faster and cheaper
against the write allowance.

If the import ever chokes, the same file can be run through the shell instead:

```bash
turso db create esmd
turso db shell esmd < api/build/esmd.sql
```

Either way, check it landed:

```bash
turso db shell esmd "SELECT COUNT(*) FROM tweets"          # 498605
turso db shell esmd "SELECT COUNT(*) FROM tweets_fts"      # 498605
turso db shell esmd "SELECT name FROM sqlite_master WHERE type='index'"
```

Then take the two values the Worker needs:

```bash
turso db show esmd --url          # libsql://esmd-<org>.turso.io
turso db tokens create esmd       # a long JWT — treat it as a password
```

## 3. Create the bucket and upload the files

```bash
npx wrangler login                # or export CLOUDFLARE_API_TOKEN
npx wrangler r2 bucket create esmd-data

# The tables. private/ is never served without a key.
for f in tweets leaders sentiment; do
  npx wrangler r2 object put "esmd-data/private/$f.parquet" --remote \
    --file="data/$f.parquet" --content-type=application/vnd.apache.parquet
  npx wrangler r2 object put "esmd-data/private/$f.csv" --remote \
    --file="data/$f.csv" --content-type=text/csv
done

# The precomputed aggregates. public/ is served to everyone, and is the reason
# the charts cost zero database rows.
for f in summary volume engagement manifest; do
  npx wrangler r2 object put "esmd-data/public/$f.json" --remote \
    --file="api/build/public/$f.json" --content-type=application/json
done
```

`tweets.csv` is 182 MB. If Wrangler refuses it as too large, upload that one
file through the R2 page in the Cloudflare dashboard, or with `rclone` against
R2's S3-compatible endpoint; nothing else in the list is near any limit.

Check:

```bash
npx wrangler r2 object get esmd-data/public/summary.json --remote --pipe | head -c 200
```

## 4. Deploy the Worker

Put the database URL in `api/wrangler.toml` (replace the `REPLACE-ME` host),
then:

```bash
cd api
npx wrangler secret put TURSO_TOKEN     # paste the token from step 2
npx wrangler deploy
```

Wrangler prints the Worker's URL, something like
`https://esmd-api.<your-subdomain>.workers.dev`. Smoke-test it:

```bash
curl -s https://esmd-api.<subdomain>.workers.dev/v1/summary
curl -s "https://esmd-api.<subdomain>.workers.dev/v1/tweets?leader=obama&limit=2"
curl -s "https://esmd-api.<subdomain>.workers.dev/v1/tweets?limit=5000" | head -20
```

The last one must come back with 100 rows and `"capped": 100`. If it returns
5,000, stop: the cap is the whole design and something is wrong.

## 5. Point the three clients at it

The web app, the Python package and the R package each hold the API address,
because each has to start somewhere. One command sets all three:

```bash
cd ..
python scripts/set_api_url.py https://esmd-api.<subdomain>.workers.dev/v1
python scripts/set_api_url.py --check x        # confirm all three agree
git commit -am "Point the clients at the deployed API"
git push
```

Pushing deploys the site: the Pages workflow refuses to publish if
`config.js` still holds the placeholder, or if any data file has found its way
into the site directory.

## 6. Give yourself a key and check the whole path

`scripts/keys.py` talks to the database over the same HTTP API the Worker
uses, so it needs the two values from step 2:

```bash
export TURSO_URL=$(turso db show esmd --url)
export TURSO_TOKEN=$(turso db tokens create esmd)

python scripts/keys.py issue --label "Juan Gomez Cruces" --email juansalvadorgc@gmail.com
```

The key is live the moment it prints, and it prints once — only its SHA-256
hash is stored, so it cannot be recovered. Then:

```bash
export LEADERS_TWEETS_KEY=esmd_...
python -c "import leaders_tweets as lt; print(lt.get_tweets('Obama').shape)"
Rscript -e 'leaderstweets::get_tweets("Obama") |> nrow()'
```

Then open the site, paste the key into the API key box, and confirm the SQL
console and the download buttons come alive.

## 7. Take the old data down

Until v1.3.0 the Parquet files were committed to this repository and the CSVs
were attached to releases. While either is still reachable, the 100-row cap is
decoration. This step is what makes the rest of it real.

```bash
# 1. Delete the data assets from every release.
gh release list --limit 50
for tag in v1.0.0 v1.1.0 v1.2.0 v1.3.0; do
  gh release view "$tag" --json assets --jq '.assets[].name' | while read -r a; do
    case "$a" in *.parquet|*.csv|*.csv.gz) gh release delete-asset "$tag" "$a" --yes;; esac
  done
done

# 2. Remove the tables from the history and force-push.
bash scripts/scrub_history.sh
```

`scrub_history.sh` explains itself before doing anything and asks for
confirmation. Read what it prints.

**What this does not do.** Anyone who already cloned the repository or
downloaded a release asset still has the data, and nothing here changes that.
Rewriting history also leaves the old commits reachable by their SHA on
GitHub's side until they are garbage-collected; if that matters, ask GitHub
Support to purge the cached views after you force-push. Treat this step as
"stop distributing it", not "un-publish it".

## 8. Running it

All of this goes through `scripts/keys.py`, with `TURSO_URL` and `TURSO_TOKEN`
set as in step 6.

```bash
python scripts/keys.py issue --label "A. Researcher, LSE" --email a@lse.ac.uk
python scripts/keys.py list        # every key, its downloads and when it was last used
python scripts/keys.py revoke --label "A. Researcher, LSE"
```

Keys are free; the point is knowing who has the data, not restricting who can.
A revoked key stops working on its next request.

**Watch the allowance.** `turso db show esmd` reports rows read and written for
the month; the Cloudflare dashboard reports Worker requests. The design keeps
a filtered page at roughly its LIMIT in rows read and the charts at zero, so
ordinary traffic will not come close. If the database ever does refuse queries,
the API returns a 503 saying so rather than an opaque error.

## 9. Publishing a new data release

```bash
python scripts/export_data.py    --source ... --out data --version v2.1.0
python scripts/make_manifest.py  --data data --version v2.1.0
python scripts/build_api_data.py --data data --out api/build

# Save the keys FIRST: a rebuilt database starts empty, and every holder
# would otherwise have to be re-issued one.
python scripts/keys.py export --out keys.json

turso db destroy esmd --yes          # replace the database wholesale
turso db import api/build/esmd.db
export TURSO_TOKEN=$(turso db tokens create esmd)   # a new database, a new token
cd api && npx wrangler secret put TURSO_TOKEN && cd ..

python scripts/keys.py import --file keys.json
python scripts/keys.py list          # confirm they are all back

# re-upload the tables and the aggregates exactly as in step 3
```

Destroying and re-importing is deliberate: it keeps the database a build
artefact of the exporter rather than something with its own edit history, so
the tables, the Parquet files and the manifest can never drift apart. `keys.py
export` is what makes that safe — run it before the destroy, every time.
`keys.json` holds hashes, not keys, but it is still a list of your users: keep
it out of the repository.

Finally, tag the release and push; the site picks up the new version from
`/v1/manifest` and both packages notice within a day, or immediately after
`clear_cache()`.
