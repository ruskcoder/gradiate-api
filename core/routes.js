/**
 * The public face of every platform.
 *
 * There is exactly ONE route table for the whole API, declared here. Each
 * platform is a registry object exposing `data` functions; `createPlatformRoutes`
 * adds a route to the Worker's router for every capability the platform
 * actually implements (missing ones return a standard 404). Core owns all the
 * plumbing — authentication, session reuse/relogin, SSE progress streaming, the
 * `{ success, ..., session }` envelope, and error formatting — so a platform
 * never touches the request or response.
 *
 * A data function is just: `(session, link, options, progressTracker) => data`.
 */

import ProgressTracker from './progressTracker.js';
import { json } from './http.js';
import { createSession, createSuccessResponse } from './session.js';
import { authenticate } from './auth/index.js';
import { applyGradeOverrides } from './testOverrides.js';
import { recordLogin } from '../users.js';
import { HTTP_STATUS, AuthenticationError } from './errors.js';

// The routes whose payloads carry class averages, and so can be faked for the
// test account. Everything else passes through untouched.
const GRADE_ROUTE_KEYS = new Set(['classes', 'singleClass']);

// path -> which platform.data capability serves it, plus its progress label.
const ROUTE_TABLE = [
  { path: '/info', key: 'info', stage: 'Fetching student info' },
  { path: '/classes', key: 'classes', stage: 'Fetching classes' },
  { path: '/single-class', key: 'singleClass', stage: 'Fetching class' },
  { path: '/schedule', key: 'schedule', stage: 'Fetching schedule' },
  { path: '/bellSchedule', key: 'bellSchedule', stage: 'Fetching bell schedule' },
  { path: '/attendance', key: 'attendance', stage: 'Fetching attendance' },
  { path: '/teachers', key: 'teachers', stage: 'Fetching teachers' },
  { path: '/reportCard', key: 'reportCard', stage: 'Fetching report cards' },
  { path: '/ipr', key: 'ipr', stage: 'Fetching progress reports' },
  { path: '/transcript', key: 'transcript', stage: 'Fetching transcript' },
];

/**
 * Record the login in `users` and stamp `username` + `firstLoggedIn` onto the
 * info payload. Bookkeeping only — a Supabase hiccup must not cost the user
 * their info, and an unresolved username is never written.
 */
async function withLoginRecord(data, username, waitUntil) {
  let firstLoggedIn = null;
  const key = (username || '').toLowerCase();
  if (key && key !== 'unknown') {
    try {
      ({ firstLoggedIn } = await recordLogin(key, data?.school, data?.name, waitUntil));
    } catch (error) {
      console.error('recordLogin failed:', error);
    }
  }
  return { username, firstLoggedIn, ...data };
}

function isStreaming(req) {
  return req.body?.stream === true || req.body?.stream === 'true';
}

/**
 * Emit a "second factor required" response for an SSO login that stopped at a 2FA
 * challenge. It is a normal 200 (not an error) carrying `mfaRequired` plus the
 * mid-challenge `session` envelope: the client renders the prompt, then re-calls
 * the same route with that session and `loginData.clMFA` (the PIN string or the
 * chosen icon filename) to finish logging in.
 */
function respondMfaChallenge(progressTracker, auth) {
  const base = auth.session.baseSession || auth.session;
  const envelope = createSuccessResponse(
    { mfaRequired: true, mfaType: auth.mfaType, icons: auth.icons || undefined },
    base
  );
  envelope.success = false; // login is not complete until the factor is cleared
  progressTracker.complete(envelope);
}

/** Errors outside a progress tracker answer as `{ success: false, message }`. */
function sendError(error) {
  return json(error.status || 500, { success: false, message: error.message || 'Internal Server Error' });
}

/**
 * Run a route's work against a ProgressTracker. A streaming request gets its
 * Response straight away while the work keeps writing to it; otherwise the
 * Response is built once the work is done.
 */
function track(req, defaultMessage, work) {
  const progressTracker = new ProgressTracker(isStreaming(req));
  const done = (async () => {
    try {
      await work(progressTracker);
    } catch (error) {
      progressTracker.error(error.status || error.statusCode || 500, error.message || defaultMessage);
    } finally {
      progressTracker.finish();
    }
  })();
  if (progressTracker.streaming) {
    req.waitUntil(done);
    return progressTracker.response();
  }
  return done.then(() => progressTracker.response());
}

/** Add every route for `platform` to `router`. */
function createPlatformRoutes(platform, router) {
  const mount = platform.mount;

  // Root announce route.
  router.post(mount, () => json(200, { message: `${platform.name} API`, success: true }));

  // /districts — public, unauthenticated helper: given a portal `link`, report
  // whether that host fronts multiple districts (a shared HAC login `<select>`)
  // so the client can show a district picker only when needed. Mounted only for
  // platforms that implement it.
  if (typeof platform.listDistricts === 'function') {
    router.post(`${mount}/districts`, async (req) => {
      try {
        const link = req.body?.loginData?.link || req.body?.link;
        if (!link) {
          return json(HTTP_STATUS.BAD_REQUEST, { success: false, message: 'link is required' });
        }
        const result = await platform.listDistricts(createSession(), link);
        return json(200, { success: true, ...result });
      } catch (error) {
        return sendError(error);
      }
    });
  }

  // /authMethods — public, unauthenticated helper: given a portal `link`, report
  // which sign-in methods that district's portal offers ({ credentials, microsoft,
  // ssoUrl }) so the client can show the right buttons (some PowerSchool districts
  // are credentials-only, others Microsoft-SSO-only). Mounted only for platforms
  // that implement it.
  if (typeof platform.authMethods === 'function') {
    router.post(`${mount}/authMethods`, async (req) => {
      try {
        const rawLink = req.body?.loginData?.link || req.body?.link;
        if (!rawLink) {
          return json(HTTP_STATUS.BAD_REQUEST, { success: false, message: 'link is required' });
        }
        const link = (platform.formatLink || ((l) => l))(rawLink);
        const result = await platform.authMethods(createSession(), link);
        return json(200, { success: true, ...result });
      } catch (error) {
        return sendError(error);
      }
    });
  }

  // /login — authenticate only, hand back the session envelope. Fetches no data,
  // but forces a validation probe (through the reauth wrapper) when possible so
  // an expired session is caught here rather than on the next data call.
  router.post(`${mount}/login`, (req) => track(req, 'Login failed', async (progressTracker) => {
    const auth = await authenticate(req, platform, progressTracker);
    if (!auth) return;
    if (auth.mfaRequired) return respondMfaChallenge(progressTracker, auth);

    if (platform.homeEndpoint !== undefined && platform.isSessionExpired) {
      const probe = await auth.session.get(auth.link + platform.homeEndpoint);
      if (platform.isSessionExpired(probe.data)) {
        throw new AuthenticationError('Invalid session or password');
      }
    }

    const base = auth.session.baseSession || auth.session;
    progressTracker.complete(createSuccessResponse({}, base));
  }));

  // Data routes — one per capability the platform implements.
  for (const { path, key, stage } of ROUTE_TABLE) {
    if (typeof platform.data?.[key] !== 'function') continue;

    router.post(`${mount}${path}`, (req) => track(req, 'An error occurred', async (progressTracker) => {
      const auth = await authenticate(req, platform, progressTracker);
      if (!auth) return;
      if (auth.mfaRequired) return respondMfaChallenge(progressTracker, auth);

      progressTracker.update(50, stage);
      const data = await platform.data[key](auth.session, auth.link, req.body?.options || {}, progressTracker);

      // Test-account grade faking, applied here rather than inside each
      // platform so every portal gets it for free. A no-op for real users.
      let shaped = GRADE_ROUTE_KEYS.has(key)
        ? await applyGradeOverrides(data, auth.username)
        : data;

      // User bookkeeping, likewise done here so every platform records logins.
      if (key === 'info') shaped = await withLoginRecord(shaped, auth.username, req.waitUntil);

      const base = auth.session.baseSession || auth.session;
      progressTracker.complete(createSuccessResponse(shaped, base));
    }));
  }

  // Any canonical route the platform did NOT implement -> standard 404.
  for (const { path, key } of ROUTE_TABLE) {
    if (typeof platform.data?.[key] === 'function') continue;
    router.post(`${mount}${path}`, () => json(HTTP_STATUS.NOT_FOUND, {
      success: false,
      message: `${platform.name} does not support ${key}`,
    }));
  }

  return router;
}

export { createPlatformRoutes, ROUTE_TABLE };
