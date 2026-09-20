/**
 * Client-side query layer for the Executive Social Media Database.
 *
 * There is no backend. DuckDB-Wasm runs in a worker in the browser and reads
 * the Parquet tables over HTTP range requests, so a filtered query pulls only
 * the row groups and columns it touches rather than the whole 33 MB file.
 *
 * The tables are served from this site's own origin (./data/). GitHub Release
 * assets are the canonical distribution for the packages, but the release CDN
 * sends no Access-Control-Allow-Origin header, so a browser cannot read them
 * cross-origin -- hence the same-origin copy here.
 */

// Pinned to 1.28.0 deliberately: it is the last release with the Parquet
// reader statically linked into the WASM bundle. From 1.29.0 onward DuckDB
// auto-downloads parquet.duckdb_extension.wasm from extensions.duckdb.org on
// first query, which adds a third-party runtime dependency that fails closed
// on networks that block it. Verify Parquet still works before bumping this.
import * as duckdb from 'https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@1.28.0/+esm';

const DATA_BASE = new URL('./data/', window.location.href).href;
const TABLES = ['tweets', 'leaders', 'sentiment'];

let connection = null;
let manifest = null;

/** Boot DuckDB-Wasm and register the Parquet files. Idempotent. */
async function connect() {
  if (connection) return connection;

  const bundle = await duckdb.selectBundle(duckdb.getJsDelivrBundles());
  const workerUrl = URL.createObjectURL(
    new Blob([`importScripts("${bundle.mainWorker}");`], { type: 'text/javascript' })
  );
  const worker = new Worker(workerUrl);
  const db = new duckdb.AsyncDuckDB(new duckdb.VoidLogger(), worker);
  await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
  URL.revokeObjectURL(workerUrl);

  await Promise.all(
    TABLES.map((name) =>
      db.registerFileURL(
        `${name}.parquet`,
        `${DATA_BASE}${name}.parquet`,
        duckdb.DuckDBDataProtocol.HTTP,
        false
      )
    )
  );

  connection = await db.connect();

  // Belt and braces: nothing should reach out for an extension at query time.
  try {
    await connection.query('SET autoinstall_known_extensions=false');
    await connection.query('SET autoload_known_extensions=false');
  } catch {
    // Older builds don't expose these settings; Parquet is linked in anyway.
  }

  return connection;
}

/** Run SQL and return plain JS objects. */
async function sql(query, params = []) {
  const conn = await connect();
  const statement = await conn.prepare(query);
  try {
    const result = await statement.query(...params);
    return result.toArray().map((row) => {
      const object = row.toJSON();
      // Arrow hands back BigInt for 64-bit ints; JSON and Chart.js both choke on it.
      for (const [key, value] of Object.entries(object)) {
        if (typeof value === 'bigint') object[key] = Number(value);
      }
      return object;
    });
  } finally {
    await statement.close();
  }
}

/** Release metadata: version, row counts, generation date. */
export async function dataVersion() {
  if (!manifest) {
    const response = await fetch(`${DATA_BASE}manifest.json`);
    if (!response.ok) throw new Error(`manifest.json: HTTP ${response.status}`);
    manifest = await response.json();
  }
  return manifest;
}

/** Every leader, with per-leader totals. Used to populate the filters. */
export async function queryLeaders() {
  return sql(`
    SELECT leader_id, name, handle, country, country_iso3, office,
           n_tweets, first_tweet, last_tweet, mean_engagement,
           source_id_reliable, has_sentiment
    FROM 'leaders.parquet'
    ORDER BY name
  `);
}

/**
 * Build the shared WHERE clause. Returns { clause, params } so every query
 * below filters identically and the table, charts and count can never disagree.
 */
function where(filters = {}, prefix = '') {
  const { leader, country, startDate, endDate, minEngagement, search } = filters;
  const col = (name) => `${prefix}${name}`;
  const clauses = [];
  const params = [];
  if (leader) { clauses.push(`${col('leader_id')} = ?`); params.push(leader); }
  if (country) { clauses.push(`${col('country')} = ?`); params.push(country); }
  if (startDate) { clauses.push(`${col('date')} >= CAST(? AS DATE)`); params.push(startDate); }
  if (endDate) { clauses.push(`${col('date')} <= CAST(? AS DATE)`); params.push(endDate); }
  if (minEngagement) {
    clauses.push(`${col('engagement')} >= ?`);
    params.push(Number(minEngagement));
  }
  if (search) { clauses.push(`${col('text')} ILIKE ?`); params.push(`%${search}%`); }
  return { clause: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params };
}

/** A page of tweets matching the filters, plus the total row count. */
export async function queryTweets(filters = {}, { limit = 50, offset = 0 } = {}) {
  const bare = where(filters);
  const qualified = where(filters, 't.');

  const [{ total }] = await sql(
    `SELECT COUNT(*) AS total FROM 'tweets.parquet' ${bare.clause}`, bare.params
  );
  const rows = await sql(`
    SELECT t.tweet_uid, l.name AS leader, t.country, t.created_at, t.lang, t.text,
           t.retweet_count, t.reply_count, t.like_count, t.quote_count, t.engagement
    FROM 'tweets.parquet' t
    JOIN 'leaders.parquet' l ON l.leader_id = t.leader_id
    ${qualified.clause}
    ORDER BY t.created_at DESC
    LIMIT ${Number(limit)} OFFSET ${Number(offset)}
  `, qualified.params);

  return { rows, total };
}

/** Monthly tweet counts and mean engagement under the current filters. */
export async function queryVolume(filters = {}) {
  const { clause, params } = where(filters);
  // Truncate the DATE column, not created_at: created_at is TIMESTAMP WITH
  // TIME ZONE and date_trunc has no overload for it in DuckDB-Wasm. Using
  // `date` also means the query never has to read the timestamp column.
  return sql(`
    SELECT date_trunc('month', date) AS month,
           COUNT(*) AS tweets,
           ROUND(AVG(engagement), 1) AS mean_engagement
    FROM 'tweets.parquet'
    ${clause}
    GROUP BY 1
    ORDER BY 1
  `, params);
}

/** Mean engagement per tweet by leader, highest first. */
export async function queryEngagementByLeader(filters = {}, { limit = 15 } = {}) {
  const { clause, params } = where(filters, 't.');
  return sql(`
    SELECT l.name AS leader, l.country,
           COUNT(*) AS tweets,
           ROUND(AVG(t.engagement), 0) AS mean_engagement
    FROM 'tweets.parquet' t
    JOIN 'leaders.parquet' l ON l.leader_id = t.leader_id
    ${clause}
    GROUP BY 1, 2
    HAVING COUNT(*) >= 25
    ORDER BY mean_engagement DESC
    LIMIT ${Number(limit)}
  `, params);
}

/** Headline totals for the stat row. */
export async function querySummary(filters = {}) {
  const { clause, params } = where(filters);
  // SUM over BIGINT widens to HUGEINT, which arrives as a 128-bit value that
  // survives the BigInt coercion in sql() and then blows up in arithmetic.
  // Cast it down in SQL where the width is known.
  const [row] = await sql(`
    SELECT COUNT(*) AS tweets,
           COUNT(DISTINCT leader_id) AS leaders,
           CAST(SUM(engagement) AS DOUBLE) AS engagement,
           MIN(date) AS first_date,
           MAX(date) AS last_date
    FROM 'tweets.parquet'
    ${clause}
  `, params);
  return row;
}

/** Escape hatch for the SQL console. */
export async function runSql(query) {
  return sql(query);
}
