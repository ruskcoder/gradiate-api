/**
 * The portal HTTP client every platform uses.
 *
 * Built on fetch() so it runs on Cloudflare Workers, with the cookie jar and
 * redirect handling done here, one hop at a time. (Workers' own redirect
 * following would drop the Set-Cookie headers of intermediate hops, which is
 * exactly where portal logins set their session cookies.)
 *
 * The request/response surface deliberately mirrors the axios calls the
 * platforms were written against, so platform code is unchanged:
 *   session.get(url, { headers, maxRedirects, validateStatus })
 *   session.post(url, data, { headers, ... })
 *   → { data, status, statusText, headers, request: { res: { responseUrl } } }
 * and a non-2xx status throws an error carrying `.response` and `.status`.
 */

import { CookieJar } from './cookies.js';
import { debugRequest, debugResponse } from './debug.js';
import { env } from './env.js';

// What the portals have been receiving from the axios-based client, kept
// identical so no portal sees a different-looking client after the move.
const DEFAULT_HEADERS = {
  Accept: 'application/json, text/plain, */*',
  'Content-Type': 'application/x-www-form-urlencoded',
  'User-Agent': 'axios/1.9.0',
};

const MAX_REDIRECTS = 21; // follow-redirects' default, which axios used
const okStatus = (status) => status >= 200 && status < 300;

// A portal call (one redirect hop, body included) that takes longer than this
// is abandoned. GETs are then retried on a fresh connection, because a stalled
// call is usually a dropped connection rather than a slow page. Without a limit
// a stalled portal left the request, and the app's progress bar, waiting.
const timeoutMs = () => Number(env.PORTAL_TIMEOUT_MS) || 10000;
const getRetries = () => {
  const n = Number(env.PORTAL_RETRIES);
  return Number.isInteger(n) && n >= 0 ? n : 1;
};

function portalTimeoutError(url) {
  const error = new Error(`${url.host} took too long to respond`);
  error.name = 'PortalTimeoutError';
  error.code = 'ETIMEDOUT';
  error.status = 504;
  return error;
}

const isAbort = (error) => error?.name === 'TimeoutError' || error?.name === 'AbortError';

function isPlainObject(value) {
  if (value === null || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null || Array.isArray(value);
}

/** Flatten an object into form fields the way axios did (`a[b]=…`, `list[]=…`). */
function appendForm(params, value, key) {
  if (value === undefined) return;
  if (value === null) {
    params.append(key, '');
  } else if (value instanceof Date) {
    params.append(key, value.toISOString());
  } else if (Array.isArray(value)) {
    for (const item of value) appendForm(params, item, `${key}[]`);
  } else if (typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) appendForm(params, v, `${key}[${k}]`);
  } else {
    params.append(key, String(value));
  }
}

/** Encode a request body like axios' default transformRequest. */
function serializeBody(data, headers) {
  if (data === undefined || data === null) return undefined;
  if (typeof data === 'string') return data;
  if (data instanceof URLSearchParams) {
    if (!headers.has('content-type')) headers.set('content-type', 'application/x-www-form-urlencoded;charset=utf-8');
    return data.toString();
  }
  if (!isPlainObject(data)) return data; // ArrayBuffer, Blob, FormData, streams: pass through

  const contentType = (headers.get('content-type') || '').toLowerCase();
  if (contentType.includes('application/x-www-form-urlencoded')) {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(data)) appendForm(params, value, key);
    return params.toString();
  }
  if (!contentType) headers.set('content-type', 'application/json');
  return JSON.stringify(data);
}

/**
 * axios parsed any JSON-looking text body into an object. Only try when the
 * first character could start JSON, so an HTML page never pays for a failed parse.
 */
function parseBody(text) {
  if (!text) return text;
  let i = 0;
  while (i < text.length && text.charCodeAt(i) <= 32) i++;
  const c = text[i];
  if (c === '{' || c === '[' || c === '"' || c === '-' || (c >= '0' && c <= '9') || c === 't' || c === 'f' || c === 'n') {
    try { return JSON.parse(text); } catch { return text; }
  }
  return text;
}

function setCookieHeaders(headers) {
  if (typeof headers.getSetCookie === 'function') return headers.getSetCookie();
  if (typeof headers.getAll === 'function') return headers.getAll('set-cookie');
  const single = headers.get('set-cookie');
  return single ? [single] : [];
}

function headersObject(headers) {
  const out = {};
  for (const [key, value] of headers) out[key] = value;
  const cookies = setCookieHeaders(headers);
  if (cookies.length) out['set-cookie'] = cookies;
  return out;
}

function isSubdomain(sub, domain) {
  return sub.endsWith('.' + domain);
}

function statusError(response) {
  const error = new Error(`Request failed with status code ${response.status}`);
  error.name = 'AxiosError';
  error.code = response.status >= 500 ? 'ERR_BAD_RESPONSE' : 'ERR_BAD_REQUEST';
  error.isAxiosError = true;
  error.status = response.status;
  error.response = response;
  error.config = response.config;
  return error;
}

async function discard(res) {
  try { await res.body?.cancel(); } catch { /* already closed */ }
}

/**
 * One redirect hop: fetch it and, unless it is a redirect being followed, read
 * the body — all under one timeout. Idempotent requests are retried after a
 * timeout or a network failure.
 */
async function fetchHop(session, url, init, follow) {
  const attempts = init.method === 'GET' || init.method === 'HEAD' ? 1 + getRetries() : 1;
  for (let attempt = 1; ; attempt++) {
    const started = Date.now();
    try {
      const res = await fetch(url.href, { ...init, signal: AbortSignal.timeout(timeoutMs()) });
      const location = res.headers.get('location');
      const redirect = follow && location && res.status >= 300 && res.status < 400;
      let text = '';
      if (redirect) await discard(res);
      else text = await res.text();
      session.timing?.record(url, Date.now() - started, res.status, attempt);
      return { res, text, location: redirect ? location : null };
    } catch (error) {
      const timedOut = isAbort(error);
      session.timing?.record(url, Date.now() - started, timedOut ? 'timeout' : 'error', attempt);
      if (attempt < attempts) continue;
      throw timedOut ? portalTimeoutError(url) : error;
    }
  }
}

/** One logical request: every redirect hop carries and collects cookies. */
async function send(session, method, url, data, config = {}) {
  const headers = new Headers(session.defaults.headers);
  if (config.headers) {
    for (const [key, value] of Object.entries(config.headers)) {
      if (value !== undefined && value !== null) headers.set(key, String(value));
    }
  }
  let body = serializeBody(data, headers);
  const maxRedirects = config.maxRedirects ?? MAX_REDIRECTS;
  const validateStatus = config.validateStatus === undefined ? okStatus : config.validateStatus;

  let current = new URL(url);
  let verb = method;
  let redirects = 0;

  for (;;) {
    const cookie = session.defaults.jar.getCookieString(current);
    if (cookie) headers.set('cookie', cookie);
    else headers.delete('cookie');

    const trace = debugRequest(session.label, verb, current.href, redirects === 0 ? data : undefined);
    let hop;
    try {
      hop = await fetchHop(session, current, { method: verb, headers, body, redirect: 'manual' }, maxRedirects > 0);
    } catch (error) {
      debugResponse(trace, 0, 0, null, error);
      throw error;
    }
    const { res, text, location } = hop;
    session.defaults.jar.storeAll(setCookieHeaders(res.headers), current);

    if (location) {
      if (redirects >= maxRedirects) throw new Error('Maximum number of redirects exceeded');
      redirects++;
      const next = new URL(location, current);
      debugResponse(trace, res.status, 0, next.href);

      // Browser-style method rewriting, as follow-redirects did.
      if (((res.status === 301 || res.status === 302) && verb === 'POST') ||
          (res.status === 303 && verb !== 'GET' && verb !== 'HEAD')) {
        verb = 'GET';
        body = undefined;
        for (const key of [...headers.keys()]) if (key.startsWith('content-')) headers.delete(key);
      }
      // Never carry credentials to a different site.
      if ((next.protocol !== current.protocol && next.protocol !== 'https:') ||
          (next.host !== current.host && !isSubdomain(next.host, current.host))) {
        headers.delete('authorization');
        headers.delete('proxy-authorization');
      }
      current = next;
      continue;
    }

    debugResponse(trace, res.status, text.length, null);
    const response = {
      data: parseBody(text),
      status: res.status,
      statusText: res.statusText,
      headers: headersObject(res.headers),
      config: { ...config, method: verb.toLowerCase(), url: current.href },
      request: { res: { responseUrl: current.href }, responseURL: current.href },
    };
    if (validateStatus && !validateStatus(res.status)) throw statusError(response);
    return response;
  }
}

class SessionWrapper {
  constructor(jar = new CookieJar(), label = 'new', timing = null) {
    // `defaults.jar` is read on every request, so code that swaps in a fresh jar
    // (Microsoft sign-in retries, session restore) takes effect immediately.
    this.defaults = { jar, headers: { ...DEFAULT_HEADERS } };
    this.label = label;
    // Where portal call timings go (the request's timing log), if anywhere.
    this.timing = timing;
    this.cache = {
      lastValidationTime: null,
      verificationToken: null,
    };
    this.loginMetadata = null;
  }

  get(url, config) {
    return send(this, 'GET', url, undefined, config);
  }

  post(url, data, config) {
    return send(this, 'POST', url, data, config);
  }

  setLoginMetadata(loginType, loginData) {
    this.loginMetadata = { loginType, loginData };
  }

  getLoginMetadata() {
    return this.loginMetadata;
  }

  setLastValidationTime(time) {
    this.cache.lastValidationTime = time;
  }

  getLastValidationTime() {
    return this.cache.lastValidationTime;
  }

  isSessionFresh(minutes = 5) {
    const lastValidation = this.cache.lastValidationTime;
    if (!lastValidation) return false;
    const elapsed = Date.now() - lastValidation;
    return elapsed < minutes * 60 * 1000;
  }

  setVerificationToken(token) {
    this.cache.verificationToken = token;
  }

  getVerificationToken() {
    return this.cache.verificationToken;
  }
}

/** A fresh session. Pass the request's `timing` so its portal calls are logged. */
function createSession(timing = null) {
  return new SessionWrapper(new CookieJar(), 'new', timing);
}

function createSuccessResponse(data, session = null) {
  const response = { success: true, ...data };
  if (session) {
    response.session = {
      cookies: session.defaults.jar.toJSON(),
      cache: session.cache || {},
      loginMetadata: session.getLoginMetadata()
    };
  }
  return response;
}

function restoreSession(sessionData) {
  const session = new SessionWrapper(CookieJar.fromJSON(sessionData?.cookies), 'restored');
  if (sessionData?.cache) {
    session.cache = sessionData.cache;
  }
  if (sessionData?.loginMetadata) {
    session.setLoginMetadata(sessionData.loginMetadata.loginType, sessionData.loginMetadata.loginData);
  }
  return session;
}

/**
 * Seed raw portal cookies (captured by a client-side WebView after an SSO sign-in)
 * into a session's jar, scoped to the portal host. `cookies` may be:
 *   - a Cookie-header string:  "JSESSIONID=abc; other=def"
 *   - an array of { name, value } (or { name, value, domain, path })
 *   - an object map:           { JSESSIONID: "abc", other: "def" }
 * Used by the `microsoftSession` login type so the API can ride a session the
 * user established in a real browser (surviving MFA / risk challenges).
 */
function seedCookiesIntoSession(session, cookies, url) {
  if (!cookies || !url) return session;
  let host;
  try { host = new URL(url).hostname; } catch { return session; }
  const jar = session.defaults.jar;

  const pairs = [];
  if (typeof cookies === 'string') {
    for (const part of cookies.split(/;\s*/)) {
      const eq = part.indexOf('=');
      if (eq > 0) pairs.push([part.slice(0, eq).trim(), part.slice(eq + 1)]);
    }
  } else if (Array.isArray(cookies)) {
    for (const c of cookies) if (c && c.name) pairs.push([c.name, c.value ?? '']);
  } else if (typeof cookies === 'object') {
    for (const [k, v] of Object.entries(cookies)) {
      // @react-native-cookies returns { name: { value, domain, ... } }.
      pairs.push([k, v && typeof v === 'object' ? v.value ?? '' : v]);
    }
  }

  for (const [name, value] of pairs) {
    if (!name) continue;
    jar.setCookieSync(`${name}=${value}; Domain=${host}; Path=/`, url);
  }
  return session;
}

function restoreCookiesIntoSession(session, sessionData) {
  if (!sessionData) {
    return session;
  }

  try {
    const data = typeof sessionData === 'string' ? JSON.parse(sessionData) : sessionData;

    if (data.cookies) {
      session.defaults.jar = CookieJar.fromJSON(data.cookies);
      if (data.cache && typeof data.cache === 'object') {
        session.cache = { ...session.cache, ...data.cache };
      }
      if (data.loginMetadata) {
        session.setLoginMetadata(data.loginMetadata.loginType, data.loginMetadata.loginData);
      }
    } else {
      session.defaults.jar = CookieJar.fromJSON(data);
    }
    session.label = 'restored';
  } catch (error) {
    console.error('Failed to restore session data:', error);
  }

  return session;
}

export {
  SessionWrapper,
  createSession,
  createSuccessResponse,
  restoreSession,
  restoreCookiesIntoSession,
  seedCookiesIntoSession
};
