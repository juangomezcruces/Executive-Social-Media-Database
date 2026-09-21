/**
 * A thin libSQL (Turso) client, shaped like the D1 binding it replaced.
 *
 * Why not D1: loading this dataset costs about 4.5 million row-writes once the
 * seven indexes and the full-text index are counted, and D1's free plan allows
 * 100,000 a day. Turso takes the finished SQLite file in one upload, so the
 * same SQL, the same schema and the same indexes run on a free plan that can
 * actually hold them.
 *
 * The surface is deliberately D1's -- `prepare(sql).bind(...).all()` and
 * friends -- so the endpoint code reads the same as before and the wire
 * protocol stays in this file.
 *
 * Protocol: Hrana over HTTP, POST /v2/pipeline. Every value crosses the wire
 * tagged and, for integers, as a *string*; decoding that back to numbers is
 * this file's main job, because a `engagement` that arrives as "1234" sorts
 * and formats wrongly everywhere downstream and does it silently.
 */

/** Encode one JS value as a Hrana argument. */
function encode(value) {
  if (value === null || value === undefined) return { type: 'null' };
  if (typeof value === 'boolean') return { type: 'integer', value: value ? '1' : '0' };
  if (typeof value === 'bigint') return { type: 'integer', value: value.toString() };
  if (typeof value === 'number') {
    return Number.isInteger(value)
      ? { type: 'integer', value: String(value) }
      : { type: 'float', value };
  }
  return { type: 'text', value: String(value) };
}

/** Decode one Hrana value back to JS. */
function decode(cell) {
  switch (cell?.type) {
    case 'null':
    case undefined:
      return null;
    case 'integer': {
      const asNumber = Number(cell.value);
      // Past 2^53 a JS number would silently lose digits. Nothing in this
      // schema is that large, but returning the string is honest if it ever is.
      return Number.isSafeInteger(asNumber) ? asNumber : cell.value;
    }
    case 'float':
      return Number(cell.value);
    case 'text':
      return cell.value;
    case 'blob':
      return cell.base64 ?? null;
    default:
      return cell.value ?? null;
  }
}

export class DatabaseError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'DatabaseError';
    this.code = code || null;
  }
}

/**
 * Build a client from the Worker's environment.
 *
 * `TURSO_URL` is the database's hostname; the `libsql://` scheme that the
 * Turso CLI prints is the same host over HTTPS, so it is accepted and
 * rewritten rather than left to fail at fetch time.
 */
export function createClient(env) {
  const raw = env.TURSO_URL;
  const token = env.TURSO_TOKEN;
  if (!raw || !token) {
    throw new DatabaseError(
      'the API is not configured: TURSO_URL and TURSO_TOKEN are missing');
  }
  const endpoint = `${raw.replace(/^libsql:/, 'https:').replace(/\/+$/, '')}/v2/pipeline`;

  async function execute(sql, args) {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        requests: [
          { type: 'execute', stmt: { sql, args: args.map(encode) } },
          { type: 'close' },
        ],
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new DatabaseError(
        `database returned HTTP ${response.status}: ${body.slice(0, 200)}`,
        String(response.status));
    }

    const payload = await response.json();
    const first = payload.results?.[0];
    if (!first) throw new DatabaseError('database returned no result');
    if (first.type === 'error') {
      throw new DatabaseError(first.error?.message || 'query failed',
        first.error?.code);
    }

    const result = first.response?.result ?? {};
    const columns = (result.cols || []).map((c) => c.name);
    const rows = (result.rows || []).map((row) => {
      const object = {};
      row.forEach((cell, i) => { object[columns[i]] = decode(cell); });
      return object;
    });
    return { rows, affected: Number(result.affected_row_count || 0) };
  }

  return {
    prepare(sql) {
      let bound = [];
      const statement = {
        bind(...args) { bound = args; return statement; },
        async all() {
          const { rows } = await execute(sql, bound);
          return { results: rows, success: true };
        },
        async first() {
          const { rows } = await execute(sql, bound);
          return rows.length ? rows[0] : null;
        },
        async run() {
          const { affected } = await execute(sql, bound);
          return { success: true, meta: { changes: affected } };
        },
      };
      return statement;
    },
  };
}
