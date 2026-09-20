#!/usr/bin/env python3
"""Export the canonical Executive Social Media Database tables.

Reads the raw collection CSVs, normalises them into three tables and writes
Parquet (canonical) and CSV (human-readable / diffable) copies plus a
machine-readable schema.

    python scripts/export_data.py --source /path/to/raw --out data

Output
------
leaders.{parquet,csv}    one row per executive (38)
tweets.{parquet,csv}     one row per tweet
sentiment.{parquet,csv}  one row per classified tweet (11 leaders)
schema.json              column-level documentation for all three tables

Design notes
------------
The raw ``id`` column is not a usable primary key: in 12 of the 52 collection
files the same value is attached to several distinct tweets (``tweetsModi.csv``
is the worst case, 3,921 distinct ids across 56,941 distinct tweets).  Rows are
therefore keyed on ``tweet_uid``, a BLAKE2b digest of
``leader_id | created_at | text``, and the raw value is preserved as
``source_tweet_id`` next to a ``source_id_reliable`` flag so that anyone
rehydrating against the X API knows which rows they can trust.

Deduplication happens on (leader_id, created_at, text), not on id.
"""

from __future__ import annotations

import argparse
import ast
import csv
import hashlib
import json
import sys
from pathlib import Path

import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent))
from leaders import LEADERS, SENTIMENT_FILES  # noqa: E402
from leaders_latam import LATAM_LEADERS, SOURCE_FILE as LATAM_FILE  # noqa: E402

RAW_COLUMNS = [
    "text", "id", "lang", "created_at", "retweet_count", "reply_count",
    "like_count", "quote_count", "possibly_sensitive", "in_reply_to_user_id",
    "type",
]
COUNT_COLUMNS = ["retweet_count", "reply_count", "like_count", "quote_count"]

#: Final column order for the tweets table, shared by both collection batches.
TWEET_COLUMNS = [
    "tweet_uid", "leader_id", "country", "country_iso3", "created_at", "date",
    "lang", "text", *COUNT_COLUMNS, "engagement", "is_reply", "possibly_sensitive",
    "in_reply_to_user_id", "tweet_type", "source_tweet_id",
    "source_id_reliable", "source_file",
]


def _is_reply(df: pd.DataFrame) -> pd.Series:
    """Flag conversational replies, as opposed to broadcast tweets.

    The union of three signals, because no single one is complete:

    * ``in_reply_to_user_id`` is set -- the API's own answer, but frequently
      null because the collector did not always request it;
    * ``tweet_type == 'replied_to'`` -- likewise;
    * the text begins with ``@`` -- the posting convention, which catches rows
      whose metadata is missing.

    Metadata alone would miss 134 rows; the ``@`` test alone would miss 27,466
    genuine replies that open differently (``.@someone Thank you...``), so both
    are used. The separation is real: replies have a median engagement of 3
    against 303 for everything else.
    """
    by_metadata = df["in_reply_to_user_id"].notna() | df["tweet_type"].eq("replied_to")
    by_convention = df["text"].str.startswith("@", na=False)
    return (by_metadata.fillna(False) | by_convention.fillna(False)).astype("boolean")


def _uid(leader_id: str, created_at: str, text: str) -> str:
    h = hashlib.blake2b(digest_size=8)
    h.update(f"{leader_id}\x1f{created_at}\x1f{text}".encode("utf-8", "surrogatepass"))
    return h.hexdigest()


def _to_bool(series: pd.Series) -> pd.Series:
    """R writes TRUE/FALSE, pandas writes True/False, both may be blank."""
    s = series.astype("string").str.strip().str.lower()
    return s.map({"true": True, "false": False}).astype("boolean")


def _read_raw(path: Path) -> pd.DataFrame:
    df = pd.read_csv(path, dtype=str, low_memory=False, encoding_errors="replace")
    df = df.rename(columns={"Unnamed: 0": "_row"})
    missing = [c for c in RAW_COLUMNS if c not in df.columns]
    if missing:
        raise ValueError(f"{path.name}: missing expected columns {missing}")
    return df[RAW_COLUMNS]


def build_tweets(source: Path) -> pd.DataFrame:
    frames = []
    for leader in LEADERS:
        per_leader = []
        for fname in leader["files"]:
            path = source / fname
            if not path.exists():
                raise FileNotFoundError(f"{leader['leader_id']}: {path}")
            raw = _read_raw(path)
            raw["source_file"] = fname
            per_leader.append(raw)
        df = pd.concat(per_leader, ignore_index=True)

        df["leader_id"] = leader["leader_id"]
        df["country"] = leader["country"]
        df["country_iso3"] = leader["iso3"]
        df["text"] = df["text"].fillna("")
        df = df[df["created_at"].notna()]

        # The id column is only trustworthy when it is 1:1 with distinct tweets.
        distinct_rows = df.drop_duplicates(["created_at", "text"]).shape[0]
        df["source_id_reliable"] = df["id"].nunique() == distinct_rows

        df = df.drop_duplicates(["created_at", "text"], keep="first")
        frames.append(df)

    tweets = pd.concat(frames, ignore_index=True)

    tweets["tweet_uid"] = [
        _uid(l, c, t) for l, c, t in
        zip(tweets["leader_id"], tweets["created_at"], tweets["text"])
    ]
    if tweets["tweet_uid"].duplicated().any():
        raise AssertionError("tweet_uid collision -- widen the digest")

    ts = pd.to_datetime(tweets["created_at"], format="ISO8601", utc=True, errors="coerce")
    tweets["created_at"] = ts
    tweets["date"] = ts.dt.date
    for col in COUNT_COLUMNS:
        tweets[col] = pd.to_numeric(tweets[col], errors="coerce").fillna(0).astype("int64")
    tweets["engagement"] = tweets[COUNT_COLUMNS].sum(axis=1)
    tweets["possibly_sensitive"] = _to_bool(tweets["possibly_sensitive"])
    tweets = tweets.rename(columns={"id": "source_tweet_id", "type": "tweet_type"})
    tweets["lang"] = tweets["lang"].astype("string")
    tweets["tweet_type"] = tweets["tweet_type"].replace({"NA": None}).astype("string")
    tweets["in_reply_to_user_id"] = (
        tweets["in_reply_to_user_id"].replace({"NA": None}).astype("string")
    )

    tweets["is_reply"] = _is_reply(tweets)
    tweets = tweets[TWEET_COLUMNS]
    return tweets.sort_values(["leader_id", "created_at"]).reset_index(drop=True)


def _parse_mixed_dates(raw: pd.Series) -> pd.Series:
    """Parse the three date formats found in the Latin America source file.

    The file was assembled from several exports and carries ISO-8601 with a
    time, bare ``YYYY-MM-DD`` (Bolsonaro's rows), and R's numeric date serial
    -- days since 1970-01-01 (Macri's rows). Parsing them with one format
    silently yields NaT for two of the three, so each is handled explicitly and
    the result is asserted complete.
    """
    raw = raw.fillna("")
    iso = raw.str.match(r"^\d{4}-\d{2}-\d{2}T")
    date_only = raw.str.match(r"^\d{4}-\d{2}-\d{2}$")
    serial = raw.str.match(r"^\d+$")

    out = pd.Series(pd.NaT, index=raw.index, dtype="datetime64[ns, UTC]")
    out[iso] = pd.to_datetime(raw[iso], utc=True, errors="coerce", format="ISO8601")
    out[date_only] = pd.to_datetime(raw[date_only], utc=True, errors="coerce",
                                    format="%Y-%m-%d")
    out[serial] = pd.to_datetime(pd.to_numeric(raw[serial]), unit="D",
                                 origin="1970-01-01", utc=True, errors="coerce")
    unparsed = out.isna().sum()
    if unparsed:
        raise AssertionError(
            f"{unparsed} timestamps in {LATAM_FILE} did not match any known "
            "format; refusing to publish rows with missing dates."
        )
    return out


def build_latam(source: Path) -> pd.DataFrame:
    """Normalise the Latin America source file into the tweets schema.

    Returns an empty frame when the file is absent, so the original export
    still runs for anyone without it.
    """
    path = source / LATAM_FILE
    if not path.exists():
        print(f"  ! {LATAM_FILE} not found, skipping the Latin America batch",
              file=sys.stderr)
        return pd.DataFrame()

    raw = pd.read_csv(path, dtype=str, low_memory=False, encoding="utf-8",
                      encoding_errors="replace")
    frames = []
    for leader in LATAM_LEADERS:
        df = raw[raw["short_name"] == leader["short_name"]].copy()
        if df.empty:
            raise ValueError(f"{leader['leader_id']}: no rows for "
                             f"short_name={leader['short_name']!r}")
        df["text"] = df["text"].fillna("")
        df["leader_id"] = leader["leader_id"]
        df["country"] = leader["country"]
        df["country_iso3"] = leader["iso3"]

        # Same test as the main pipeline: is id 1:1 with distinct tweets?
        distinct = df.drop_duplicates(["created_at", "text"]).shape[0]
        df["source_id_reliable"] = df["id"].nunique() == distinct

        df = df.drop_duplicates(["created_at", "text"], keep="first")
        frames.append(df)

    tweets = pd.concat(frames, ignore_index=True)
    tweets["source_file"] = LATAM_FILE
    tweets["tweet_uid"] = [
        _uid(l, c, t) for l, c, t in
        zip(tweets["leader_id"], tweets["created_at"], tweets["text"])
    ]

    ts = _parse_mixed_dates(tweets["created_at"])
    tweets["created_at"] = ts
    tweets["date"] = ts.dt.date
    for col in COUNT_COLUMNS:
        tweets[col] = pd.to_numeric(tweets[col], errors="coerce").fillna(0).astype("int64")
    tweets["engagement"] = tweets[COUNT_COLUMNS].sum(axis=1)
    tweets["possibly_sensitive"] = _to_bool(tweets["possibly_sensitive"])
    tweets = tweets.rename(columns={"id": "source_tweet_id", "type": "tweet_type"})
    for col in ("lang", "tweet_type", "in_reply_to_user_id"):
        tweets[col] = tweets[col].replace({"NA": None}).astype("string")

    tweets["is_reply"] = _is_reply(tweets)
    return tweets[TWEET_COLUMNS]


def build_sentiment(source: Path, tweets: pd.DataFrame) -> pd.DataFrame:
    uid_by_key = dict(
        zip(
            zip(tweets["leader_id"], tweets["created_at"].astype("int64"), tweets["text"]),
            tweets["tweet_uid"],
        )
    )
    rows = []
    for leader_id, fname in SENTIMENT_FILES.items():
        path = source / fname
        if not path.exists():
            print(f"  ! sentiment file missing, skipped: {fname}", file=sys.stderr)
            continue
        df = pd.read_csv(path, dtype=str, low_memory=False, encoding_errors="replace")
        df["text"] = df["text"].fillna("")
        ts = pd.to_datetime(df["created_at"], format="ISO8601", utc=True, errors="coerce")
        keys = list(zip([leader_id] * len(df), ts.astype("int64"), df["text"]))
        df["tweet_uid"] = [uid_by_key.get(k) for k in keys]
        matched = df["tweet_uid"].notna().sum()
        print(f"  {fname:34s} {matched:6d}/{len(df):6d} matched to tweets")
        df = df[df["tweet_uid"].notna()].drop_duplicates("tweet_uid")

        probs = df["probas"].fillna("{}").map(_parse_probas)
        out = pd.DataFrame({
            "tweet_uid": df["tweet_uid"].values,
            "leader_id": leader_id,
            "sentiment": df["sentiment"].astype("string").values,
            "prob_neg": [p.get("NEG") for p in probs],
            "prob_neu": [p.get("NEU") for p in probs],
            "prob_pos": [p.get("POS") for p in probs],
        })
        rows.append(out)

    sent = pd.concat(rows, ignore_index=True)
    for col in ("prob_neg", "prob_neu", "prob_pos"):
        sent[col] = pd.to_numeric(sent[col], errors="coerce").astype("float32")
    return sent.sort_values(["leader_id", "tweet_uid"]).reset_index(drop=True)


def _parse_probas(raw: str) -> dict:
    try:
        value = ast.literal_eval(raw)
        return value if isinstance(value, dict) else {}
    except (ValueError, SyntaxError):
        return {}


def build_leaders(tweets: pd.DataFrame, sentiment: pd.DataFrame) -> pd.DataFrame:
    agg = tweets.groupby("leader_id").agg(
        n_tweets=("tweet_uid", "size"),
        first_tweet=("created_at", "min"),
        last_tweet=("created_at", "max"),
        total_retweets=("retweet_count", "sum"),
        total_replies=("reply_count", "sum"),
        total_likes=("like_count", "sum"),
        total_quotes=("quote_count", "sum"),
        source_id_reliable=("source_id_reliable", "all"),
    )
    with_sent = set(sentiment["leader_id"].unique())

    registry = [dict(l, source_files=";".join(l["files"]), populist=None)
                for l in LEADERS]
    registry += [dict(l, source_files=LATAM_FILE) for l in LATAM_LEADERS]

    rows = []
    for leader in registry:
        lid = leader["leader_id"]
        if lid not in agg.index:
            continue  # source file absent for this batch
        a = agg.loc[lid]
        rows.append({
            "leader_id": lid,
            "name": leader["name"],
            "handle": leader["handle"],
            "country": leader["country"],
            "country_iso3": leader["iso3"],
            "office": leader["office"],
            "n_tweets": int(a["n_tweets"]),
            "first_tweet": a["first_tweet"],
            "last_tweet": a["last_tweet"],
            "total_retweets": int(a["total_retweets"]),
            "total_replies": int(a["total_replies"]),
            "total_likes": int(a["total_likes"]),
            "total_quotes": int(a["total_quotes"]),
            "mean_engagement": round(
                float(a[["total_retweets", "total_replies",
                         "total_likes", "total_quotes"]].sum()) / int(a["n_tweets"]), 2),
            "source_id_reliable": bool(a["source_id_reliable"]),
            "has_sentiment": lid in with_sent,
            "populist": leader["populist"],
            "source_files": leader["source_files"],
        })
    out = pd.DataFrame(rows)
    out["populist"] = out["populist"].astype("boolean")
    return out.sort_values("leader_id").reset_index(drop=True)


SCHEMA_DOC = {
    "leaders": {
        "leader_id": "Stable snake_case key. Join key for every other table.",
        "name": "Full name of the executive, rendered in English.",
        "handle": "X/Twitter account the tweets were collected from, without the @.",
        "country": "Country name in English.",
        "country_iso3": "ISO 3166-1 alpha-3 country code.",
        "office": "Title held during the collection window.",
        "n_tweets": "Number of distinct tweets for this leader in the tweets table.",
        "first_tweet": "Timestamp of the earliest tweet collected (UTC).",
        "last_tweet": "Timestamp of the latest tweet collected (UTC).",
        "total_retweets": "Sum of retweet_count over all of this leader's tweets.",
        "total_replies": "Sum of reply_count over all of this leader's tweets.",
        "total_likes": "Sum of like_count over all of this leader's tweets.",
        "total_quotes": "Sum of quote_count over all of this leader's tweets.",
        "mean_engagement": "Mean of (retweets + replies + likes + quotes) per tweet.",
        "source_id_reliable": "False when the raw collection file reused tweet ids across distinct tweets; see source_tweet_id.",
        "has_sentiment": "True when this leader appears in the sentiment table.",
        "populist": "Populist classification carried in the Latin America source file; the dataset author's own research coding, not an external standard. Null for leaders outside that batch.",
        "source_files": "Semicolon-separated raw collection files this leader was built from.",
    },
    "tweets": {
        "tweet_uid": "Primary key. BLAKE2b-64 digest of leader_id | created_at | text.",
        "leader_id": "Foreign key into leaders.",
        "country": "Denormalised from leaders for convenient filtering.",
        "country_iso3": "Denormalised from leaders.",
        "created_at": "Tweet timestamp, UTC.",
        "date": "Calendar date of created_at, UTC. Convenience column for daily aggregation.",
        "lang": "Language code assigned by X at collection time.",
        "text": "Tweet text as collected.",
        "retweet_count": "Retweets at collection time.",
        "reply_count": "Replies at collection time.",
        "like_count": "Likes at collection time.",
        "quote_count": "Quote tweets at collection time.",
        "engagement": "retweet_count + reply_count + like_count + quote_count.",
        "is_reply": "True for conversational replies (in_reply_to_user_id set, tweet_type 'replied_to', or text starting with @), false for broadcast tweets. Filter these out before comparing posting volume across leaders -- see the note on Modi, 2019-03-16.",
        "possibly_sensitive": "X's possibly_sensitive flag; null where not returned.",
        "in_reply_to_user_id": "User id this tweet replies to; null for non-replies.",
        "tweet_type": "Tweet type as returned by the collector; frequently null.",
        "source_tweet_id": "Raw id from the collection file. NOT unique in 12 of 52 files.",
        "source_id_reliable": "True when source_tweet_id is 1:1 with distinct tweets in this leader's source files.",
        "source_file": "Raw collection file this row came from.",
    },
    "sentiment": {
        "tweet_uid": "Foreign key into tweets.",
        "leader_id": "Foreign key into leaders.",
        "sentiment": "Predicted label: POS, NEU or NEG.",
        "prob_neg": "Model probability for the NEG class.",
        "prob_neu": "Model probability for the NEU class.",
        "prob_pos": "Model probability for the POS class.",
    },
}


def write_table(df: pd.DataFrame, out: Path, name: str, parquet: bool) -> dict:
    csv_path = out / f"{name}.csv"
    # Tweet text contains newlines, carriage returns and stray quotes. Quoting
    # every field and pinning the line terminator keeps the CSV copy readable by
    # naive parsers; the round-trip check below is what actually guarantees it.
    df.to_csv(csv_path, index=False, quoting=csv.QUOTE_ALL, lineterminator="\n")
    back = pd.read_csv(csv_path, dtype=str, low_memory=False)
    if len(back) != len(df):
        raise AssertionError(
            f"{name}.csv does not round-trip: wrote {len(df):,} rows, read back "
            f"{len(back):,}. Refusing to publish a corrupt CSV."
        )
    written = {"csv": csv_path.stat().st_size}
    if parquet:
        pq_path = out / f"{name}.parquet"
        # Small row groups so DuckDB-Wasm can prune by range request in the
        # browser instead of pulling the whole file for a filtered query.
        df.to_parquet(pq_path, index=False, compression="zstd",
                      row_group_size=25_000)
        written["parquet"] = pq_path.stat().st_size
    print(f"  {name:10s} {len(df):>7,} rows  " +
          "  ".join(f"{k} {v/1e6:.1f}MB" for k, v in written.items()))
    return {
        "rows": int(len(df)),
        "columns": [
            {"name": c, "type": str(df[c].dtype),
             "description": SCHEMA_DOC[name].get(c, "")}
            for c in df.columns
        ],
    }


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--source", required=True, type=Path, help="folder holding the raw CSVs")
    ap.add_argument("--out", default=Path("data"), type=Path, help="output folder")
    ap.add_argument("--version", default="v1.0.0", help="release tag this export belongs to")
    ap.add_argument("--no-parquet", action="store_true",
                    help="skip Parquet (use when pyarrow is unavailable)")
    ap.add_argument("--base-sentiment", type=Path, default=None,
                    help="reuse an already-exported sentiment.parquet instead of "
                         "rebuilding it from the withSentiment CSVs.")
    ap.add_argument("--base-tweets", type=Path, default=None,
                    help="reuse an already-exported tweets.parquet for the original "
                         "collection instead of rebuilding it from the raw CSVs. Use "
                         "when only the newer source files are to hand; the result is "
                         "identical because that batch is deterministic.")
    args = ap.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)
    parquet = not args.no_parquet

    if args.base_tweets:
        print(f"reusing {args.base_tweets} for the original collection ...")
        tweets = pd.read_parquet(args.base_tweets)
        # A base file exported before a derived column existed would otherwise
        # carry it through as all-null. Derived columns are deterministic
        # functions of columns already present, so just recompute them.
        tweets["is_reply"] = _is_reply(tweets)
    else:
        print("building tweets ...")
        tweets = build_tweets(args.source)
    print("building the Latin America batch ...")
    latam = build_latam(args.source)
    if not latam.empty:
        overlap = set(tweets["tweet_uid"]) & set(latam["tweet_uid"])
        if overlap:
            raise AssertionError(f"{len(overlap)} tweet_uid collisions between batches")
        print(f"  {len(latam):,} tweets across {latam.leader_id.nunique()} leaders")
        tweets = pd.concat([tweets, latam], ignore_index=True)
        tweets = tweets[TWEET_COLUMNS]
        tweets = tweets.sort_values(["leader_id", "created_at"]).reset_index(drop=True)

    if tweets["is_reply"].isna().any():
        raise AssertionError(
            f"{int(tweets['is_reply'].isna().sum()):,} rows have a null is_reply; "
            "refusing to publish a half-populated flag."
        )
    if args.base_sentiment:
        print(f"reusing {args.base_sentiment} for sentiment ...")
        sentiment = pd.read_parquet(args.base_sentiment)
    else:
        print("building sentiment ...")
        sentiment = build_sentiment(args.source, tweets)
    print("building leaders ...")
    leaders = build_leaders(tweets, sentiment)

    print("writing ...")
    schema = {
        "dataset": "Executive Social Media Database",
        "version": args.version,
        "generated_from": str(args.source),
        "primary_key_note": (
            "tweet_uid is the primary key. source_tweet_id is the raw X id and is "
            "not unique in 12 of the 52 collection files; check source_id_reliable "
            "before using it to rehydrate."
        ),
        "tables": {
            "leaders": write_table(leaders, args.out, "leaders", parquet),
            "tweets": write_table(tweets, args.out, "tweets", parquet),
            "sentiment": write_table(sentiment, args.out, "sentiment", parquet),
        },
    }
    (args.out / "schema.json").write_text(json.dumps(schema, indent=2, default=str))
    print(f"\n{len(leaders)} leaders, {len(tweets):,} tweets, {len(sentiment):,} sentiment rows")
    print(f"schema written to {args.out / 'schema.json'}")


if __name__ == "__main__":
    main()
