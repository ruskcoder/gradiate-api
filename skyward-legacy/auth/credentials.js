/**
 * Skyward legacy (Skyport) username/password login.
 *
 * The handshake (ported from the reference log.py):
 *   1. GET  seplog01.w          — seed the session.
 *   2. POST skyporthttp.w       — requestAction=eel&codeType=tryLogin&login&password
 *                                 → a `^`-delimited blob of session tokens.
 *   3. Manually drop the returned cookie (cname=cvalue) into the jar.
 *
 * Skyward's real auth state is NOT all in cookies — the gradebook/detail POSTs
 * need `encses` + `sessionid` (recid\x15wfaacl_recid) in the body. Those tokens
 * are stashed on `session.cache.skyward`, which is the only place core
 * round-trips to the client (see core/session.js createSuccessResponse).
 */

import { AuthenticationError, ValidationError, APIError } from '../../core/errors.js';
import { createSessionValidator, streamOrThrow, defaultFormatLink } from '../../core/platform.js';
import { ERROR_MESSAGES, SKYWARD_ENDPOINTS, DEFAULT_PORTAL_PATH } from '../config/constants.js';

// Detect a logged-out Skyward response so the reauth wrapper can transparently
// re-login. Three shapes count as expired:
//   1. The tiny "...invalid..." blob returned on a bad login / dead session POST.
//   2. The "logged out" confirmation page (qloggedout001.w) Skyward bounces an
//      expired session to — "You have been logged out. You may close this window
//      at any time." It carries none of the login-form markers below, so without
//      an explicit check it slipped through and surfaced "Could not find grid
//      data" instead of a silent relogin.
//   3. A full page that has bounced back to the Student/Family Access login form
//      (seplog01.w) — large HTML, so the length check above misses it, which is
//      why waiting out a session used to surface "Could not find grid data"
//      instead of a silent relogin. We fingerprint the login form but require the
//      absence of any authenticated gradebook marker, so a real data page (which
//      always carries stuGradesGrid_/showGradeInfo) can never be misread as
//      expired.
function isSessionExpired(html) {
  if (typeof html !== 'string') return false;
  if (html.length < 400 && html.toLowerCase().includes(ERROR_MESSAGES.INVALID_LOGIN)) return true;

  const authenticated = /stuGradesGrid_\d+|showGradeInfo|sf_gridHtml/i.test(html);
  if (authenticated) return false;
  // The explicit logged-out landing page (qloggedout001.w).
  if (/qloggedout\d*\.w|You have been logged out/i.test(html)) return true;
  const looksLikeLogin =
    /(?:WService=wsEAplus|Student\/web)\/seplog01\.w|nameid=["']?login["']?|name=["']?password["']?|Login\s*Area|sfLoginForm/i.test(html);
  return looksLikeLogin;
}

/**
 * Build a lazy request-body thunk for a token-bearing Skyward POST. The reauth
 * wrapper calls it once up front and again after any relogin, so the retry picks
 * up the FRESH encses/sessionid the new login wrote to `session.cache.skyward`
 * rather than replaying the expired ones. `extra` merges in per-request fields.
 */
function tokenBody(session, extra = {}) {
  return () => {
    const t = skywardTokens(session);
    return new URLSearchParams({
      encses: t.encses || '',
      sessionid: sessionId(t),
      ...extra,
    }).toString();
  };
}

// Guard used by data functions after each authenticated request.
const checkSessionValidity = createSessionValidator(
  ERROR_MESSAGES.INVALID_LOGIN,
  ERROR_MESSAGES.INVALID_USERNAME_PASSWORD
);

/** Read the Skyward token bundle a data function needs off the session. */
function skywardTokens(session) {
  return (session.cache && session.cache.skyward) || {};
}

// A portal path is a relative directory ("Student/web/"). It round-trips
// through the client's session cache, so only plain path segments are accepted
// — never a scheme, host, `..` or leading slash that could point requests
// somewhere other than `link`.
const SAFE_PORTAL_PATH = /^(?:[A-Za-z0-9_.=-]+\/)+$/;

function isSafePortalPath(path) {
  return typeof path === 'string' && SAFE_PORTAL_PATH.test(path) && !path.split('/').includes('..');
}

/**
 * Absolute URL of a Skyward page (`name` is a SKYWARD_ENDPOINTS key) under the
 * portal directory detected at login, falling back to the legacy ISAPI path.
 */
function portalUrl(session, link, name) {
  const cached = skywardTokens(session).portalPath;
  const path = isSafePortalPath(cached) ? cached : DEFAULT_PORTAL_PATH;
  return link + path + SKYWARD_ENDPOINTS[name];
}

/**
 * Lazy form of portalUrl for requests through the reauth wrapper: a session
 * cached before detection existed first hits the fallback path, bounces to a
 * login page and re-logs-in — the retry must then use the freshly detected
 * directory, not the stale URL.
 */
function lazyPortalUrl(session, link, name) {
  return () => portalUrl(session, link, name);
}

/**
 * Work out the portal directory from where the login page GET landed after
 * redirects (e.g. .../Student/web/seplog01.w → "Student/web/").
 */
function detectPortalPath(res, link) {
  try {
    const landed = res?.request?.res?.responseUrl || res?.request?.responseURL;
    if (!landed) return null;
    const base = new URL(link);
    const url = new URL(landed);
    if (url.host !== base.host) return null;
    const dir = url.pathname.slice(0, url.pathname.lastIndexOf('/') + 1);
    if (!dir.startsWith(base.pathname)) return null;
    const path = dir.slice(base.pathname.length);
    return isSafePortalPath(path) ? path : null;
  } catch {
    return null;
  }
}

/** Build the `recid\x15wfaacl_recid` session id string Skyward expects. */
function sessionId(tokens) {
  return `${tokens.recid || ''}\x15${tokens.wfaacl_recid || ''}`;
}

/**
 * Parse the `^`-delimited login blob (response text minus the first 4 / last 5
 * framing chars). Indices mirror log.py.
 */
function parseLoginBlob(responseText) {
  const clean = responseText.substring(4, responseText.length - 5);
  const p = clean.split('^');
  if (p.length < 15) throw new AuthenticationError('Invalid login response format');
  return {
    dwd: p[0],
    recid: p[1],
    wfaacl_recid: p[2],
    wfaacl: p[3],
    nameid: p[4],
    duserid: p[5],
    enc: p[13],
    encses: p[14] || p[p.length - 1],
    cname: p[p.length - 3],
    cvalue: p[p.length - 2],
  };
}

async function credentialsAuth(session, loginData, progressTracker) {
  const { username, password } = loginData;
  const link = defaultFormatLink(loginData.link);

  if (!link) throw new ValidationError('link is required for credentials login');
  if (!username || !password) {
    throw new ValidationError('username and password are required for credentials login');
  }

  try {
    // 1. Seed the session, and learn which directory the portal lives in from
    //    where the login page redirects to. The login POST can't discover this
    //    itself: a 301 turns it into a GET and the token blob never comes back.
    const seed = await session.get(link + DEFAULT_PORTAL_PATH + SKYWARD_ENDPOINTS.LOGIN).catch(() => null);
    const portalPath = detectPortalPath(seed, link) || DEFAULT_PORTAL_PATH;

    // 2. Login handshake.
    const payload = new URLSearchParams({
      requestAction: 'eel',
      codeType: 'tryLogin',
      login: username,
      password,
    }).toString();

    const res = await session.post(link + portalPath + SKYWARD_ENDPOINTS.LOGIN_POST, payload, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
    });

    if (typeof res.data !== 'string' || res.data.toLowerCase().includes(ERROR_MESSAGES.INVALID_LOGIN)) {
      return streamOrThrow(progressTracker, 401, ERROR_MESSAGES.INVALID_USERNAME_PASSWORD);
    }

    const tokens = parseLoginBlob(res.data);

    // 3. Drop the returned session cookie into the jar (Skyward does not send it
    //    as a Set-Cookie header — log.py sets it manually too).
    try {
      const domain = new URL(link).hostname;
      const cookieStr = `${tokens.cname}=${tokens.cvalue}; Domain=${domain}; Path=/;`;
      await session.defaults.jar.setCookie(cookieStr, link);
    } catch (e) {
      console.warn('skyward: failed to set session cookie:', e && e.message);
    }

    session.cache = session.cache || {};
    session.cache.skyward = { ...tokens, portalPath };
    session.setLastValidationTime(Date.now());
    return { session, username, link };
  } catch (error) {
    if (error instanceof AuthenticationError) {
      return streamOrThrow(progressTracker, error.status || 401, error.message);
    }
    if (progressTracker && progressTracker.streaming) {
      progressTracker.error(500, `Login failed: ${error.message}`);
      return undefined;
    }
    throw new APIError(`Login failed: ${error.message}`);
  }
}

export {
  isSessionExpired,
  checkSessionValidity,
  credentialsAuth,
  skywardTokens,
  sessionId,
  tokenBody,
  portalUrl,
  lazyPortalUrl,
};
