/**
 * Canvas authentication — link normalization and expired-token detection.
 *
 * There is no login handshake to implement: Canvas authenticates every request
 * with `Authorization: Bearer <access token>`, and core's `token` login type
 * (`core/auth/token.js`) already stamps that header onto the session. All this
 * platform has to contribute is what's Canvas-specific — where the API lives and
 * what a rejected token looks like coming back.
 */

import { ValidationError } from '../../core/errors.js';
import { assertSafeHttpUrl } from '../../core/platform.js';

/**
 * Reduce whatever the user pasted to the Canvas instance's origin with a
 * trailing slash. People copy the URL of whatever page they were on
 * (`.../courses/12345/assignments`) or the token page itself, and Canvas hosts
 * the API at the root, so keeping any path would break every call. A bare host
 * (`district.instructure.com`) is upgraded to https.
 */
function formatLink(link) {
  if (!link) return undefined;
  const raw = String(link).trim();
  if (!raw) return undefined;
  let url;
  try {
    url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    throw new ValidationError('Invalid Canvas link');
  }
  if (!url.hostname.includes('.')) throw new ValidationError('Invalid Canvas link');
  return assertSafeHttpUrl(`${url.protocol}//${url.host}/`);
}

/**
 * Does this response body say the token is no longer good?
 *
 * Core's expiry hook only ever sees response bodies, which is why the token
 * session relaxes `validateStatus` — a Canvas 401 arrives here as ordinary data:
 *   `{"status":"unauthenticated","errors":[{"message":"user authorization required"}]}`
 * A deleted or revoked token instead says `"Invalid access token."`.
 *
 * Note that "expired" is aspirational for token auth: core will re-run the
 * (free, network-less) token login and retry once, which only helps when the
 * failure was transient. A genuinely dead token fails again and surfaces as a
 * clean 401 from `assertOk`.
 */
function isSessionExpired(data) {
  if (!data) return false;
  if (typeof data === 'string') {
    return /user authorization required|invalid access token|insufficient scopes/i.test(data);
  }
  if (typeof data !== 'object') return false;
  if (data.status === 'unauthenticated') return true;
  const errors = Array.isArray(data.errors) ? data.errors : [];
  return errors.some((e) =>
    /user authorization required|invalid access token|insufficient scopes/i.test(
      typeof e === 'string' ? e : e?.message || ''
    )
  );
}

export { formatLink, isSessionExpired };
