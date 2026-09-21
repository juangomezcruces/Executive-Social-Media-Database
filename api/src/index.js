/**
 * Executive Social Media Database — public API.
 *
 * Two tiers, deliberately:
 *
 *   anonymous   capped at MAX_ROWS rows per request. Enough to browse, search
 *               and chart; useless for wholesale copying.
 *   key holders the full Parquet and CSV tables, streamed from R2, with every
 *               download logged against the key.
 *
 * The cap is only meaningful because the underlying files are NOT public.
 * If data/*.parquet is ever committed to a public repo again, or attached to a
 * public release, this Worker becomes decoration.
 *
 * Budget note: the database sits on a free plan with a monthly allowance of
 * rows read, and queries fail once it is spent. Every query below is either
 * bounded by an index range or served from a precomputed object in R2. Do not
 * add an endpoint that scans `tweets` without an index.
 */

import { createClient, DatabaseError } from './db.js';

const MAX_ROWS = 100;          // hard ceiling for anonymous row-level access
const MAX_SQL_ROWS = 1000;     // key holders, via the SQL endpoint
const COUNT_CEILING = 10000;   // stop counting past this; report "10000+"

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  'Access-Control-Max-Age': '86400',
};

const json = (body, status = 200, extra = {}) =>
  new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS, ...extra },
  });

const fail = (status, message, hint) =>
  json({ error: message, ...(hint ? { hint } : {}) }, status);

// ---------------------------------------------------------------------------
// keys
// ---------------------------------------------------------------------------

async function sha256Hex(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Resolve the bearer token to a live key row, or null. */
async function authenticate(request, db) {
  const header = request.headers.get('Authorization') || '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) return null;
  const hash = await sha256Hex(match[1].trim());
  const row = await db.prepare(
    'SELECT key_hash, label, revoked_at FROM api_keys WHERE key_hash = ?'
  ).bind(hash).first();
  if (!row || row.revoked_at) return null;
  return row;
}

// ---------------------------------------------------------------------------
// query building
// ---------------------------------------------------------------------------

/** Columns a caller may order by, mapped to real SQL. Never interpolate input. */
const SORTABLE = {
  created_at: 'created_at',
  engagement: 'engagement',
  retweet_count: 'retweet_count',
  reply_count: 'reply_count',
  like_count: 'like_count',
  quote_count: 'quote_count',
  leader: 'leader_id',
};

const listParam = (params, name) =>
  params.getAll(name).flatMap((v) => v.split(',')).map((v) => v.trim()).filter(Boolean);

function buildWhere(params, prefix = '') {
  const col = (name) => `${prefix}${name}`;
  const clauses = [];
  const binds = [];

  const leaders = listParam(params, 'leader');
  if (leaders.length) {
    if (leaders.length > 100) throw new RangeError('too many leader values');
    clauses.push(`${col('leader_id')} IN (${leaders.map(() => '?').join(',')})`);
    binds.push(...leaders);
  }
  const countries = listParam(params, 'country');
  if (countries.length) {
    if (countries.length > 100) throw new RangeError('too many country values');
    clauses.push(`${col('country')} IN (${countries.map(() => '?').join(',')})`);
    binds.push(...countries);
  }
  const start = params.get('start');
  if (start) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(start)) throw new RangeError('start must be YYYY-MM-DD');
    clauses.push(`${col('date')} >= ?`); binds.push(start);
  }
  const end = params.get('end');
  if (end) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(end)) throw new RangeError('end must be YYYY-MM-DD');
    clauses.push(`${col('date')} <= ?`); binds.push(end);
  }
  const min = params.get('min_engagement');
  if (min) {
    if (!/^\d+$/.test(min)) throw new RangeError('min_engagement must be a whole number');
    clauses.push(`${col('engagement')} >= ?`); binds.push(Number(min));
  }
  if (params.get('exclude_replies') === 'true') clauses.push(`${col('is_reply')} = 0`);
  if (params.get('exclude_deleted') === 'true') {
    clauses.push(`COALESCE(${col('is_deleted')}, 0) = 0`);
  }

  return { where: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', binds };
}

// ---------------------------------------------------------------------------
// endpoints
// ---------------------------------------------------------------------------

async function getLeaders(db) {
  // 62 rows, no filter: the cheapest query in the API and the one the UI needs
  // on every page load. Cached hard at the edge.
  const { results } = await db.prepare(
    `SELECT leader_id, name, handle, country, country_iso3, office, n_tweets,
            first_tweet, last_tweet, mean_engagement,
            source_id_reliable, has_sentiment, populist
     FROM leaders ORDER BY name`
  ).all();
  return json({ rows: results, count: results.length },
    200, { 'Cache-Control': 'public, max-age=3600' });
}

async function getTweets(db, params, authed) {
  const ceiling = authed ? MAX_SQL_ROWS : MAX_ROWS;
  const requested = Number(params.get('limit') || 50);
  if (!Number.isInteger(requested) || requested < 1) {
    return fail(400, 'limit must be a positive whole number');
  }
  const limit = Math.min(requested, ceiling);
  const offset = Math.max(0, Number(params.get('offset') || 0));
  if (!Number.isInteger(offset)) return fail(400, 'offset must be a whole number');

  // Offset paging is what makes a cap circumventable, so it is bounded too.
  // Anyone who needs to walk the whole corpus should be using a key and the
  // bulk download, not 5,000 sequential requests.
  const maxOffset = authed ? 1_000_000 : 1_000;
  if (offset > maxOffset) {
    return fail(400, `offset above ${maxOffset} is not available`,
      'Request an API key for full-table access: see the repository README.');
  }

  const sort = SORTABLE[params.get('sort')] || SORTABLE.created_at;
  const direction = (params.get('direction') || 'desc').toLowerCase() === 'asc' ? 'ASC' : 'DESC';
  const search = (params.get('q') || '').trim();

  let sql, binds;
  if (search) {
    if (search.length > 200) return fail(400, 'q is too long');
    // FTS5 first, then filter: reads only matching rows rather than scanning.
    // The filter columns are qualified up front rather than rewritten with a
    // regex afterwards -- that trick silently mangles anything it half-matches.
    let qualified;
    try { qualified = buildWhere(params, 't.'); }
    catch (error) { return fail(400, error.message); }
    const extra = qualified.where ? qualified.where.replace(/^WHERE /, ' AND ') : '';
    sql = `SELECT t.tweet_uid, t.leader_id, t.country, t.created_at, t.date, t.lang, t.text,
                  t.retweet_count, t.reply_count, t.like_count, t.quote_count,
                  t.engagement, t.is_reply, t.is_deleted, t.source_tweet_id
           FROM tweets_fts f
           JOIN tweets t ON t.rowid = f.rowid
           WHERE tweets_fts MATCH ?${extra}
           ORDER BY t.${sort} ${direction}, t.tweet_uid ASC
           LIMIT ? OFFSET ?`;
    binds = [ftsQuery(search), ...qualified.binds, limit, offset];
  } else {
    let bare;
    try { bare = buildWhere(params); }
    catch (error) { return fail(400, error.message); }
    const { where } = bare;
    sql = `SELECT tweet_uid, leader_id, country, created_at, date, lang, text,
                  retweet_count, reply_count, like_count, quote_count,
                  engagement, is_reply, is_deleted, source_tweet_id
           FROM tweets ${where}
           ORDER BY ${sort} ${direction}, tweet_uid ASC
           LIMIT ? OFFSET ?`;
    binds = [...bare.binds, limit, offset];
  }

  const { results } = await db.prepare(sql).bind(...binds).all();
  return json({
    rows: results,
    count: results.length,
    limit,
    offset,
    capped: requested > ceiling ? ceiling : null,
    bulk: authed ? undefined :
      'Anonymous access is capped at 100 rows per request. Full tables are available with a free API key — see the repository README.',
  }, 200, { 'Cache-Control': 'public, max-age=300' });
}

/** Turn user text into a safe FTS5 MATCH expression (quoted phrase). */
function ftsQuery(text) {
  const cleaned = text.replace(/["']/g, ' ').trim();
  return `"${cleaned}"`;
}

async function getCount(db, params) {
  let where, binds;
  try { ({ where, binds } = buildWhere(params)); }
  catch (error) { return fail(400, error.message); }
  // Counting is the expensive operation, so it stops at a ceiling. The UI
  // shows "10,000+" rather than an exact total; the exact figure for the whole
  // corpus lives in the precomputed summary.
  const sql = `SELECT COUNT(*) AS n FROM (
                 SELECT 1 FROM tweets ${where} LIMIT ${COUNT_CEILING + 1}
               )`;
  const row = await db.prepare(sql).bind(...binds).first();
  return json({
    count: Math.min(row.n, COUNT_CEILING),
    exact: row.n <= COUNT_CEILING,
  }, 200, { 'Cache-Control': 'public, max-age=300' });
}

/** Aggregates are precomputed at export time and served from R2: zero query cost. */
async function getStatic(env, name) {
  const object = await env.BUCKET.get(`public/${name}.json`);
  if (!object) return fail(404, `${name} is not published yet`);
  return new Response(object.body, {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'public, max-age=3600',
      ...CORS,
    },
  });
}

const DOWNLOADABLE = new Set(['tweets', 'leaders', 'sentiment']);

async function download(request, env, db, ctx, key, table, format) {
  if (!DOWNLOADABLE.has(table)) return fail(404, `unknown table ${table}`);
  if (!['parquet', 'csv'].includes(format)) return fail(404, `unknown format ${format}`);

  const object = await env.BUCKET.get(`private/${table}.${format}`);
  if (!object) return fail(404, `${table}.${format} is not published yet`);

  // Logged after the response is handed back, so it never delays the download.
  ctx.waitUntil(db.prepare(
    `INSERT INTO download_log (key_hash, table_name, format, at, country, user_agent)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).bind(
    key.key_hash, table, format, new Date().toISOString(),
    request.cf?.country ?? null,
    (request.headers.get('User-Agent') || '').slice(0, 300),
  ).run());

  return new Response(object.body, {
    headers: {
      'Content-Type': format === 'parquet' ? 'application/vnd.apache.parquet' : 'text/csv',
      'Content-Disposition': `attachment; filename="${table}.${format}"`,
      'Cache-Control': 'private, no-store',
      ...CORS,
    },
  });
}

/** Read-only SQL, key holders only. Guarded, capped, and still index-bound. */
async function runSql(request, db) {
  let body;
  try { body = await request.json(); }
  catch { return fail(400, 'expected a JSON body of {"sql": "..."}'); }
  const sql = String(body.sql || '').trim().replace(/;+\s*$/, '');
  if (!sql) return fail(400, 'sql is required');
  if (!/^select\s/i.test(sql)) return fail(400, 'only SELECT statements are allowed');
  if (/;/.test(sql)) return fail(400, 'only a single statement is allowed');
  if (/\b(attach|pragma|insert|update|delete|drop|alter|create|replace)\b/i.test(sql)) {
    return fail(400, 'only read-only SELECT statements are allowed');
  }
  const capped = /\blimit\b/i.test(sql) ? sql : `${sql} LIMIT ${MAX_SQL_ROWS}`;
  try {
    const { results } = await db.prepare(capped).all();
    return json({ rows: results.slice(0, MAX_SQL_ROWS), count: results.length });
  } catch (error) {
    return fail(400, `query failed: ${error.message}`);
  }
}

// ---------------------------------------------------------------------------
// router
// ---------------------------------------------------------------------------

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const params = url.searchParams;

    try {
      // One client per request: it holds no connection, only the address and
      // the token, so there is nothing to pool.
      const db = createClient(env);
      if (path === '/' || path === '/v1') {
        return json({
          dataset: 'Executive Social Media Database',
          docs: 'https://github.com/juangomezcruces/Executive-Social-Media-Database',
          anonymous_row_cap: MAX_ROWS,
          endpoints: {
            'GET /v1/leaders': 'every leader (62 rows)',
            'GET /v1/tweets': `filtered tweets, max ${MAX_ROWS} rows anonymously`,
            'GET /v1/count': `matching row count, capped at ${COUNT_CEILING}`,
            'GET /v1/summary': 'precomputed totals',
            'GET /v1/volume': 'precomputed monthly volume per leader',
            'GET /v1/engagement': 'precomputed mean engagement per leader',
            'GET /v1/manifest': 'current data release',
            'GET /v1/download/{table}.{parquet|csv}': 'full table — API key required',
            'POST /v1/sql': 'read-only SELECT — API key required',
          },
          keys: 'Free for research use. Request one via the repository README.',
        }, 200, { 'Cache-Control': 'public, max-age=3600' });
      }

      if (path === '/v1/leaders') return await getLeaders(db);
      if (path === '/v1/count') return await getCount(db, params);
      if (['/v1/summary', '/v1/volume', '/v1/engagement', '/v1/manifest'].includes(path)) {
        return await getStatic(env, path.split('/').pop());
      }

      if (path === '/v1/tweets') {
        const key = await authenticate(request, db);
        return await getTweets(db, params, key);
      }

      if (path === '/v1/sql' && request.method === 'POST') {
        const key = await authenticate(request, db);
        if (!key) return fail(401, 'an API key is required for SQL access',
          'Send it as: Authorization: Bearer <key>');
        return await runSql(request, db);
      }

      const match = path.match(/^\/v1\/download\/(\w+)\.(\w+)$/);
      if (match) {
        const key = await authenticate(request, db);
        if (!key) {
          return fail(401, 'an API key is required for full-table downloads',
            'Keys are free for research use — see the repository README. ' +
            `Anonymous access is capped at ${MAX_ROWS} rows per request.`);
        }
        return await download(request, env, db, ctx, key, match[1], match[2]);
      }

      return fail(404, `no such endpoint: ${path}`);
    } catch (error) {
      // The database refuses queries once the free-tier allowance is spent;
      // say so plainly rather than returning an opaque 500.
      const message = String(error?.message || error);
      if (error instanceof DatabaseError && /limit|quota|exceeded|blocked/i.test(message)) {
        return fail(503, 'the database has hit its usage allowance',
          'This is a monthly quota. Full tables are available to key holders '
          + 'as a single download, which does not touch the database.');
      }
      if (error instanceof DatabaseError && /not configured/i.test(message)) {
        return fail(503, 'the API is not finished being set up');
      }
      return fail(500, 'unexpected error', message.slice(0, 200));
    }
  },
};
