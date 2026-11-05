/**
 * Debug request logging.
 *
 * Every platform reaches a school portal through a core session (see session.js),
 * so logging from that one place gives a complete, ordered trace of what the API
 * asks the portal for — including every redirect hop, which is usually where a
 * login flow actually goes wrong.
 *
 * Off unless `DEBUG_REQUESTS` is truthy, because the trace includes portal URLs
 * and form field names. Values that could carry a credential are redacted here
 * rather than at the call site, so a new platform can't leak a password into the
 * logs just by forgetting to.
 *
 *   DEBUG_REQUESTS=1 in .dev.vars      # trace every outbound portal request
 *   NO_COLOR=1                         # plain text (CI, Workers logs)
 */

import { env } from './env.js';

const ANSI = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
};

const useColor = () => !env.NO_COLOR;

function paint(text, ...codes) {
  if (!useColor()) return String(text);
  return codes.map((c) => ANSI[c] || '').join('') + text + ANSI.reset;
}

// One colour per verb so a long trace is skimmable: the reads and the writes
// separate at a glance.
const METHOD_COLORS = {
  GET: 'cyan',
  POST: 'green',
  PUT: 'yellow',
  PATCH: 'yellow',
  DELETE: 'red',
  HEAD: 'gray',
  OPTIONS: 'gray',
};

function statusColor(status) {
  if (!status) return 'gray';
  if (status >= 500) return 'red';
  if (status >= 400) return 'red';
  if (status >= 300) return 'yellow';
  return 'green';
}

function isDebugEnabled() {
  const flag = env.DEBUG_REQUESTS;
  return Boolean(flag) && flag !== '0' && flag.toLowerCase() !== 'false';
}

// Field names whose values must never reach a log. Matched case-insensitively as
// a substring, so `LogOnDetails.Password`, `tempPW` and `clsession` are all covered
// without listing every portal's spelling.
const SECRET_PATTERNS = [
  'password', 'passwd', 'pwd', 'pw',
  'token', 'secret', 'apikey', 'api_key',
  'authorization', 'cookie', 'session',
  'clmfa', 'pin',
];

function isSecretKey(key) {
  const k = String(key).toLowerCase();
  return SECRET_PATTERNS.some((p) => k.includes(p));
}

/**
 * Render a value for the trace: secrets become a length-only placeholder so a
 * trace still shows "the password was 9 chars and non-empty" — the thing you
 * actually need when debugging a rejected login — without printing it.
 */
function redact(key, value) {
  if (value === undefined || value === null) return String(value);
  if (isSecretKey(key)) {
    const len = String(value).length;
    return len ? `<redacted:${len} chars>` : '<empty>';
  }
  const str = typeof value === 'object' ? JSON.stringify(value) : String(value);
  return str.length > 120 ? `${str.slice(0, 120)}…` : str;
}

function formatBody(data) {
  if (!data) return null;
  if (typeof data === 'string') {
    // Already-serialized form body: split it back apart so each field can be
    // redacted individually instead of dumping the raw query string.
    if (data.includes('=')) {
      return data
        .split('&')
        .map((pair) => {
          const eq = pair.indexOf('=');
          if (eq < 0) return pair;
          const key = decodeURIComponent(pair.slice(0, eq));
          const raw = decodeURIComponent(pair.slice(eq + 1).replace(/\+/g, ' '));
          return `${key}=${redact(key, raw)}`;
        })
        .join('  ');
    }
    return data.length > 200 ? `${data.slice(0, 200)}…` : data;
  }
  if (typeof data === 'object') {
    return Object.entries(data)
      .map(([k, v]) => `${k}=${redact(k, v)}`)
      .join('  ');
  }
  return String(data);
}

function shortUrl(url) {
  if (!url) return '(no url)';
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}${u.search}`;
  } catch {
    return url;
  }
}

let seq = 0;

/**
 * Log one outbound request hop. Returns a handle for `debugResponse`, or null
 * when tracing is off (the caller then skips all formatting work).
 */
function debugRequest(label, method, url, body) {
  if (!isDebugEnabled()) return null;
  const id = ++seq;
  console.log(
    `${paint(`[${label}#${id}]`, 'gray')} ${paint(` ${method} `, METHOD_COLORS[method] || 'blue', 'bold')} ${paint(shortUrl(url), 'bold')}`
  );
  const formatted = formatBody(body);
  if (formatted) console.log(`${paint('        body ', 'gray')}${paint(formatted, 'dim')}`);
  return { id, label, start: Date.now() };
}

/** Log the outcome of a hop started with `debugRequest`. */
function debugResponse(handle, status, size, redirectTo, error) {
  if (!handle) return;
  const ms = Date.now() - handle.start;
  const tag = paint(`[${handle.label}#${handle.id}]`, 'gray');
  if (error) {
    console.log(`${tag} ${paint(' ERR ', 'red', 'bold')} ${paint(`${ms}ms`, 'gray')} ${paint(error.message, 'red')}`);
    return;
  }
  console.log(
    `${tag} ${paint(` ${status} `, statusColor(status), 'bold')} ` +
    `${paint(`${ms}ms`, 'gray')} ${paint(size ? `${size}b` : '', 'gray')}` +
    (redirectTo ? ` ${paint('→', 'yellow')} ${paint(shortUrl(redirectTo), 'yellow')}` : '')
  );
}

/**
 * Log a decision the scraper made that isn't itself an HTTP call — "matched the
 * failure fingerprint", "picked term X". These are the other half of a login
 * trace: the request log shows what came back, this shows what we concluded.
 */
function debugLog(scope, message, detail) {
  if (!isDebugEnabled()) return;
  console.log(
    `${paint(`[${scope}]`, 'magenta', 'bold')} ${message}` +
    (detail !== undefined ? ` ${paint(typeof detail === 'object' ? JSON.stringify(detail) : String(detail), 'dim')}` : '')
  );
}

export { debugRequest, debugResponse, debugLog, isDebugEnabled };
