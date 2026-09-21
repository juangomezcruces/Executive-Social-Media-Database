/**
 * Where the API lives.
 *
 * This is the one line that has to change after `wrangler deploy` — put the
 * Worker's URL here, with the /v1 prefix and no trailing slash, then commit.
 * api/DEPLOY.md walks through it.
 *
 *   export const API_BASE = 'https://esmd-api.jgc.workers.dev/v1';
 *
 * Nothing secret belongs in this file: it is served to every visitor. API keys
 * are typed in by their holder and kept in that browser's local storage.
 */

export const API_BASE = 'https://esmd-api.esmd.workers.dev/v1';

/** True while the placeholder above is still in place. */
export const API_CONFIGURED = !API_BASE.includes('REPLACE-ME');

/**
 * Local development override, set by hand in the browser console:
 *
 *   localStorage.setItem('esmd.api_base', 'http://127.0.0.1:8787/v1')
 *
 * Read from local storage rather than from the query string on purpose: a
 * `?api=` parameter would let anyone hand a visitor a link that points the
 * page — and any API key it holds — at a server of their choosing.
 */
export function apiBase() {
  try {
    return localStorage.getItem('esmd.api_base') || API_BASE;
  } catch {
    return API_BASE;
  }
}
