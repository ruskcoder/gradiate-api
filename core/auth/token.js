/**
 * `token` login — for portals whose API credential IS the session.
 *
 * Unlike the HTML portals, an LMS API (Canvas, and anything else bearer-based)
 * has no login handshake and no cookie: the caller supplies a long-lived access
 * token and every request carries it in an `Authorization: Bearer` header. So a
 * "login" here is just "stamp the header onto this session", which makes it free
 * — an important property, because core's transparent re-login path calls it
 * again on every expiry and there is nothing to re-negotiate.
 *
 * Two consequences core has to honour, both handled here:
 *
 *  1. The token lives in `loginData`, not in the cookie jar, so a session the
 *     client sends back deserializes WITHOUT the header. `applyToken` is
 *     therefore re-run on every reused session (see `stampSession` in
 *     `auth/index.js`), reading the token from the request or, failing that,
 *     from the session's own round-tripped `loginMetadata`.
 *
 *  2. A token API reports a rejected credential with an HTTP status and a JSON
 *     error body. axios would throw on those before the body ever reached the
 *     platform, so `validateStatus` is relaxed and the platform reads the status
 *     itself — which is also what lets `isSessionExpired` (a body-only hook) see
 *     an expired token at all.
 */

/** The token for this request: explicit `loginData` first, else the session's own. */
function tokenFrom(loginData, session) {
  const direct = loginData?.token || loginData?.accessToken;
  if (direct) return String(direct);
  const stored = session?.getLoginMetadata?.()?.loginData;
  const fromSession = stored?.token || stored?.accessToken;
  return fromSession ? String(fromSession) : undefined;
}

/** Stamp the bearer header (and the relaxed status handling) onto a session. */
function applyToken(session, token) {
  if (!token) return session;
  const target = session?.baseSession || session;
  const defaults = target?.defaults;
  if (!defaults) return session;

  defaults.headers = defaults.headers || {};
  defaults.headers.common = { ...(defaults.headers.common || {}), Authorization: `Bearer ${token}` };
  defaults.validateStatus = () => true;
  return session;
}

export { applyToken, tokenFrom };
