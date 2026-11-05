/**
 * Gradiate API — Cloudflare Worker entry point.
 *
 * `fetch` serves every HTTP request; `scheduled` runs the cron trigger that
 * replaced the old in-process push timer. Static files (the API docs SPA and
 * /static) are served by Workers Static Assets straight from docs/dist without
 * running this code at all; only API routes and the docs' client-side routes
 * reach the Worker.
 */

import { bindEnv, env } from './core/env.js';
import {
  HttpError, Router, json, finalize, preflight, readJsonBody, queryObject,
} from './core/http.js';
import * as webPushService from './web-push.js';
import { db } from './database.js';
import { createPlatformRoutes } from './core/index.js';
import hac from './hac/index.js';
import skywardLegacy from './skyward-legacy/index.js';
import powerschool from './powerschool/index.js';
import { addDemoRoutes } from './demo/index.js';

// Every platform is a registry object; core turns it into routes under its
// declared mount. Add a platform by importing it and pushing it here.
const platforms = [hac, skywardLegacy, powerschool];

const router = new Router();
for (const platform of platforms) createPlatformRoutes(platform, router);
addDemoRoutes(router);

// Routes behind the tighter limit: unauthenticated writes and lookups
// (subscription spam, username enumeration, push broadcasts).
const STRICT_ROUTES = new Set(['/referral', '/subscribe', '/push/trigger']);

const TOO_MANY = { success: false, message: 'Too many requests, please slow down.' };

/**
 * Cloudflare's rate limiting binding, keyed by client IP. Counts are kept per
 * Cloudflare location and are approximate. With no binding (local tests) or if
 * the binding errors, requests are allowed.
 */
async function rateLimited(limiter, ip) {
  if (!limiter || !ip) return false;
  try {
    const { success } = await limiter.limit({ key: ip });
    return !success;
  } catch {
    return false;
  }
}

// Kept at its original path so existing web/mobile builds don't 404, but the
// referral programme is gone: this now only answers "is this user blocked?".
// That check reads BLOCKED_USERS, never the database, so it no longer 500s for a
// username that has never signed in.
router.get('/referral', (req) => {
  let { username } = req.query;
  // `?username=a&username=b` parses to an array; reject anything non-string.
  if (!username || typeof username !== 'string') {
    return json(400, { error: 'username is required' });
  }
  username = username.toLowerCase();

  const blockedList = (env.BLOCKED_USERS || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return json(200, { blocked: blockedList.includes(username) });
});

router.get('/vapid-public-key', (req) => {
  const publicKey = webPushService.getVapidPublicKey(req.query.platform);
  return json(200, { publicKey });
});

// Public read of the announcements table for the web app. These are broadcast
// notices, not per-user data, so no auth is required.
router.get('/web-notifications', async () => {
  try {
    const data = await db.select('notifications?select=*&order=created_at.desc');
    return json(200, { data });
  } catch (error) {
    console.error('web-notifications fetch failed:', error);
    return json(500, { error: 'Internal Server Error' });
  }
});

// Public aggregate for the splash page: total users and users per school, never
// individual rows. Cached in the isolate and in the Cloudflare location's cache,
// so a busy splash page costs at most one tiny database read per STATS_TTL_MS.
const STATS_TTL_MS = 30 * 1000;
const STATS_HEADERS = { 'Cache-Control': 'public, max-age=30, stale-while-revalidate=60' };
let statsCache = { at: 0, body: null };

async function loadStats() {
  // `school_stats()` groups `users` in the database (see sql/school_stats.sql),
  // so the counts are always live and only ~one row per school comes back.
  const data = await db.rpc('school_stats');
  const schools = data
    .filter((row) => row.count > 0)
    .sort((a, b) => b.count - a.count)
    .map((row) => [row.school, Number(row.count)]);
  const total = schools.reduce((sum, [, count]) => sum + count, 0);
  return { total, schools };
}

router.get('/stats', async (req) => {
  try {
    if (statsCache.body && Date.now() - statsCache.at <= STATS_TTL_MS) {
      return json(200, statsCache.body, STATS_HEADERS);
    }
    // The Cache API is per Cloudflare location and only works on a custom
    // domain (it is a no-op on workers.dev), so it backs up the isolate cache.
    const cache = globalThis.caches?.default;
    const cacheKey = new Request(new URL('/__cache/stats', req.url).href);
    const cached = cache && await cache.match(cacheKey);
    if (cached) return new Response(cached.body, cached);

    const body = await loadStats();
    statsCache = { at: Date.now(), body };
    const response = json(200, body, STATS_HEADERS);
    if (cache) req.waitUntil(cache.put(cacheKey, response.clone()));
    return response;
  } catch (error) {
    console.error('stats fetch failed:', error);
    return json(500, { error: 'Internal Server Error' });
  }
});

router.post('/subscribe', async (req) => {
  try {
    const { payload, platform = 'web' } = req.body;
    if (!payload) {
      return json(400, { message: 'payload is required' });
    }
    await webPushService.addSubscription(payload, platform);
    console.log('New device subscribed:', platform);
    return json(201, { message: 'Subscription received successfully.' });
  } catch (error) {
    console.error('Failed to save subscription:', error);
    return json(500, { message: 'Failed to save subscription' });
  }
});

/** Broadcast and report what actually landed. */
async function broadcast() {
  const delivery = await webPushService.sendPushToAllDevices();
  // A broadcast where every ticket was rejected is not a success, however
  // cleanly the request itself completed — reporting it as one is what hid a
  // total Android push outage behind a 200.
  const attempted = delivery.expo.attempted + delivery.web.attempted;
  const sent = delivery.expo.sent + delivery.web.sent;
  return { success: attempted === 0 || sent > 0, delivery };
}

// Manual trigger, protected by a shared secret: broadcasting makes every
// subscribed client perform a portal fetch. The hourly cron below is the
// normal path.
router.post('/push/trigger', async (req) => {
  const configuredSecret = env.PUSH_TRIGGER_SECRET;
  const suppliedSecret = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '');
  if (!configuredSecret || suppliedSecret !== configuredSecret) {
    return json(401, { success: false, message: 'Unauthorized' });
  }
  try {
    return json(200, await broadcast());
  } catch (error) {
    console.error('Scheduled push trigger failed:', error);
    return json(500, { success: false, message: 'Push trigger failed' });
  }
});

// The docs SPA's client-side routes. `/` itself is served by the assets layer.
function isDocsRoute(path) {
  return path === '/' || path === '/platforms' || /^\/(?:guides|api|platforms)\//.test(path);
}

async function serveDocs(request) {
  if (!env.ASSETS) return new Response('Docs not built. Run `npm run docs:build`.', { status: 404 });
  const index = await env.ASSETS.fetch(new Request(new URL('/', request.url)));
  return new Response(index.body, { status: index.ok ? 200 : index.status, headers: index.headers });
}

async function handle(request, ctx) {
  if (request.method === 'OPTIONS') return preflight(request);

  const url = new URL(request.url);
  const method = request.method === 'HEAD' ? 'GET' : request.method;
  const handler = router.match(method, url.pathname);

  if (!handler) {
    if (method === 'GET' && isDocsRoute(url.pathname)) return serveDocs(request);
    return new Response(`Cannot ${request.method} ${url.pathname}`, {
      status: 404,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }

  const ip = request.headers.get('cf-connecting-ip');
  if (await rateLimited(env.RATE_LIMITER, ip)) return json(429, TOO_MANY);
  const path = url.pathname.toLowerCase().replace(/\/+$/, '');
  if (STRICT_ROUTES.has(path) && await rateLimited(env.STRICT_RATE_LIMITER, ip)) return json(429, TOO_MANY);

  const req = {
    method,
    url,
    headers: request.headers,
    query: queryObject(url.searchParams),
    body: {},
    ip,
    waitUntil: (promise) => ctx.waitUntil(promise),
  };

  try {
    if (method === 'POST' || method === 'PUT' || method === 'PATCH') {
      req.body = await readJsonBody(request);
    }
    return await handler(req);
  } catch (error) {
    if (!(error instanceof HttpError)) console.error('Global error handler:', error);
    const status = error.status || error.statusCode || 500;
    // Only surface a message for deliberate 4xx client errors (validation, auth).
    // For 5xx, hide the internal error text so stack/DB details aren't leaked.
    const message = status < 500 ? error.message || 'Bad Request' : 'Internal Server Error';
    return json(status, { success: false, message });
  }
}

export default {
  async fetch(request, workerEnv, ctx) {
    bindEnv(workerEnv);
    const response = finalize(await handle(request, ctx));
    if (request.method === 'HEAD') return new Response(null, response);
    return response;
  },

  // Cron trigger (wrangler.jsonc → triggers.crons): the hourly "go fetch"
  // broadcast. In-process timers don't survive on Workers, so this replaced
  // the setInterval the Node server used.
  async scheduled(controller, workerEnv, ctx) {
    bindEnv(workerEnv);
    ctx.waitUntil(
      broadcast()
        .then((result) => console.log('Scheduled push:', JSON.stringify(result)))
        .catch((error) => console.error('Scheduled push failed:', error))
    );
  },
};

export { handle, router };
