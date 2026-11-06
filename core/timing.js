/**
 * Per-request timing of portal calls, logged as one JSON line when a route
 * finishes. It answers "where did this slow request spend its time?" without
 * enabling full request tracing: how many portal calls were made, how long they
 * took in total, how many timed out or were retried, and the slowest few.
 *
 * Only hosts and sanitized paths are logged: no query strings (OAuth codes live
 * there), no usernames, no page content.
 */

const SLOWEST_KEPT = 3;

/** Drop the query and mask path segments that look like ids or tokens. */
function describe(url) {
  const path = url.pathname
    .split('/')
    .map((segment) => (segment.length > 24 || /\d{4,}|[0-9a-f]{8}-[0-9a-f]{4}/i.test(segment) ? ':id' : segment))
    .join('/');
  return url.host + path;
}

/**
 * A failure in one line: its class, status and message (no query strings, which
 * can carry OAuth codes), plus where an unexpected one was thrown from.
 */
function describeError(error) {
  const message = String(error?.message ?? error).replace(/\?[^\s"')]*/g, '').slice(0, 200);
  const status = error?.status || error?.statusCode;
  const out = { name: error?.name || 'Error', status: status ?? null, message };
  // Only a bug (no status of its own) needs a stack frame to be found.
  if (!status && typeof error?.stack === 'string') {
    out.at = error.stack.split('\n').slice(1, 3).map((l) => l.trim().replace(/^at /, '')).join(' < ').slice(0, 200);
  }
  return out;
}

function createTiming(route) {
  const start = Date.now();
  const timing = {
    route,
    authMs: null,
    auth: null,
    error: null,
    calls: 0,
    portalMs: 0,
    retries: 0,
    timeouts: 0,
    failures: 0,
    slowest: [],

    /** Called by the session client after every portal call (each redirect hop). */
    record(url, ms, status, attempt) {
      timing.calls++;
      timing.portalMs += ms;
      if (attempt > 1) timing.retries++;
      if (status === 'timeout') timing.timeouts++;
      else if (status === 'error' || status >= 500) timing.failures++;
      const entry = { call: describe(url), ms, status };
      timing.slowest.push(entry);
      timing.slowest.sort((a, b) => b.ms - a.ms);
      if (timing.slowest.length > SLOWEST_KEPT) timing.slowest.length = SLOWEST_KEPT;
    },

    /** Mark the end of authentication (the "Authenticating" stage). */
    authDone() {
      timing.authMs = Date.now() - start;
    },

    /**
     * How this request was authenticated: "reused" (a fresh session came with it),
     * "revalidated" (one cheap probe), "relogin" (expired mid-request) or
     * "login: <reason>". Logins cost CPU and seconds, so the reason is the lead
     * for avoiding them. Reasons name a code path, never user data.
     */
    authHow(how) {
      timing.auth = timing.auth && how === 'relogin' ? `${timing.auth} + relogin` : how;
    },

    /** Remember why the route failed, for the summary line. */
    fail(error) {
      timing.error = describeError(error);
    },

    /** Write the summary line for this request. */
    log(outcome) {
      console.log(JSON.stringify({
        timing: timing.route,
        outcome,
        ms: Date.now() - start,
        authMs: timing.authMs,
        auth: timing.auth,
        calls: timing.calls,
        portalMs: timing.portalMs,
        retries: timing.retries,
        timeouts: timing.timeouts,
        failures: timing.failures,
        slowest: timing.slowest,
        ...(timing.error ? { error: timing.error } : {}),
      }));
    },
  };
  return timing;
}

export { createTiming };
