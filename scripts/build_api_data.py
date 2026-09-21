#!/usr/bin/env python3
"""Turn the exported tables into everything the API needs.

Produces, under ``--out``:

``esmd.db``                 the whole database as one SQLite file
``esmd.sql``                the same database as a SQL dump, which is what
                            ``turso db import`` actually takes
``public/summary.json``     precomputed totals
``public/volume.json``      monthly volume and engagement per leader
``public/engagement.json``  mean engagement per leader
``public/manifest.json``    the release pointer

Two decisions are worth knowing about.

*One load, not a schedule.* An earlier version emitted 149 MB of SQL in 103
chunks for ``wrangler d1 execute``. This dataset costs about 4.5 million
row-writes once the seven indexes and the full-text index are counted, which is
45 days at D1's free allowance of 100,000 a day; Turso's free plan allows 10
million a month, so the same load lands in one sitting. The dump is ordered to
help: the rows go into bare tables and the indexes are created afterwards, so
nothing is written twice.

*Aggregates are precomputed.* The chart endpoints must never touch the
database: they are static objects served from R2, so moving a filter in the web
app costs zero rows read.

    python scripts/build_api_data.py --data data --out api/build
"""

from __future__ import annotations

import argparse
import json
import shutil
import sqlite3
from pathlib import Path

import pandas as pd

TWEET_COLUMNS = [
    "tweet_uid", "leader_id", "country", "created_at", "date", "lang", "text",
    "retweet_count", "reply_count", "like_count", "quote_count", "engagement",
    "is_reply", "is_deleted", "source_tweet_id", "source_id_reliable",
]
LEADER_COLUMNS = [
    "leader_id", "name", "handle", "country", "country_iso3", "office",
    "n_tweets", "first_tweet", "last_tweet", "total_retweets", "total_replies",
    "total_likes", "total_quotes", "mean_engagement", "source_id_reliable",
    "has_sentiment", "populist", "source_files",
]


def build_database(db_path: Path, schema: Path, leaders: pd.DataFrame,
                   tweets: pd.DataFrame) -> None:
    """Write the complete SQLite database, schema, data and indexes."""
    if db_path.exists():
        db_path.unlink()
    connection = sqlite3.connect(db_path)
    try:
        connection.executescript(schema.read_text())

        lead = leaders.copy()
        for column in ("first_tweet", "last_tweet"):
            lead[column] = lead[column].astype(str)
        for column in ("source_id_reliable", "has_sentiment", "populist"):
            lead[column] = lead[column].map({True: 1, False: 0}).astype("Int64")
        connection.executemany(
            f"INSERT INTO leaders ({', '.join(LEADER_COLUMNS)}) "
            f"VALUES ({', '.join('?' * len(LEADER_COLUMNS))})",
            _rows(lead[LEADER_COLUMNS]),
        )

        tw = tweets.copy()
        tw["created_at"] = tw["created_at"].dt.strftime("%Y-%m-%dT%H:%M:%SZ")
        tw["date"] = tw["date"].astype(str)
        for column in ("is_reply", "is_deleted", "source_id_reliable"):
            tw[column] = tw[column].map({True: 1, False: 0}).astype("Int64")
        connection.executemany(
            f"INSERT INTO tweets ({', '.join(TWEET_COLUMNS)}) "
            f"VALUES ({', '.join('?' * len(TWEET_COLUMNS))})",
            _rows(tw[TWEET_COLUMNS]),
        )

        # Populate the full-text index from the base table, once the rows exist.
        connection.execute(
            "INSERT INTO tweets_fts (rowid, text) SELECT rowid, text FROM tweets")
        connection.commit()

        # A file that is about to be uploaded should not carry a journal or
        # free pages with it.
        connection.execute("PRAGMA journal_mode = DELETE")
        connection.execute("VACUUM")
        connection.commit()

        counts = {
            name: connection.execute(f"SELECT COUNT(*) FROM {name}").fetchone()[0]
            for name in ("leaders", "tweets", "tweets_fts")
        }
    finally:
        connection.close()

    if counts["tweets"] != len(tweets) or counts["leaders"] != len(leaders):
        raise AssertionError(f"row counts do not match the source: {counts}")
    if counts["tweets_fts"] != counts["tweets"]:
        raise AssertionError(
            f"the search index covers {counts['tweets_fts']:,} of "
            f"{counts['tweets']:,} tweets")
    size = db_path.stat().st_size
    print(f"  database  {counts['tweets']:,} tweets, {counts['leaders']} leaders, "
          f"{size / 1e6:.0f} MB -> {db_path}")


def write_dump(db_path: Path, sql_path: Path) -> None:
    """Write the database out as a SQL dump, which is what `turso db import` takes.

    The CLI's `db import` reads a dump, not a SQLite file -- it checks that the
    first line is exactly ``PRAGMA foreign_keys=OFF;`` and refuses anything
    else. So the .db above is built first and this renders it, rather than the
    two being generated independently: whatever ends up in Turso is then
    provably the same database the tests ran against.

    Two departures from what `sqlite3 .dump` would produce, both deliberate:

    * the indexes are created *after* the rows, so the import inserts into a
      bare table once instead of updating seven indexes half a million times;
    * the full-text index is rebuilt from the base table with one statement
      rather than having its internal shadow tables dumped row by row, which
      is both smaller and far less fragile across SQLite versions.
    """
    connection = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    try:
        objects = connection.execute(
            "SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL"
        ).fetchall()
        # The fts5 shadow tables (tweets_fts_data and friends) are managed by
        # the virtual table; dumping them directly is what breaks on restore.
        shadow = tuple(f"tweets_fts_{suffix}"
                       for suffix in ("data", "idx", "docsize", "config", "content"))
        tables = [sql for kind, name, sql in objects
                  if kind == "table" and not name.startswith("sqlite_")
                  and name not in shadow]
        indexes = [sql for kind, name, sql in objects
                   if kind == "index" and not name.startswith("sqlite_autoindex")]

        with sql_path.open("w", encoding="utf-8") as out:
            out.write("PRAGMA foreign_keys=OFF;\n")
            out.write("BEGIN TRANSACTION;\n")
            for statement in tables:
                out.write(f"{statement};\n")

            for table, columns in (("leaders", LEADER_COLUMNS),
                                   ("tweets", TWEET_COLUMNS)):
                prefix = f"INSERT INTO {table} ({', '.join(columns)}) VALUES"
                batch = []
                cursor = connection.execute(
                    f"SELECT {', '.join(columns)} FROM {table}")
                for row in cursor:
                    batch.append(f"({', '.join(sql_literal(v) for v in row)})")
                    if len(batch) >= 500:
                        out.write(f"{prefix}\n" + ",\n".join(batch) + ";\n")
                        batch = []
                if batch:
                    out.write(f"{prefix}\n" + ",\n".join(batch) + ";\n")

            out.write("INSERT INTO tweets_fts (rowid, text) "
                      "SELECT rowid, text FROM tweets;\n")
            for statement in indexes:
                out.write(f"{statement};\n")
            out.write("COMMIT;\n")
    finally:
        connection.close()

    size = sql_path.stat().st_size
    print(f"  dump      {size / 1e6:.0f} MB -> {sql_path}")


def sql_literal(value) -> str:
    """Render a Python value as a SQLite literal.

    Doubling single quotes is the whole of SQLite's string escaping. Newlines
    inside a literal are left as newlines, exactly as `sqlite3 .dump` writes
    them, so a statement can span lines.
    """
    if value is None:
        return "NULL"
    if isinstance(value, bool):
        return "1" if value else "0"
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        return repr(value)
    return "'" + str(value).replace("'", "''") + "'"


def _rows(frame: pd.DataFrame):
    """Yield plain Python tuples; sqlite3 cannot bind numpy or pandas NA."""
    for row in frame.itertuples(index=False, name=None):
        yield tuple(None if value is None or value is pd.NA
                    or (isinstance(value, float) and pd.isna(value))
                    else value.item() if hasattr(value, "item") else value
                    for value in row)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--data", default=Path("data"), type=Path)
    ap.add_argument("--out", default=Path("api/build"), type=Path)
    ap.add_argument("--schema", default=Path("api/schema.sql"), type=Path)
    ap.add_argument("--public-only", action="store_true",
                    help="rebuild only the JSON aggregates, leaving the database alone")
    ap.add_argument("--dump-only", action="store_true",
                    help="re-render the dump from an already-built esmd.db")
    args = ap.parse_args()

    if args.dump_only:
        write_dump(args.out / "esmd.db", args.out / "esmd.sql")
        return

    public = args.out / "public"
    if public.exists():
        shutil.rmtree(public)
    public.mkdir(parents=True, exist_ok=True)

    leaders = pd.read_parquet(args.data / "leaders.parquet")
    tweets = pd.read_parquet(args.data / "tweets.parquet")
    manifest = json.loads((args.data / "manifest.json").read_text())

    if not args.public_only:
        build_database(args.out / "esmd.db", args.schema, leaders, tweets)
        write_dump(args.out / "esmd.db", args.out / "esmd.sql")

    # --- precomputed aggregates -------------------------------------------
    by_leader = tweets.groupby("leader_id")
    engagement = [
        {
            "leader_id": lid,
            "tweets": int(len(g)),
            "broadcast": int((~g["is_reply"].fillna(False)).sum()),
            "mean_engagement": round(float(g["engagement"].mean()), 1),
            "mean_engagement_broadcast": round(
                float(g.loc[~g["is_reply"].fillna(False), "engagement"].mean()), 1)
            if (~g["is_reply"].fillna(False)).any() else None,
        }
        for lid, g in by_leader
    ]
    (public / "engagement.json").write_text(json.dumps(engagement, indent=1))

    # The web app derives BOTH charts and the whole stat row from this object,
    # so it must carry every number those need under a leader / country / date
    # / exclude-replies selection: counts and engagement sums, each split into
    # "all" and "broadcast" (replies removed). Anything the browser can add up
    # here is a query the database never sees, which is the point.
    monthly = tweets.assign(
        month=tweets["created_at"].dt.strftime("%Y-%m"),
        _broadcast=~tweets["is_reply"].fillna(False),
    )
    monthly["_eng_broadcast"] = monthly["engagement"].where(monthly["_broadcast"], 0)
    monthly = (
        monthly.groupby(["leader_id", "month"])
        .agg(tweets=("tweet_uid", "size"),
             broadcast=("_broadcast", "sum"),
             engagement=("engagement", "sum"),
             engagement_broadcast=("_eng_broadcast", "sum"))
        .reset_index()
    )
    for column in ("tweets", "broadcast", "engagement", "engagement_broadcast"):
        monthly[column] = monthly[column].astype("int64")
    # Compact, not pretty-printed: every visitor downloads this file.
    (public / "volume.json").write_text(
        json.dumps(monthly.to_dict(orient="records"), separators=(",", ":")))

    summary = {
        "version": manifest["version"],
        "generated_at": manifest["generated_at"],
        "tweets": int(len(tweets)),
        "leaders": int(len(leaders)),
        "countries": int(tweets["country"].nunique()),
        "replies": int(tweets["is_reply"].fillna(False).sum()),
        "deleted": int(tweets["is_deleted"].fillna(False).sum()),
        "first_date": str(tweets["date"].min()),
        "last_date": str(tweets["date"].max()),
        "total_engagement": int(tweets["engagement"].sum()),
    }
    (public / "summary.json").write_text(json.dumps(summary, indent=1))
    (public / "manifest.json").write_text(json.dumps(manifest, indent=1))

    print(f"  aggregates written to {public}")
    print("\nnext: follow api/DEPLOY.md")


if __name__ == "__main__":
    main()
