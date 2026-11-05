/**
 * The HTTP layer the Worker entry point uses in place of Express + helmet + cors
 * + express.json. Everything is precomputed or a plain function: on Workers the
 * CPU spent per request is what counts, and none of this needs a framework.
 */

// helmet's defaults, plus the CSP loosening the docs playground needed. Set on
// every response the Worker generates (static docs get the same via _headers).
const SECURITY_HEADERS = [
  ['Content-Security-Policy', "default-src 'self';base-uri 'self';font-src 'self' https: data:;form-action 'self';frame-ancestors 'self';img-src 'self' data: https:;object-src 'none';script-src 'self';script-src-attr 'none';style-src 'self' 'unsafe-inline';connect-src 'self' *;upgrade-insecure-requests"],
  ['Cross-Origin-Opener-Policy', 'same-origin'],
  ['Cross-Origin-Resource-Policy', 'same-origin'],
  ['Origin-Agent-Cluster', '?1'],
  ['Referrer-Policy', 'no-referrer'],
  ['Strict-Transport-Security', 'max-age=31536000; includeSubDomains'],
  ['X-Content-Type-Options', 'nosniff'],
  ['X-DNS-Prefetch-Control', 'off'],
  ['X-Download-Options', 'noopen'],
  ['X-Frame-Options', 'SAMEORIGIN'],
  ['X-Permitted-Cross-Domain-Policies', 'none'],
  ['X-XSS-Protection', '0'],
];

const JSON_TYPE = 'application/json; charset=utf-8';
const BODY_LIMIT = 256 * 1024;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function json(status, data, headers) {
  const response = new Response(JSON.stringify(data), { status, headers: { 'Content-Type': JSON_TYPE } });
  if (headers) for (const [key, value] of Object.entries(headers)) response.headers.set(key, value);
  return response;
}

/** Add CORS (all origins; the API uses no browser credentials) and security headers. */
function finalize(response) {
  let res = response;
  try {
    res.headers.set('Access-Control-Allow-Origin', '*');
  } catch {
    // Immutable headers (a response from fetch or the assets binding): copy it.
    res = new Response(response.body, response);
    res.headers.set('Access-Control-Allow-Origin', '*');
  }
  for (const [key, value] of SECURITY_HEADERS) {
    if (!res.headers.has(key)) res.headers.set(key, value);
  }
  return res;
}

/**
 * CORS preflight, as the `cors` package answered it, plus a Max-Age so a
 * browser asks once per endpoint per day instead of before every POST.
 */
function preflight(request) {
  const headers = new Headers({
    'Access-Control-Allow-Methods': 'GET,HEAD,PUT,PATCH,POST,DELETE',
    'Access-Control-Max-Age': '86400',
    Vary: 'Access-Control-Request-Headers',
  });
  const requested = request.headers.get('Access-Control-Request-Headers');
  if (requested) headers.set('Access-Control-Allow-Headers', requested);
  return finalize(new Response(null, { status: 204, headers }));
}

/**
 * Parse a JSON request body the way express.json({ limit: '256kb' }) did:
 * only for a JSON content type, `{}` when empty or not JSON-typed, objects and
 * arrays only (strict), 413 over the limit, 400 on malformed JSON.
 */
async function readJsonBody(request) {
  const type = request.headers.get('content-type') || '';
  if (!/^application\/(?:[\w.+-]*\+)?json\b/i.test(type.trim())) return {};

  const declared = Number(request.headers.get('content-length'));
  if (declared > BODY_LIMIT) throw new HttpError(413, 'request entity too large');
  const bytes = await request.arrayBuffer();
  if (bytes.byteLength > BODY_LIMIT) throw new HttpError(413, 'request entity too large');
  if (bytes.byteLength === 0) return {};

  const text = new TextDecoder().decode(bytes);
  const first = text.trimStart()[0];
  if (first !== '{' && first !== '[') {
    throw new HttpError(400, `Invalid JSON: Unexpected token '${first ?? ''}', body is not a JSON object or array`);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new HttpError(400, 'Invalid JSON: ' + error.message);
  }
}

/** URLSearchParams → the shape Express gave req.query (repeated keys become arrays). */
function queryObject(searchParams) {
  const query = {};
  for (const [key, value] of searchParams) {
    if (key in query) query[key] = [].concat(query[key], value);
    else query[key] = value;
  }
  return query;
}

/**
 * Exact-match route table. Paths match case-insensitively and with or without a
 * trailing slash, as Express routes did by default.
 */
function normalizePath(path) {
  let p = path.toLowerCase();
  while (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
  return p;
}

class Router {
  constructor() {
    this.routes = new Map();
  }

  add(method, path, handler) {
    this.routes.set(`${method} ${normalizePath(path)}`, handler);
    return this;
  }

  get(path, handler) {
    return this.add('GET', path, handler);
  }

  post(path, handler) {
    return this.add('POST', path, handler);
  }

  match(method, pathname) {
    return this.routes.get(`${method} ${normalizePath(pathname)}`);
  }
}

export { HttpError, Router, json, finalize, preflight, readJsonBody, queryObject, SECURITY_HEADERS };
