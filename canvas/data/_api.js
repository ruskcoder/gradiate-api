/**
 * The Canvas REST transport: query building, pagination, error mapping and a
 * small concurrency pool. Every data function goes through here so that the
 * Canvas-specific parts of "make a request" exist exactly once.
 *
 * Two things are less obvious than they look:
 *
 *  - The session deliberately does NOT throw on 4xx/5xx (see
 *    `core/auth/token.js`), so `assertOk` is the only thing standing between a
 *    Canvas error body and a data function. Never call `session.get` directly.
 *
 *  - Canvas paginates by `Link` header rather than by offset, and the docs are
 *    explicit that the returned URLs should be treated as opaque and followed.
 *    `apiList` does that, bounded by `MAX_PAGES` and pinned to the instance's
 *    own origin (a bearer header applies to whatever host it is sent to, so
 *    following a link off-instance would leak the token).
 */

import { APIError, AuthenticationError } from '../../core/errors.js';
import { API_BASE, MAX_PAGES, PER_PAGE, ERROR_MESSAGES } from '../config/constants.js';

/**
 * Serialize params the way Canvas expects: repeated `key[]=` entries for arrays
 * (`include[]=term&include[]=teachers`), scalars as-is, empty values dropped.
 */
function toQuery(params) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params || {})) {
    if (value === undefined || value === null || value === '') continue;
    if (Array.isArray(value)) {
      const arrayKey = key.endsWith('[]') ? key : `${key}[]`;
      for (const item of value) {
        if (item === undefined || item === null || item === '') continue;
        search.append(arrayKey, String(item));
      }
    } else if (typeof value === 'boolean') {
      search.append(key, value ? 'true' : 'false');
    } else {
      search.append(key, String(value));
    }
  }
  const query = search.toString();
  return query ? `?${query}` : '';
}

/** Best-effort human message out of whatever shape Canvas used for this error. */
function canvasMessage(data) {
  if (!data) return '';
  if (typeof data === 'string') return data.trim().slice(0, 300);
  if (Array.isArray(data.errors)) {
    return data.errors.map((e) => (typeof e === 'string' ? e : e?.message)).filter(Boolean).join('; ');
  }
  if (data.errors && typeof data.errors === 'object') {
    return Object.values(data.errors)
      .flat()
      .map((e) => (typeof e === 'string' ? e : e?.message))
      .filter(Boolean)
      .join('; ');
  }
  return data.message || data.error || '';
}

/**
 * Turn a non-2xx Canvas response into the right typed error.
 * `what` names the thing being fetched so the message stays actionable.
 */
function assertOk(response, what) {
  const status = response?.status ?? 0;
  if (status >= 200 && status < 300) return response;
  const message = canvasMessage(response?.data);

  if (status === 401) throw new AuthenticationError(message || ERROR_MESSAGES.INVALID_TOKEN);
  if (status === 403) {
    // Canvas reports throttling as a 403 whose body is plain text, not as a 429.
    if (/rate limit/i.test(message)) throw new APIError(ERROR_MESSAGES.RATE_LIMITED, 429);
    throw new AuthenticationError(message || `The access token is not allowed to read ${what}`);
  }
  if (status === 404) throw new APIError(message || `${what} not found`, 404);
  if (status >= 500) throw new APIError(message || `Canvas is unavailable (${status})`, 502);
  throw new APIError(message || `Canvas rejected the request for ${what} (${status})`, 400);
}

/** The `rel="next"` URL from a `Link` header, or null when this was the last page. */
function nextPageUrl(headers) {
  const raw = headers?.link ?? headers?.Link;
  if (!raw) return null;
  for (const part of String(raw).split(',')) {
    const match = /<([^>]+)>\s*;\s*rel\s*=\s*"?([^";]+)"?/.exec(part.trim());
    if (match && match[2].trim() === 'next') return match[1];
  }
  return null;
}

function sameOrigin(a, b) {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

/** GET one JSON object (not a collection). */
async function apiGet(session, link, endpoint, params = {}, what = endpoint) {
  const response = await session.get(link + API_BASE + endpoint + toQuery(params));
  assertOk(response, what);
  return response.data;
}

/**
 * GET a collection, following `Link: rel="next"` to the end.
 * `envelope` names the wrapping key for the endpoints that return an object
 * instead of a bare array (e.g. `{ "grading_periods": [...] }`).
 */
async function apiList(session, link, endpoint, params = {}, { what = endpoint, envelope } = {}) {
  let url = link + API_BASE + endpoint + toQuery({ per_page: PER_PAGE, ...params });
  const items = [];

  for (let page = 0; page < MAX_PAGES && url; page++) {
    const response = await session.get(url);
    assertOk(response, what);
    const body = response.data;
    const batch = Array.isArray(body) ? body : envelope ? body?.[envelope] : null;
    if (Array.isArray(batch)) items.push(...batch);

    const next = nextPageUrl(response.headers);
    url = next && sameOrigin(next, link) ? next : null;
  }

  return items;
}

/**
 * Run `fn` over `items` with at most `limit` in flight. Used for the per-course
 * fan-out; Canvas throttles by request cost, so unbounded parallelism across a
 * 9-course schedule is a good way to get 403'd.
 */
async function mapPool(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = new Array(Math.max(1, Math.min(limit, items.length))).fill(null).map(async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * Read a boolean `options` flag leniently.
 *
 * Options arrive as JSON, but plenty of callers — a form, a query string, the
 * docs playground — send every field as a string, where `"false"` is truthy and
 * would silently do the opposite of what was asked. Only the recognised spellings
 * of true and false count; anything else falls back to the default.
 */
function boolOption(value, fallback = false) {
  if (value === true || value === false) return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['true', '1', 'yes'].includes(normalized)) return true;
    if (['false', '0', 'no', ''].includes(normalized)) return false;
  }
  if (value === 1) return true;
  if (value === 0) return false;
  return fallback;
}

export { apiGet, apiList, assertOk, boolOption, canvasMessage, mapPool, toQuery };
