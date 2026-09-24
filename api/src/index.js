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
const MAX_EXPANSION_TERMS = 24; // ceiling on an OR-ed search, original included
// Bumped when the prompt or the reply's shape changes, and mixed into the cache
// key so a rewritten prompt does not keep serving answers from the old one.
const EXPAND_VERSION = 3;
// How many of each kind survive into the query. Concepts are the point, so they
// get the largest share; translations are per language and are capped again by
// the total above.
const EXPAND_CAPS = { synonyms: 4, related: 10, translations: 3 };
// Chosen for two properties: it is current, and it supports JSON mode, so the
// reply can be held to a schema rather than merely requested in prose. Two
// earlier picks failed on exactly those points -- llama-3.1-8b-instruct-fp8-fast
// has no JSON mode and returned prose, and llama-3.1-8b-instruct was retired in
// May 2026 and the call simply threw.
//
// About 50 neurons a call (400 tokens in, 250 out) against a free allowance of
// 10,000 a day: roughly 200 fresh terms daily, and repeats are free because
// every answer is cached in R2. If that ceiling is ever a problem,
// '@cf/qwen/qwen3-30b-a3b-fp8' costs about 5 neurons and is strong
// multilingually, but has no JSON mode -- the fallback below would carry it.
const EXPAND_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';

/**
 * The shape the model is held to, so the reply cannot be prose.
 *
 * Three lists rather than one, because they are three different things and the
 * caller should be able to see which is which and drop a whole kind. `related`
 * is the interesting one: not other words for the term, but the vocabulary
 * around it -- housing brings mortgage, rent, eviction, homelessness.
 */
const EXPAND_SCHEMA = {
  type: 'object',
  properties: {
    synonyms: { type: 'array', items: { type: 'string' } },
    related: { type: 'array', items: { type: 'string' } },
    translations: { type: 'array', items: { type: 'string' } },
  },
  required: ['synonyms', 'related', 'translations'],
};

/** The order the groups are offered in, and the order they enter the query. */
const EXPAND_GROUPS = ['synonyms', 'related', 'translations'];

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
  // Extra terms the caller chose, from /v1/expand. Passed explicitly rather
  // than expanded here on purpose: /v1/tweets stays a deterministic function
  // of its parameters, so a result someone cites can be reproduced exactly.
  const also = listParam(params, 'also').slice(0, MAX_EXPANSION_TERMS);

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
    binds = [ftsQuery(search, also), ...qualified.binds, limit, offset];
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

/**
 * Turn user text into a safe FTS5 MATCH expression.
 *
 * Every term becomes a quoted phrase, which neutralises FTS5's own operators
 * -- a term like `AND` or `climate*` is matched literally rather than changing
 * the shape of the query. Extra terms from /v1/expand are OR-ed in, so a
 * search for "climate" can also reach `clima` and `mudança climática`.
 */
function ftsQuery(text, extra = []) {
  const phrase = (value) => `"${String(value).replace(/["']/g, ' ').trim()}"`;
  const terms = [text, ...extra]
    .map((t) => String(t).trim())
    .filter(Boolean)
    .filter((t, i, all) => all.findIndex((o) => o.toLowerCase() === t.toLowerCase()) === i)
    .slice(0, MAX_EXPANSION_TERMS);
  return terms.map(phrase).join(' OR ');
}

async function getCount(db, params) {
  // Counting is the expensive operation, so it stops at a ceiling. The UI
  // shows "10,000+" rather than an exact total; the exact figure for the whole
  // corpus lives in the precomputed summary.
  const search = (params.get('q') || '').trim();
  const also = listParam(params, 'also').slice(0, MAX_EXPANSION_TERMS);

  let sql, binds;
  if (search) {
    // This used to count without the search, so the results header read
    // "10,000+" no matter what was typed. It has to go through the same
    // full-text path as the rows it is counting, or the number describes a
    // different query from the one on screen.
    let qualified;
    try { qualified = buildWhere(params, 't.'); }
    catch (error) { return fail(400, error.message); }
    const extra = qualified.where ? qualified.where.replace(/^WHERE /, ' AND ') : '';
    sql = `SELECT COUNT(*) AS n FROM (
             SELECT 1 FROM tweets_fts f JOIN tweets t ON t.rowid = f.rowid
             WHERE tweets_fts MATCH ?${extra} LIMIT ${COUNT_CEILING + 1}
           )`;
    binds = [ftsQuery(search, also), ...qualified.binds];
  } else {
    let bare;
    try { bare = buildWhere(params); }
    catch (error) { return fail(400, error.message); }
    sql = `SELECT COUNT(*) AS n FROM (
             SELECT 1 FROM tweets ${bare.where} LIMIT ${COUNT_CEILING + 1}
           )`;
    binds = bare.binds;
  }

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

// ---------------------------------------------------------------------------
// query expansion
// ---------------------------------------------------------------------------

/**
 * The fourteen languages the corpus is actually written in, with the names a
 * language model responds to. Anything outside this set is dropped rather than
 * passed through: the prompt is the one place user text reaches the model.
 */
const LANG_NAMES = {
  en: 'English', es: 'Spanish', pt: 'Portuguese', cs: 'Czech', fr: 'French',
  it: 'Italian', nl: 'Dutch', de: 'German', no: 'Norwegian', da: 'Danish',
  ko: 'Korean', ja: 'Japanese', pl: 'Polish', hi: 'Hindi',
};

/**
 * The instruction the whole feature turns on.
 *
 * The first version asked for "near-synonyms and tightly associated words" and
 * got exactly that: housing came back as homes, shelter, dwellings, residence.
 * Restatements of the term find the tweets the term already found. What is
 * wanted is the subject's neighbourhood -- the other things a politician says
 * when they are talking about housing -- so the instruction names that,
 * demonstrates it, and says outright that rewordings do not belong there.
 */
const EXPAND_SYSTEM = [
  'You expand a search term for a research database of tweets by heads of',
  'government and heads of state. Return three lists of search words.',
  '"synonyms": other ways of writing the same thing, including the common',
  'abbreviation or full form if there is one.',
  '"related": different but topically adjacent concepts -- the policy vocabulary',
  'a politician uses when talking about this subject. These are NOT rewordings of',
  'the term; each one names something else in the same subject area. For',
  '"housing": affordable housing, social housing, mortgage, rent, eviction,',
  'homelessness, property tax, building permits, landlords, first-time buyers.',
  'For "inflation": cost of living, prices, interest rates, central bank, wages,',
  'fuel prices, purchasing power.',
  '"translations": for EACH language listed, the term itself AND at least two of',
  'those related concepts, written the way a politician who is a native speaker',
  'would write them -- a natural equivalent, not a word-for-word rendering, with',
  'the correct accents and diacritics. Three entries per language is the minimum,',
  'not the maximum: a leader writing in Portuguese about corruption says',
  '"propina" and "lava jato", not only "corrupção". If no language is listed,',
  'leave this list empty.',
  'Every entry is a single word or a short phrase, lowercase, in no more than',
  'four words. Prefer wording that actually appears in political speech.',
  'No explanations, no numbering, no commentary, no repetition between lists.',
  'Reply with nothing but a JSON object holding those three arrays of strings.',
].join(' ');

/** A term worth spending a model call on: a few real words, nothing exotic. */
function expandable(term) {
  return term.length > 1 && term.length <= 60
    && term.split(/\s+/).length <= 4
    && /^[\p{L}\p{N}][\p{L}\p{N}\s'’\-]*$/u.test(term);
}

const clean = (list) => (Array.isArray(list) ? list : [])
  .filter((t) => typeof t === 'string')
  .map((t) => t.trim()
    .replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '')     // list markers
    .replace(/^["'`\s]+|["'`,.;\s]+$/g, ''))      // stray punctuation
  .filter((t) => t.length > 1 && t.length <= 40 && !/[<>{}[\]\\]/.test(t));

const empty = () => ({ synonyms: [], related: [], translations: [] });

const total = (groups) => EXPAND_GROUPS.reduce((n, g) => n + groups[g].length, 0);

/**
 * Get the three lists out of whatever the model actually said.
 *
 * JSON mode should make the first branch sufficient. The rest exist because it
 * did not, once: a model told to emit JSON will still sometimes produce a
 * numbered list, and losing the whole feature to that would be silly. Anything
 * that arrives ungrouped -- a bare array, a `terms` array, a list in prose --
 * is treated as related concepts, which is what the prompt mostly asks for and
 * the honest label for something whose kind we do not know.
 */
function parseGroups(response) {
  const grouped = (source) => {
    const out = {
      synonyms: clean(source.synonyms),
      related: clean(source.related),
      translations: clean(source.translations),
    };
    return total(out) ? out : null;
  };
  const flat = (list) => {
    const terms = clean(list);
    return terms.length ? { ...empty(), related: terms } : null;
  };

  if (response && typeof response === 'object') {
    if (Array.isArray(response)) return flat(response) || empty();
    return grouped(response) || flat(response.terms) || empty();
  }

  const text = String(response ?? '');
  if (!text.trim()) return empty();

  const object = text.match(/\{[\s\S]*\}/);
  if (object) {
    try {
      const parsed = JSON.parse(object[0]);
      const found = grouped(parsed) || flat(parsed?.terms);
      if (found) return found;
    } catch { /* fall through */ }
  }
  const array = text.match(/\[[\s\S]*\]/);
  if (array) {
    try {
      const found = flat(JSON.parse(array[0]));
      if (found) return found;
    } catch { /* fall through */ }
  }

  // Last resort: one term per line, or a single comma-separated line.
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const listy = lines.filter((l) => /^\s*(?:[-*•]|\d+[.)])\s/.test(l) || lines.length > 2);
  if (listy.length >= 2) return flat(listy.slice(0, 24)) || empty();
  if (lines.length === 1 && lines[0].includes(',')) {
    return flat(lines[0].split(',').slice(0, 24)) || empty();
  }
  return empty();
}

/**
 * Trim the three lists down to something a search can carry: the original term
 * always leads, nothing repeats across the groups, each kind has its own
 * ceiling, and the whole thing stops at MAX_EXPANSION_TERMS.
 *
 * Translations are capped per language rather than in total, because a search
 * across six countries needs more of them than a search across one -- and the
 * overall ceiling still has the last word.
 */
function budget(term, groups, langs) {
  const seen = new Set([term.toLowerCase()]);
  const out = empty();

  const caps = {
    ...EXPAND_CAPS,
    translations: Math.max(EXPAND_CAPS.translations * Math.max(langs.length, 1), 3),
  };

  for (const group of EXPAND_GROUPS) {
    for (const candidate of groups[group]) {
      if (out[group].length >= caps[group]) break;
      const fold = candidate.toLowerCase();
      if (seen.has(fold)) continue;
      seen.add(fold);
      out[group].push(candidate);
    }
  }

  // Those caps can overshoot together -- seven languages allow twenty-one
  // translations on their own. Trim the longest list rather than whichever
  // happens to come last, because filling in order starves the translations
  // exactly when many languages are selected, which is when they matter most.
  while (total(out) > MAX_EXPANSION_TERMS - 1) {
    const longest = EXPAND_GROUPS.reduce((a, b) => (out[b].length > out[a].length ? b : a));
    out[longest].pop();
  }
  return out;
}

/**
 * Suggest extra search terms for a word, in the languages of whatever the
 * caller has selected.
 *
 * Cached in R2 by term and language set, so the same search costs one model
 * call ever. And it never fails the caller: if the model is unavailable or the
 * day's free allowance is spent, this returns the original term with
 * `degraded: true` and the search carries on as an ordinary keyword search.
 */
async function expandTerm(env, ctx, params) {
  const term = (params.get('q') || '').trim();
  if (!term) return fail(400, 'q is required');

  const langs = listParam(params, 'langs')
    .map((l) => l.toLowerCase())
    .filter((l) => LANG_NAMES[l])
    .filter((l, i, all) => all.indexOf(l) === i)
    .sort()
    .slice(0, 8);

  const base = { term, langs, model: EXPAND_MODEL };
  const asTyped = (extra) =>
    json({ ...base, terms: [term], groups: empty(), degraded: true, ...extra });

  if (!expandable(term)) {
    return asTyped({
      reason: 'that looks like a phrase rather than a term; searched as typed' });
  }

  const digest = await sha256Hex(
    `${EXPAND_VERSION}|${EXPAND_MODEL}|${term.toLowerCase()}|${langs.join(',')}`);
  const key = `cache/expand/${digest}.json`;

  const hit = await env.BUCKET.get(key);
  if (hit) {
    return new Response(await hit.text(), {
      headers: { 'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'public, max-age=86400', ...CORS },
    });
  }

  const messages = [
    { role: 'system', content: EXPAND_SYSTEM },
    { role: 'user', content: `Term: "${term}"\nLanguages: `
        + (langs.length ? langs.map((l) => LANG_NAMES[l]).join(', ') : 'none') },
  ];

  // Ask for schema-constrained output first, and fall back to an unconstrained
  // call if the model or the platform rejects `response_format`. The parser
  // copes with prose, so an unconstrained answer is still usually usable --
  // better than losing the feature over an argument about JSON.
  let groups = empty();
  let reply;
  let detail = null;
  for (const withSchema of [true, false]) {
    // Three lists, and translations grow with the number of languages, so the
    // budget is larger than the single list this replaced.
    const input = { messages, max_tokens: 600, temperature: 0.2 };
    if (withSchema) {
      input.response_format = { type: 'json_schema', json_schema: EXPAND_SCHEMA };
    }
    try {
      reply = await env.AI.run(EXPAND_MODEL, input);
      groups = parseGroups(reply?.response);
      if (total(groups)) break;
    } catch (error) {
      // Keep the first real error: it is the one that explains the failure.
      detail = detail ?? String(error?.message || error).slice(0, 200);
    }
  }

  if (detail && !total(groups)) {
    // Say what actually went wrong. A bare "unavailable" cost a deploy cycle
    // to diagnose, because the reason was thrown away here.
    return asTyped({
      reason: 'the expansion model could not be reached; searched as typed',
      detail });
  }

  if (!total(groups)) {
    // Include what the model actually said, truncated. Without it a failure
    // here is undiagnosable from the outside, which is how the first version
    // of this endpoint wasted an afternoon.
    const sample = (typeof reply?.response === 'string'
      ? reply.response
      : JSON.stringify(reply?.response ?? null)).slice(0, 200);
    return asTyped({
      reason: 'the model returned nothing usable; searched as typed', sample });
  }

  // `terms` stays a flat list with the original leading: it is what `also=`
  // takes and what every existing client reads. `groups` is the same words
  // again, labelled, so the UI can show and drop them by kind.
  const kept = budget(term, groups, langs);
  const all = [term, ...EXPAND_GROUPS.flatMap((g) => kept[g])];

  const body = JSON.stringify(
    { ...base, terms: all, groups: kept, cached_at: new Date().toISOString() }, null, 2);
  ctx.waitUntil(env.BUCKET.put(key, body,
    { httpMetadata: { contentType: 'application/json; charset=utf-8' } }));
  return new Response(body, {
    headers: { 'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'public, max-age=86400', ...CORS },
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
            'GET /v1/expand': 'suggest related search terms, translated into the languages you name',
            'GET /v1/summary': 'precomputed totals',
            'GET /v1/languages': 'which languages each country tweets in',
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
      if (path === '/v1/expand') return await expandTerm(env, ctx, params);
      if (path === '/v1/count') return await getCount(db, params);
      if (['/v1/summary', '/v1/volume', '/v1/engagement', '/v1/manifest',
           '/v1/languages'].includes(path)) {
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
