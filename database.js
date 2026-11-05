/**
 * Minimal Supabase (PostgREST) client.
 *
 * The API only ever runs a handful of simple table reads/writes and one RPC, so
 * this talks to Supabase's REST endpoint directly with fetch instead of bundling
 * @supabase/supabase-js (its auth, realtime and storage clients were dead weight
 * on every cold start). Requests carry the same `apikey` + bearer headers the
 * official client sends.
 */

import { env } from './core/env.js';

class DatabaseError extends Error {
  constructor(message, status, details) {
    super(message);
    this.name = 'DatabaseError';
    this.status = status;
    this.details = details;
  }
}

/** Encode a value for a PostgREST filter such as `eq.` */
const filterValue = (value) => encodeURIComponent(String(value));

/** Build an `in.(…)` filter; values are quoted so commas/parentheses are safe. */
function inList(values) {
  const quoted = values.map((v) => `"${String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`);
  return `in.(${quoted.map(encodeURIComponent).join(',')})`;
}

/**
 * Call `/rest/v1/<path>`. Returns the parsed JSON body (null when empty).
 * Throws DatabaseError on a non-2xx answer.
 */
async function rest(path, { method = 'GET', body, prefer } = {}) {
  const base = env.SUPABASE_URL;
  const key = env.SUPABASE_KEY;
  if (!base || !key) throw new DatabaseError('Supabase is not configured', 500);

  const headers = { apikey: key, Authorization: `Bearer ${key}` };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (prefer) headers.Prefer = prefer;

  const res = await fetch(`${base.replace(/\/+$/, '')}/rest/v1/${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    let message = text || res.statusText;
    let details;
    try {
      details = JSON.parse(text);
      message = details.message || message;
    } catch { /* not JSON */ }
    throw new DatabaseError(message, res.status, details);
  }
  return text ? JSON.parse(text) : null;
}

const db = {
  select: (path) => rest(path),
  insert: (path, rows, prefer = 'return=minimal') => rest(path, { method: 'POST', body: rows, prefer }),
  upsert: (path, rows) => rest(path, { method: 'POST', body: rows, prefer: 'resolution=merge-duplicates,return=minimal' }),
  update: (path, fields) => rest(path, { method: 'PATCH', body: fields, prefer: 'return=minimal' }),
  remove: (path) => rest(path, { method: 'DELETE', prefer: 'return=minimal' }),
  rpc: (fn, args = {}) => rest(`rpc/${fn}`, { method: 'POST', body: args }),
};

export { db, DatabaseError, filterValue, inList };
