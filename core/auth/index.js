/**
 * The one authentication entry point every route goes through.
 *
 * Responsibilities that used to be copy-pasted into each platform now live here:
 *   - validating the request body and the requested loginType,
 *   - reusing a still-fresh client session (no network round-trip),
 *   - dispatching to the right login flow (platform credentials, or a core SSO
 *     flow like ClassLink / Microsoft),
 *   - wrapping the result so an expired session transparently re-logs-in.
 *
 * A platform contributes only: `credentialsAuth`, `ssoFilter`, `loginTypes`,
 * `isSessionExpired`, optional `formatLink`, optional `finalizeSSO`, optional
 * `homeEndpoint`.
 */

import { createSession, restoreCookiesIntoSession, seedCookiesIntoSession } from '../session.js';
import { createReauthSession } from '../reauthSession.js';
import { defaultFormatLink, assertSafeHttpUrl } from '../platform.js';
import { AuthenticationError, ValidationError, APIError } from '../errors.js';
import { loginClassLink } from './classlink.js';
import { loginMicrosoft } from './microsoft.js';

const SSO_LOGIN_TYPES = new Set(['classlink', 'classlinkCredentials', 'microsoft']);

function validateBody(req, platform) {
  const accepted = platform.loginTypes || ['credentials'];
  const { loginType, loginData, session, options } = req.body || {};

  if (!loginType || !accepted.includes(loginType)) {
    throw new ValidationError(`loginType must be one of: ${accepted.join(', ')}`);
  }

  return {
    loginType,
    loginData: loginData || {},
    existingSession: session,
    options: options || {},
  };
}

function resolveLink(platform, loginData) {
  const formatLink = platform.formatLink || defaultFormatLink;
  return formatLink(loginData.link);
}

/**
 * Perform a FRESH login (no session reuse) for the given loginType.
 * Returns { session, link, username }, a { mfaRequired, ... } challenge (SSO
 * second factor pending), or null if a streaming error was sent.
 *
 * `resumeSessionData` carries the client's serialized session on a 2FA
 * follow-up: its cookies + cached challenge token are restored so the SSO flow
 * can pick up the pending challenge rather than starting from scratch.
 */
async function performLogin(platform, loginType, loginData, progressTracker, resumeSessionData) {
  if (loginType === 'credentials') {
    const session = createSession();
    const result = await platform.credentialsAuth(session, loginData, progressTracker);
    if (!result) return null; // credentialsAuth already streamed an error
    return {
      session: result.session,
      link: result.link || resolveLink(platform, loginData),
      username: result.username,
    };
  }

  // Cookie-handoff login: the client completed the portal's real SSO (e.g.
  // Microsoft) in a WebView and captured the resulting portal cookies. We seed
  // them into a fresh jar and validate — no password, no server-side scraping of
  // the identity provider, so MFA / risk challenges are handled by the user's own
  // browser. On expiry the client re-runs the WebView (silently if the IdP's
  // "stay signed in" cookie is still valid) and hands over fresh cookies.
  if (loginType === 'microsoftSession') {
    const session = createSession();
    const link = resolveLink(platform, loginData);
    if (!link) throw new ValidationError('link is required for microsoftSession login');
    if (!loginData.cookies) throw new ValidationError('cookies are required for microsoftSession login');
    seedCookiesIntoSession(session, loginData.cookies, link);

    if (platform.homeEndpoint !== undefined && platform.isSessionExpired) {
      const probe = await session.get(link + platform.homeEndpoint);
      if (platform.isSessionExpired(probe.data)) {
        throw new AuthenticationError('Microsoft session expired — please sign in again');
      }
    }
    return { session, link, username: loginData.username };
  }

  if (SSO_LOGIN_TYPES.has(loginType)) {
    let session = createSession();
    if (resumeSessionData) {
      session = restoreCookiesIntoSession(session, resumeSessionData);
    }
    const runner = loginType === 'microsoft' ? loginMicrosoft : loginClassLink;
    const result = await runner(session, loginData, platform.ssoFilter, loginType, progressTracker);
    if (!result) return null;

    // A second factor is still pending — hand the challenge back untouched.
    if (result.mfaRequired) return result;

    let { session: sess, link, username } = result;
    if (platform.finalizeSSO) {
      const finalized = await platform.finalizeSSO(sess, link, result);
      if (finalized) {
        sess = finalized.session || sess;
        link = finalized.link || link;
      }
    }
    return { session: sess, link, username };
  }

  throw new APIError(`Unsupported loginType: ${loginType}`);
}

async function authenticate(req, platform, progressTracker) {
  const { loginType, loginData, existingSession } = validateBody(req, platform);
  progressTracker.update(4, 'Authenticating');

  /**
   * Stamp everything that makes a session usable *and* re-usable onto it:
   * identity, the resolved portal link, the login recipe, and a validation time.
   *
   * Both entry points must do this identically. `finish` prepares the session the
   * request runs on; `relogin` prepares the replacement one swapped in mid-request
   * by the reauth wrapper. When only `finish` stamped identity, a transparent
   * relogin silently dropped `session.username` — which data functions read
   * (hac/data/info.js) — and dropped `cache.username`, which is the only place an
   * SSO login's username survives to the next request.
   */
  const stampSession = (session, link, username) => {
    const resolvedUser = username || loginData.username || session.cache?.username || 'unknown';
    session.setLoginMetadata(loginType, loginData);
    session.username = resolvedUser;
    // Persist the resolved district portal link (and username) in the session
    // cache so they round-trip to the client and back. For SSO logins (ClassLink)
    // the link is discovered by walking a dashboard tile and isn't in loginData —
    // without stashing it here, every reused session would have to re-run the whole
    // SSO dance just to rediscover where the portal lives.
    if (link) session.cache.link = link;
    if (resolvedUser !== 'unknown') session.cache.username = resolvedUser;
    // Stamp a validation time so the next request carrying this session takes the
    // no-network fast path (isSessionFresh) instead of re-authenticating. A session
    // that has actually expired is still caught by the reauth wrapper on the next
    // data call, which transparently re-logs-in.
    session.setLastValidationTime(Date.now());
    return resolvedUser;
  };

  // Closure the reauth wrapper calls to transparently re-login on expiry. The
  // session it returns replaces the dead one inside the wrapper for the rest of
  // the request, and is what routes.js serializes back to the client — so the
  // caller transparently receives the NEW session rather than the expired one.
  const relogin = async () => {
    const fresh = await performLogin(platform, loginType, loginData, null);
    if (!fresh) throw new AuthenticationError('Re-authentication failed');
    // A silent re-login can't clear an interactive 2FA prompt on its own. It
    // still succeeds when the stored `loginData` carries a `clMFA` answer (a
    // known PIN / image), which performLogin applies inline; otherwise the user
    // must sign in again and re-clear the second factor.
    if (fresh.mfaRequired) {
      throw new AuthenticationError('Session expired — please sign in again to re-verify two-factor');
    }
    stampSession(fresh.session, fresh.link, fresh.username);
    return { session: fresh.session, link: fresh.link };
  };

  const finish = (base, link, username) => {
    const resolvedUser = stampSession(base, link, username);
    const session = platform.isSessionExpired
      ? createReauthSession(base, link, { isSessionExpired: platform.isSessionExpired, relogin })
      : base;
    return { session, link, username: resolvedUser };
  };

  // --- 2FA follow-up: the client is re-sending the mid-challenge session with a
  // `clMFA` answer. That session isn't a logged-in one yet, so don't run it
  // through the reuse fast path — resume the SSO flow with its cookies + the
  // challenge token stashed in its cache. ---
  //
  // Crucially, gate this on the session STILL carrying a pending `mfaToken`. A
  // client keeps `clMFA` in its stored `loginData` after login (so a silent
  // relogin can re-answer the factor), and re-sends it on every data call. Once
  // the challenge is cleared the token is deleted from the cache, so a completed
  // session no longer looks like a resume — otherwise every subsequent request
  // would wrongly re-run the whole ClassLink SSO+2FA flow and hang on
  // "Authenticating".
  const existingCache = (() => {
    if (!existingSession) return null;
    try {
      const parsed = typeof existingSession === 'string' ? JSON.parse(existingSession) : existingSession;
      return parsed?.cache || null;
    } catch { return null; }
  })();
  const isMfaResume =
    SSO_LOGIN_TYPES.has(loginType) && loginData.clMFA && existingCache?.mfaToken;
  if (isMfaResume) {
    const resumed = await performLogin(platform, loginType, loginData, progressTracker, existingSession);
    if (!resumed) return null;
    if (resumed.mfaRequired) return resumed; // still not cleared (e.g. wrong answer re-prompt)
    return finish(resumed.session, resumed.link, resumed.username);
  }

  // --- Fast path: reuse a session the client sent back ---
  if (existingSession && Object.keys(existingSession).length > 0) {
    const base = restoreCookiesIntoSession(createSession(), existingSession);
    // SSO logins (ClassLink) carry no link in loginData — the portal link was
    // discovered during the original login and stashed in the session cache. Fall
    // back to it so a reused SSO session never has to re-run ClassLink just to
    // relocate the district portal.
    // `cache.link` is client-supplied, so it must pass the same SSRF guard as a
    // loginData link — otherwise a forged session could point the server at an
    // internal host. An unsafe/garbled one is dropped and a fresh login runs.
    let cachedLink;
    try {
      cachedLink = base.cache?.link ? assertSafeHttpUrl(String(base.cache.link)) : undefined;
    } catch { cachedLink = undefined; }
    const link = resolveLink(platform, loginData) || cachedLink;

    if (base.isSessionFresh(5)) {
      if (link) return finish(base, link, loginData.username);
      // No link to fetch data with — fall through to a fresh login.
    } else if (link && platform.homeEndpoint !== undefined && platform.isSessionExpired) {
      // Cheap revalidation probe; if still logged in, skip the full login
      // (finish() re-stamps the validation time).
      try {
        const probe = await base.get(link + platform.homeEndpoint);
        if (!platform.isSessionExpired(probe.data)) {
          return finish(base, link, loginData.username);
        }
      } catch { /* fall through to a fresh login */ }
    }
  }

  // --- Fresh login ---
  const fresh = await performLogin(platform, loginType, loginData, progressTracker);
  if (!fresh) return null; // streaming error already sent
  if (fresh.mfaRequired) return fresh; // SSO second factor pending
  return finish(fresh.session, fresh.link, fresh.username);
}

export { authenticate, performLogin };
