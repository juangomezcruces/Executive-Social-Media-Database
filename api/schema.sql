-- Schema for the Executive Social Media Database API.
--
-- Built into a SQLite file by scripts/build_api_data.py and uploaded whole
-- with `turso db import`. Design is driven by one constraint: the database
-- runs on a free plan with a metered allowance of rows read, and queries fail
-- once it is spent. Every index below exists so that a capped request reads on
-- the order of its LIMIT rather than scanning the table. A single unindexed
-- scan of `tweets` reads 498,605 rows for one page of 50.

DROP TABLE IF EXISTS leaders;
CREATE TABLE leaders (
  leader_id          TEXT PRIMARY KEY,
  name               TEXT NOT NULL,
  handle             TEXT,
  country            TEXT NOT NULL,
  country_iso3       TEXT NOT NULL,
  office             TEXT NOT NULL,
  n_tweets           INTEGER NOT NULL,
  first_tweet        TEXT,
  last_tweet         TEXT,
  total_retweets     INTEGER,
  total_replies      INTEGER,
  total_likes        INTEGER,
  total_quotes       INTEGER,
  mean_engagement    REAL,
  source_id_reliable INTEGER,
  has_sentiment      INTEGER,
  populist           INTEGER,
  source_files       TEXT
);

DROP TABLE IF EXISTS tweets;
CREATE TABLE tweets (
  tweet_uid          TEXT PRIMARY KEY,
  leader_id          TEXT NOT NULL,
  country            TEXT NOT NULL,
  created_at         TEXT NOT NULL,   -- ISO-8601 UTC, sorts lexicographically
  date               TEXT NOT NULL,   -- YYYY-MM-DD
  lang               TEXT,
  text               TEXT NOT NULL,
  retweet_count      INTEGER NOT NULL,
  reply_count        INTEGER NOT NULL,
  like_count         INTEGER NOT NULL,
  quote_count        INTEGER NOT NULL,
  engagement         INTEGER NOT NULL,
  is_reply           INTEGER NOT NULL,
  is_deleted         INTEGER,
  source_tweet_id    TEXT,
  source_id_reliable INTEGER
);

-- The three orderings the UI offers, each leading with the filter column so a
-- filtered page is an index range scan and not a sort of the whole table.
CREATE INDEX idx_tweets_leader_time  ON tweets (leader_id, created_at DESC);
CREATE INDEX idx_tweets_leader_eng   ON tweets (leader_id, engagement DESC);
CREATE INDEX idx_tweets_country_time ON tweets (country,   created_at DESC);
CREATE INDEX idx_tweets_time         ON tweets (created_at DESC);
CREATE INDEX idx_tweets_eng          ON tweets (engagement DESC);
CREATE INDEX idx_tweets_date         ON tweets (date);

-- Full-text search. Without this, `text LIKE '%climate%'` scans 498,605 rows
-- per request; with it, a search reads only the matching rows.
DROP TABLE IF EXISTS tweets_fts;
CREATE VIRTUAL TABLE tweets_fts USING fts5(
  text,
  content='tweets',
  content_rowid='rowid',
  tokenize='unicode61 remove_diacritics 2'
);

-- API keys. Only the SHA-256 hash is stored: a leaked database does not leak
-- usable keys, and there is no way to recover a key that its holder has lost.
DROP TABLE IF EXISTS api_keys;
CREATE TABLE api_keys (
  key_hash    TEXT PRIMARY KEY,
  label       TEXT NOT NULL,      -- who it was issued to
  email       TEXT,
  issued_at   TEXT NOT NULL,
  revoked_at  TEXT,
  note        TEXT
);

-- One row per authenticated download, so you can see who is using the data.
DROP TABLE IF EXISTS download_log;
CREATE TABLE download_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  key_hash   TEXT NOT NULL,
  table_name TEXT NOT NULL,
  format     TEXT NOT NULL,
  at         TEXT NOT NULL,
  country    TEXT,               -- from Cloudflare's request metadata
  user_agent TEXT
);
CREATE INDEX idx_download_log_key ON download_log (key_hash, at DESC);
