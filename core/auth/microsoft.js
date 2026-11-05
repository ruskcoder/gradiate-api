/**
 * Microsoft (Azure AD / Office 365) SSO for portals that federate their sign-in
 * to Microsoft — e.g. a PowerSchool district using online.<district>.org accounts.
 *
 * Unlike ClassLink (which starts at a dashboard and rides a tile into the portal),
 * Microsoft SSO is *portal-initiated*: we hit the portal's OIDC entry point, get
 * bounced to the Azure AD sign-in page, script the username/password screen the
 * way the browser JS does, and follow the resulting `?code=` redirect back onto
 * the portal — which is then authenticated in the shared cookie jar.
 *
 * The handshake (mirrors the captured HAR):
 *   1. GET  <link>guardian/home.html?_userTypeHint=student
 *          → 302s to login.microsoftonline.com/<tenant>/oauth2/v2.0/authorize,
 *            whose HTML embeds `$Config={…}` with the flow token (sFT), context
 *            (sCtx), canary and the login POST url.
 *   2. POST common/GetCredentialType  — refreshes the flow token and reveals a
 *          federated IdP if the tenant has one (unsupported → clean error).
 *   3. POST <tenant>/login  with login/passwd/ctx/flowToken/canary
 *          → 302s back to <link>oidc/openid_connect_login?code=… → home.html.
 *
 * `loginData` for this flow is { link, username, password } where `link` is the
 * portal base and username/password are the Microsoft account credentials.
 */

import { CookieJar } from '../cookies.js';
import { AuthenticationError } from '../errors.js';
import { defaultFormatLink } from '../platform.js';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

/** Extract and JSON-parse the `$Config={…}` object embedded in an AAD page. */
function extractConfig(html) {
  if (typeof html !== 'string') return null;
  const marker = html.indexOf('$Config=');
  if (marker === -1) return null;
  const start = html.indexOf('{', marker);
  if (start === -1) return null;

  let depth = 0, inStr = false, esc = false, end = -1;
  for (let p = start; p < html.length; p++) {
    const ch = html[p];
    if (esc) { esc = false; continue; }
    if (ch === '\\') { esc = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) { end = p; break; } }
  }
  if (end === -1) return null;
  try { return JSON.parse(html.slice(start, end + 1)); } catch { return null; }
}

/** Final URL of a session response after any redirects. */
function finalUrl(res) {
  return res?.request?.res?.responseUrl || res?.request?.responseURL || '';
}

function landedOnPortal(res) {
  const url = finalUrl(res);
  const html = typeof res?.data === 'string' ? res.data : '';
  return /\/guardian\//.test(url) && !html.includes('name="dbpw"');
}

const AAD_ORIGIN = 'https://login.microsoftonline.com';

/**
 * Resolve a possibly-relative AAD form url. `$Config.urlPost` is served relative
 * (e.g. "/<tenant>/login"), so it must be joined against the page it came from
 * (or the AAD origin) before it can be POSTed to.
 */
function resolveAadUrl(u, base) {
  if (!u) return u;
  try { return new URL(u, base || AAD_ORIGIN).href; } catch { return u; }
}

const HTML_HEADERS = { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml' };
const FORM_HEADERS = { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': UA, Accept: 'text/html' };

/**
 * One full password-screen handshake. Returns true on a landed-on-portal success.
 * Throws for a *terminal* failure (bad password, MFA, federation) so the retry
 * loop stops; returns false for a transient bounce (sso_reload) worth retrying.
 */
async function attemptSignIn(session, link, username, password, progressTracker) {
  progressTracker?.update?.(12, 'Contacting Microsoft sign-in');
  const authorize = await session.get(link + 'guardian/home.html?_userTypeHint=student', {
    headers: HTML_HEADERS,
    maxRedirects: 10,
  });

  // Already signed in (portal cookie still valid) — nothing to do.
  if (landedOnPortal(authorize)) return true;

  const cfg = extractConfig(authorize.data);
  if (!cfg || !cfg.urlPost) {
    throw new AuthenticationError('This portal is not configured for Microsoft sign-in');
  }

  // AAD serves urlPost relative to the sign-in page; anchor it to that page's URL.
  const aadBase = finalUrl(authorize) || AAD_ORIGIN;
  const urlPost = resolveAadUrl(cfg.urlPost, aadBase);

  // NB: the browser also POSTs common/GetCredentialType here, but issuing it
  // server-side mutates the AAD flow state so the password POST bounces back to
  // /authorize. We post the password directly against the page's ctx/flowToken.
  progressTracker?.update?.(30, 'Signing in to Microsoft');
  const form = new URLSearchParams({
    i13: '0',
    login: username,
    loginfmt: username,
    type: '11',
    LoginOptions: '3',
    passwd: password,
    ps: '2',
    canary: cfg.canary,
    ctx: cfg.sCtx,
    flowToken: cfg.sFT,
  }).toString();

  const loginRes = await session.post(urlPost, form, { headers: FORM_HEADERS, maxRedirects: 10 });

  progressTracker?.update?.(45, 'Completing sign-in');
  if (landedOnPortal(loginRes)) return true;

  const html = typeof loginRes.data === 'string' ? loginRes.data : '';
  const cfg2 = extractConfig(html);

  if (cfg2 && cfg2.sErrorCode) {
    throw new AuthenticationError('Microsoft sign-in failed — check your username and password');
  }

  // "Stay signed in?" (KMSI) interstitial — answer No and follow through.
  if (cfg2 && cfg2.urlPost && /Stay signed in|KmsiInterrupt|kmsiForm/i.test(html)) {
    const kmsi = new URLSearchParams({
      LoginOptions: '0',
      type: '28',
      ctx: cfg2.sCtx,
      flowToken: cfg2.sFT,
      canary: cfg2.canary,
    }).toString();
    const done = await session.post(
      resolveAadUrl(cfg2.urlPost, finalUrl(loginRes) || aadBase),
      kmsi,
      { headers: FORM_HEADERS, maxRedirects: 10 }
    );
    if (landedOnPortal(done)) return true;
  }

  if (/multi-factor|verify your identity|enter.*code|authenticator/i.test(html)) {
    throw new AuthenticationError(
      'Your Microsoft account requires two-factor verification, which is not supported yet'
    );
  }

  // A bounce back to /authorize (sso_reload) is AAD's risk engine asking us to
  // start over; report it as transient so the caller retries with a fresh token.
  return false;
}

async function loginMicrosoft(session, loginData, ssoFilter, loginType, progressTracker) {
  const { username, password } = loginData;
  let link = defaultFormatLink(loginData.link);
  if (!link) throw new AuthenticationError('A portal link is required for Microsoft sign-in');
  link = link.replace(/\/public\/?$/i, '/');
  if (!username || !password) {
    throw new AuthenticationError('username and password are required for Microsoft sign-in');
  }

  // AAD's risk engine non-deterministically answers a scripted password POST with
  // an sso_reload bounce instead of the portal redirect. Each attempt uses a fresh
  // flow token, so a couple of retries clears the transient bounces; genuine
  // failures (bad password / MFA / federation) throw and break out immediately.
  const MAX_ATTEMPTS = 4;
  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    // Start each attempt from a clean cookie jar — a prior attempt's AAD cookies
    // are exactly what provokes the next sso_reload bounce.
    session.defaults.jar = new CookieJar();
    if (await attemptSignIn(session, link, username, password, progressTracker)) {
      return { session, link, username };
    }
  }

  throw new AuthenticationError('Microsoft sign-in did not complete — please try again');
}

export { loginMicrosoft };
