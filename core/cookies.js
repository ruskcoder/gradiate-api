/**
 * A small RFC 6265 cookie jar.
 *
 * It replaces tough-cookie, whose public-suffix list and per-cookie objects
 * were the most expensive part of restoring a session on every request. Only
 * what a server-side portal client needs is here: parse Set-Cookie, store with
 * domain/path/expiry rules, and build the Cookie header for a URL.
 *
 * The JSON shape matches tough-cookie's `jar.toJSON()`, because clients store
 * that blob and send it back on every call. Sessions created by the old server
 * restore here, and sessions created here would restore on the old one.
 */

const MAX_COOKIES = 300;
const MAX_KEY_LENGTH = 4096;
const MAX_VALUE_LENGTH = 16384;
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const CONTROL_CHARS = /[\x00-\x08\x0A-\x1F\x7F]/;
const IP_HOST = /^(?:\d{1,3}\.){3}\d{1,3}$|^\[?[0-9a-f:]+\]?$/i;
const SAME_SITE = new Set(['strict', 'lax', 'none']);

function toMillis(value) {
  if (value === undefined || value === null || value === 'Infinity') return Infinity;
  const ms = typeof value === 'number' ? value : Date.parse(value);
  return Number.isNaN(ms) ? Infinity : ms;
}

function toIso(ms) {
  return new Date(ms).toISOString();
}

function domainMatch(host, domain) {
  if (host === domain) return true;
  return host.endsWith('.' + domain) && !IP_HOST.test(host);
}

function pathMatch(requestPath, cookiePath) {
  if (requestPath === cookiePath) return true;
  if (!requestPath.startsWith(cookiePath)) return false;
  return cookiePath.endsWith('/') || requestPath[cookiePath.length] === '/';
}

function defaultPath(pathname) {
  if (!pathname || pathname[0] !== '/') return '/';
  const slash = pathname.lastIndexOf('/');
  return slash <= 0 ? '/' : pathname.slice(0, slash);
}

/** Expiry in ms. Like tough-cookie, Max-Age counts from the cookie's last use. */
function expiryOf(cookie) {
  if (cookie.maxAge !== undefined) {
    if (cookie.maxAge <= 0) return -Infinity;
    if (cookie.maxAge === Infinity) return Infinity;
    return cookie.lastAccessed + cookie.maxAge * 1000;
  }
  return cookie.expires;
}

/** Parse one Set-Cookie header value. Returns null for a cookie to ignore. */
function parseSetCookie(header) {
  if (typeof header !== 'string') return null;
  const semi = header.indexOf(';');
  const pair = semi === -1 ? header : header.slice(0, semi);
  const eq = pair.indexOf('=');
  if (eq === -1) return null;
  const key = pair.slice(0, eq).trim();
  const value = pair.slice(eq + 1).trim();
  if (!key || CONTROL_CHARS.test(key) || CONTROL_CHARS.test(value)) return null;

  const cookie = { key, value, expires: Infinity };
  if (semi === -1) return cookie;

  for (const part of header.slice(semi + 1).split(';')) {
    const attrEq = part.indexOf('=');
    const name = (attrEq === -1 ? part : part.slice(0, attrEq)).trim().toLowerCase();
    const val = attrEq === -1 ? '' : part.slice(attrEq + 1).trim();
    switch (name) {
      case 'expires': {
        const ms = Date.parse(val);
        if (!Number.isNaN(ms)) cookie.expires = ms;
        break;
      }
      case 'max-age':
        if (/^-?\d+$/.test(val)) cookie.maxAge = Number(val);
        break;
      case 'domain': {
        const domain = val.replace(/^\./, '').toLowerCase();
        if (domain) cookie.domain = domain;
        break;
      }
      case 'path':
        if (val[0] === '/') cookie.path = val;
        break;
      case 'secure':
        cookie.secure = true;
        break;
      case 'httponly':
        cookie.httpOnly = true;
        break;
      case 'samesite': {
        const sameSite = val.toLowerCase();
        if (SAME_SITE.has(sameSite)) cookie.sameSite = sameSite;
        break;
      }
      case '':
        break;
      default:
        (cookie.extensions ||= []).push(part.trim());
    }
  }
  return cookie;
}

/** Revive one serialized cookie (tough-cookie format). Untrusted: it came from a client. */
function reviveCookie(raw, now) {
  if (!raw || typeof raw !== 'object') return null;
  const { key, value, domain } = raw;
  if (typeof key !== 'string' || typeof value !== 'string' || typeof domain !== 'string') return null;
  if (!key || key.length > MAX_KEY_LENGTH || value.length > MAX_VALUE_LENGTH) return null;

  const cookie = {
    key,
    value,
    domain: domain.replace(/^\./, '').toLowerCase(),
    path: typeof raw.path === 'string' && raw.path[0] === '/' ? raw.path : '/',
    expires: toMillis(raw.expires),
    hostOnly: raw.hostOnly !== false,
    creation: toMillis(raw.creation),
    lastAccessed: toMillis(raw.lastAccessed),
  };
  if (!Number.isFinite(cookie.creation)) cookie.creation = now;
  if (!Number.isFinite(cookie.lastAccessed)) cookie.lastAccessed = cookie.creation;
  if (raw.maxAge !== undefined && raw.maxAge !== null) {
    const maxAge = raw.maxAge === 'Infinity' ? Infinity : raw.maxAge === '-Infinity' ? -Infinity : Number(raw.maxAge);
    if (!Number.isNaN(maxAge)) cookie.maxAge = maxAge;
  }
  if (raw.secure === true) cookie.secure = true;
  if (raw.httpOnly === true) cookie.httpOnly = true;
  if (raw.pathIsDefault === true) cookie.pathIsDefault = true;
  if (typeof raw.sameSite === 'string' && SAME_SITE.has(raw.sameSite)) cookie.sameSite = raw.sameSite;
  if (Array.isArray(raw.extensions)) {
    const extensions = raw.extensions.filter((e) => typeof e === 'string');
    if (extensions.length) cookie.extensions = extensions;
  }
  return cookie;
}

function serializeCookie(c) {
  const out = { key: c.key, value: c.value };
  if (Number.isFinite(c.expires)) out.expires = toIso(c.expires);
  if (c.maxAge !== undefined) out.maxAge = Number.isFinite(c.maxAge) ? c.maxAge : String(c.maxAge);
  out.domain = c.domain;
  out.path = c.path;
  if (c.secure) out.secure = true;
  if (c.httpOnly) out.httpOnly = true;
  if (c.extensions) out.extensions = c.extensions;
  out.hostOnly = c.hostOnly;
  if (c.pathIsDefault) out.pathIsDefault = true;
  out.creation = toIso(c.creation);
  out.lastAccessed = toIso(c.lastAccessed);
  if (c.sameSite) out.sameSite = c.sameSite;
  return out;
}

class CookieJar {
  constructor() {
    this.cookies = [];
    this.sequence = 0;
  }

  /** Build a jar from a serialized jar (object or JSON string). Bad input yields an empty jar. */
  static fromJSON(serialized) {
    const jar = new CookieJar();
    let data = serialized;
    if (typeof data === 'string') {
      try { data = JSON.parse(data); } catch { return jar; }
    }
    const list = Array.isArray(data) ? data : data?.cookies;
    if (!Array.isArray(list)) return jar;
    const now = Date.now();
    for (const raw of list.slice(0, MAX_COOKIES)) {
      const cookie = reviveCookie(raw, now);
      if (cookie) {
        cookie.index = ++jar.sequence;
        jar.cookies.push(cookie);
      }
    }
    return jar;
  }

  toJSON() {
    return {
      version: 'gradiate-cookiejar@1',
      storeType: 'MemoryCookieStore',
      rejectPublicSuffixes: true,
      enableLooseMode: false,
      allowSpecialUseDomain: true,
      prefixSecurity: 'silent',
      cookies: this.cookies.map(serializeCookie),
    };
  }

  /** Store one Set-Cookie value received from `url`. Returns the cookie, or undefined if ignored. */
  setCookieSync(header, url) {
    let target;
    try { target = typeof url === 'string' ? new URL(url) : url; } catch { return undefined; }
    const cookie = parseSetCookie(header);
    if (!cookie) return undefined;

    const host = target.hostname.toLowerCase();
    if (cookie.domain) {
      // A Domain attribute must cover the host, and a single-label domain
      // ("com") is a public suffix nobody may set cookies on.
      if (!domainMatch(host, cookie.domain)) return undefined;
      if (!cookie.domain.includes('.') && cookie.domain !== host) return undefined;
      cookie.hostOnly = false;
    } else {
      cookie.domain = host;
      cookie.hostOnly = true;
    }
    if (!cookie.path) {
      cookie.path = defaultPath(target.pathname);
      cookie.pathIsDefault = true;
    }
    // Cookie prefixes, enforced silently like tough-cookie's default.
    if (cookie.key.startsWith('__Secure-') && !cookie.secure) return undefined;
    if (cookie.key.startsWith('__Host-') && (!cookie.secure || !cookie.hostOnly || cookie.path !== '/')) {
      return undefined;
    }

    const now = Date.now();
    cookie.creation = now;
    cookie.lastAccessed = now;
    const existing = this.cookies.findIndex(
      (c) => c.key === cookie.key && c.domain === cookie.domain && c.path === cookie.path
    );
    if (existing !== -1) {
      cookie.creation = this.cookies[existing].creation;
      cookie.index = this.cookies[existing].index;
      this.cookies.splice(existing, 1);
    } else {
      cookie.index = ++this.sequence;
    }
    if (expiryOf(cookie) <= now) return cookie; // an expiring Set-Cookie deletes it

    this.cookies.push(cookie);
    if (this.cookies.length > MAX_COOKIES) {
      this.cookies.sort((a, b) => a.lastAccessed - b.lastAccessed);
      this.cookies.splice(0, this.cookies.length - MAX_COOKIES);
    }
    return cookie;
  }

  /** Promise form, matching tough-cookie's `setCookie(cookie, url)`. */
  async setCookie(header, url) {
    return this.setCookieSync(header, url);
  }

  /** Store every Set-Cookie value from a response. */
  storeAll(headers, url) {
    for (const header of headers) this.setCookieSync(header, url);
  }

  /** The Cookie header value to send to `url`, or '' when no cookie applies. */
  getCookieString(url) {
    if (this.cookies.length === 0) return '';
    let target;
    try { target = typeof url === 'string' ? new URL(url) : url; } catch { return ''; }
    const host = target.hostname.toLowerCase();
    const path = target.pathname || '/';
    const secure = target.protocol === 'https:';
    const now = Date.now();

    const matches = [];
    let expired = false;
    for (const c of this.cookies) {
      if (expiryOf(c) <= now) {
        expired = true;
        continue;
      }
      if (c.hostOnly ? host !== c.domain : !domainMatch(host, c.domain)) continue;
      if (!pathMatch(path, c.path)) continue;
      if (c.secure && !secure) continue;
      matches.push(c);
    }
    if (expired) this.cookies = this.cookies.filter((c) => expiryOf(c) > now);
    if (matches.length === 0) return '';

    // Longer paths first, then oldest first (RFC 6265 section 5.4).
    matches.sort((a, b) => (b.path.length - a.path.length) || (a.creation - b.creation) || (a.index - b.index));
    let header = '';
    for (const c of matches) {
      c.lastAccessed = now;
      header += (header ? '; ' : '') + c.key + '=' + c.value;
    }
    return header;
  }
}

export { CookieJar, parseSetCookie };
