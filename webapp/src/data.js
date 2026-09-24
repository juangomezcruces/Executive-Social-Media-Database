/**
 * Client for the Executive Social Media Database API.
 *
 * The browser no longer holds the data. Earlier versions shipped the whole
 * Parquet corpus to every visitor and queried it with DuckDB-Wasm, which meant
 * anyone who opened the page had already downloaded the dataset. Row-level
 * access now goes through the Worker, which caps anonymous requests at 100
 * rows; the full tables are behind a free key.
 *
 * Two rules shape everything below:
 *
 *  1. The database runs on a metered free plan and *fails* once the allowance
 *     is spent. So the summary and both charts are computed in this file from
 *     one small precomputed object (`/v1/volume`, ~75 KB gzipped, cached for
 *     an hour), not from queries. Changing a filter redraws the charts without
 *     touching the database at all.
 *  2. That object is monthly and has no text column, so it cannot answer a
 *     text search or a minimum-engagement filter. Those two apply to the
 *     results table only, and the UI says so rather than quietly showing
 *     numbers that disagree with the table beneath them.
 */

import { apiBase, API_CONFIGURED } from './config.js';

const KEY_STORAGE = 'esmd.api_key';

/** Anonymous ceilings, mirrored from the Worker so the UI can explain them. */
export const LIMITS = {
  rows: 100,
  offset: 1_000,
  keyedRows: 1_000,
  keyedOffset: 1_000_000,
};

export class ApiError extends Error {
  constructor(message, { status = 0, hint = null } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.hint = hint;
  }
}

// ---------------------------------------------------------------------------
// the key
// ---------------------------------------------------------------------------

/**
 * Keys live in this browser's local storage and nowhere else. They are not
 * secrets in the password sense — they are free, read-only, and identify a
 * researcher rather than authorise a purchase — but they are still the
 * holder's, so they never leave this origin.
 */
export function getKey() {
  try {
    return localStorage.getItem(KEY_STORAGE) || null;
  } catch {
    return null; // private browsing, or storage blocked
  }
}

export function setKey(value) {
  try {
    if (value) localStorage.setItem(KEY_STORAGE, value.trim());
    else localStorage.removeItem(KEY_STORAGE);
  } catch {
    // Nothing to do: the session simply stays anonymous.
  }
}

export const hasKey = () => Boolean(getKey());

// ---------------------------------------------------------------------------
// transport
// ---------------------------------------------------------------------------

async function api(path, { method = 'GET', body = null, signal = null } = {}) {
  if (!API_CONFIGURED && apiBase().includes('REPLACE-ME')) {
    throw new ApiError('The API address has not been set yet.', {
      hint: 'Edit webapp/src/config.js with the deployed Worker URL — see api/DEPLOY.md.',
    });
  }

  const headers = {};
  const key = getKey();
  if (key) headers.Authorization = `Bearer ${key}`;
  if (body) headers['Content-Type'] = 'application/json';

  let response;
  try {
    response = await fetch(`${apiBase()}${path}`, {
      method, headers, signal,
      body: body ? JSON.stringify(body) : null,
    });
  } catch (error) {
    if (error.name === 'AbortError') throw error;
    throw new ApiError('Could not reach the API.', { hint: error.message });
  }

  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new ApiError(`The API returned a non-JSON response (HTTP ${response.status}).`,
      { status: response.status });
  }

  if (!response.ok) {
    throw new ApiError(payload.error || `HTTP ${response.status}`, {
      status: response.status,
      hint: payload.hint || null,
    });
  }
  return payload;
}

/** Cache the objects that never change within a page view. */
const once = new Map();
function cached(path, loader) {
  if (!once.has(path)) {
    const promise = loader().catch((error) => {
      once.delete(path);   // a failure must not be cached forever
      throw error;
    });
    once.set(path, promise);
  }
  return once.get(path);
}

// ---------------------------------------------------------------------------
// reference data
// ---------------------------------------------------------------------------

/** Current release: version, row counts, generation date. */
export const getManifest = () => cached('manifest', () => api('/manifest'));

/** Headline totals for the whole corpus, precomputed. */
export const getSummary = () => cached('summary', () => api('/summary'));

/** All 62 leaders. Drives the filters and the id → name mapping. */
export const getLeaders = () =>
  cached('leaders', async () => (await api('/leaders')).rows);

/** Monthly totals per leader. The source for every number the API never sees. */
export const getVolume = () => cached('volume', () => api('/volume'));

/** Which languages each country actually tweets in, and the fallback set. */
export const getLanguages = () => cached('languages', () => api('/languages'));

/**
 * Ask for related search terms, in the languages given.
 *
 * Never throws for the caller's purposes: the endpoint answers with the
 * original term and `degraded: true` if the model is unavailable, and a
 * network failure is turned into the same shape here, so a search is never
 * blocked by the expansion failing.
 */
export async function expandTerm(term, langs = []) {
  const params = new URLSearchParams({ q: term });
  if (langs.length) params.set('langs', langs.join(','));
  try {
    return await api(`/expand?${params}`);
  } catch (error) {
    return { term, langs, terms: [term], degraded: true, reason: error.message };
  }
}

// ---------------------------------------------------------------------------
// row-level queries
// ---------------------------------------------------------------------------

/** Turn the UI's filter object into query parameters the Worker understands. */
function toParams(filters = {}) {
  const {
    leaders = [], countries = [], startDate, endDate,
    minEngagement, search, also = [], excludeReplies,
  } = filters;
  const params = new URLSearchParams();
  if (leaders.length) params.set('leader', leaders.join(','));
  if (countries.length) params.set('country', countries.join(','));
  if (startDate) params.set('start', startDate);
  if (endDate) params.set('end', endDate);
  if (minEngagement) params.set('min_engagement', String(Math.trunc(minEngagement)));
  if (search) params.set('q', search);
  if (also.length) params.set('also', also.join(','));
  if (excludeReplies) params.set('exclude_replies', 'true');
  return params;
}

/** One page of tweets. The Worker decides the real limit; we ask politely. */
export async function queryTweets(
  filters = {},
  { limit = 50, offset = 0, sort = 'created_at', direction = 'desc', signal = null } = {},
) {
  const params = toParams(filters);
  params.set('limit', String(limit));
  params.set('offset', String(offset));
  params.set('sort', sort);
  params.set('direction', direction);
  return api(`/tweets?${params}`, { signal });
}

/**
 * How many rows match. Counting is the one operation that can get expensive,
 * so the Worker stops at 10,000 and reports `exact: false` past that.
 */
export async function queryCount(filters = {}, { signal = null } = {}) {
  return api(`/count?${toParams(filters)}`, { signal });
}

/** Read-only SELECT. Key holders only; the Worker enforces that, not this. */
export async function runSql(sql, { signal = null } = {}) {
  return api('/sql', { method: 'POST', body: { sql }, signal });
}

/** Where a key holder gets the full tables. */
export function downloadUrl(table, format) {
  return `${apiBase()}/download/${table}.${format}`;
}

/**
 * Fetch a full table with the stored key and hand back a blob URL.
 *
 * A plain link cannot carry an Authorization header, so the download has to go
 * through fetch. The file is large, so the caller gets progress-free but
 * honest behaviour: it either arrives or it throws.
 */
export async function downloadTable(table, format) {
  const key = getKey();
  if (!key) throw new ApiError('An API key is required for full-table downloads.');
  const response = await fetch(downloadUrl(table, format), {
    headers: { Authorization: `Bearer ${key}` },
  });
  if (!response.ok) {
    let message = `HTTP ${response.status}`;
    try { message = (await response.json()).error || message; } catch { /* keep it */ }
    throw new ApiError(message, { status: response.status });
  }
  return { blob: await response.blob(), filename: `${table}.${format}` };
}

// ---------------------------------------------------------------------------
// aggregates, computed here from the precomputed monthly object
// ---------------------------------------------------------------------------

/** Filters the monthly object can honour. The other two cannot be applied. */
export function chartableFilters(filters = {}) {
  return {
    leaders: filters.leaders || [],
    countries: filters.countries || [],
    startDate: filters.startDate || null,
    endDate: filters.endDate || null,
    excludeReplies: Boolean(filters.excludeReplies),
  };
}

const startsMidMonth = (date) => Boolean(date) && !date.endsWith('-01');

/** The last day of a month is not partial; any earlier day is. */
function endsMidMonth(date) {
  if (!date) return false;
  const [year, month, day] = date.split('-').map(Number);
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return day !== lastDay;
}

/** True when a filter is set that the charts and summary cannot reflect. */
export function hasUnchartableFilter(filters = {}) {
  return Boolean(filters.search) || Boolean(filters.minEngagement);
}

/**
 * Everything the stat row and both charts need, under the current selection.
 *
 * Costs zero database rows: it is arithmetic over ~5,200 precomputed records
 * that the browser already has. `monthly` and `byLeader` are two views of the
 * same filtered set, so the charts can never disagree with each other or with
 * the totals above them.
 */
export async function queryAggregates(filters = {}) {
  const [volume, leaders] = await Promise.all([getVolume(), getLeaders()]);
  const countryOf = new Map(leaders.map((l) => [l.leader_id, l.country]));
  const nameOf = new Map(leaders.map((l) => [l.leader_id, l.name]));

  const wanted = filters.leaders?.length ? new Set(filters.leaders) : null;
  const countries = filters.countries?.length ? new Set(filters.countries) : null;
  // The object is monthly, so a date range is applied at month resolution.
  const from = filters.startDate ? filters.startDate.slice(0, 7) : null;
  const to = filters.endDate ? filters.endDate.slice(0, 7) : null;
  const broadcast = Boolean(filters.excludeReplies);

  const months = new Map();
  const perLeader = new Map();
  let tweets = 0;
  let engagement = 0;
  let replies = 0;

  for (const row of volume) {
    if (wanted && !wanted.has(row.leader_id)) continue;
    if (countries && !countries.has(countryOf.get(row.leader_id))) continue;
    if (from && row.month < from) continue;
    if (to && row.month > to) continue;

    const n = broadcast ? row.broadcast : row.tweets;
    if (!n) continue;
    const e = broadcast ? row.engagement_broadcast : row.engagement;

    tweets += n;
    engagement += e;
    if (!broadcast) replies += row.tweets - row.broadcast;

    const month = months.get(row.month) || { month: row.month, tweets: 0, engagement: 0 };
    month.tweets += n;
    month.engagement += e;
    months.set(row.month, month);

    const leader = perLeader.get(row.leader_id)
      || { leader_id: row.leader_id, leader: nameOf.get(row.leader_id) || row.leader_id,
           country: countryOf.get(row.leader_id) || '', tweets: 0, engagement: 0 };
    leader.tweets += n;
    leader.engagement += e;
    perLeader.set(row.leader_id, leader);
  }

  const monthly = [...months.values()].sort((a, b) => a.month.localeCompare(b.month));
  const byLeader = [...perLeader.values()]
    .map((l) => ({ ...l, mean_engagement: Math.round(l.engagement / l.tweets) }));

  return {
    monthly,
    byLeader,
    totals: {
      tweets,
      engagement,
      replies,
      leaders: perLeader.size,
      firstMonth: monthly.length ? monthly[0].month : null,
      lastMonth: monthly.length ? monthly[monthly.length - 1].month : null,
      // A range that starts or ends mid-month pulls in those whole months.
      partialMonths: startsMidMonth(filters.startDate) || endsMidMonth(filters.endDate),
    },
  };
}
