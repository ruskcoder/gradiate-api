/**
 * Push "go fetch" triggers to subscribed devices.
 *
 * Mobile devices are Expo push tokens (batched, 100 per request). Web devices
 * are Web Push endpoints, sent with VAPID authentication signed by WebCrypto.
 * Web pushes carry no payload: the web app's service worker has no push
 * handler, so the old encrypted "trigger" string was never read, and skipping
 * the per-device encryption keeps a broadcast cheap on the Worker's CPU budget.
 *
 * Every outbound call (Supabase pages, Expo batches, web pushes, prunes) is a
 * Worker subrequest, and the Free plan allows 50 per invocation. A broadcast
 * therefore spends at most `PUSH_SUBREQUEST_BUDGET` of them (default 45) and
 * reports anything left over as `deferred`; it is picked up by the next run.
 * Raise the budget on the Paid plan (10,000 per invocation).
 */

import { env } from './core/env.js';
import { db, inList } from './database.js';

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';
const WEB_PUBLIC_KEY = 'BBXwLd6Bj9NMB8PrS7CoWUMvY345XnMrqlEyjhWF_bEJjbhO465fN0m637BMmcYqtHX0BGPiLzQd33c6tlUDfNI';
const VAPID_SUBJECT = 'mailto:ruskcoder@gradexis.com';
const PAGE_SIZE = 1000;
const PRUNE_BATCH = 25;
const WEB_PUSH_TTL = '2419200'; // 4 weeks, web-push's default

const encoder = new TextEncoder();

function base64UrlToBytes(value) {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function bytesToBase64Url(bytes) {
  let binary = '';
  for (const b of new Uint8Array(bytes)) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const textToBase64Url = (text) => bytesToBase64Url(encoder.encode(text));

function getVapidPublicKey(platform) {
  return platform === 'web-firebase' ? env.FIREBASE_PUBLIC_KEY : WEB_PUBLIC_KEY;
}

function vapidKeyPair(platform) {
  return platform === 'web-firebase'
    ? { publicKey: env.FIREBASE_PUBLIC_KEY, privateKey: env.FIREBASE_PRIVATE_KEY }
    : { publicKey: WEB_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY };
}

// Imported signing keys, kept for the life of the isolate.
const signingKeys = new Map();

async function signingKey(platform) {
  const { publicKey, privateKey } = vapidKeyPair(platform);
  if (!publicKey || !privateKey) {
    throw new Error(`VAPID keys for ${platform} are not configured`);
  }
  const cacheKey = `${publicKey}:${privateKey}`;
  if (!signingKeys.has(cacheKey)) {
    const point = base64UrlToBytes(publicKey); // 0x04 || X || Y
    signingKeys.set(cacheKey, crypto.subtle.importKey(
      'jwk',
      {
        kty: 'EC',
        crv: 'P-256',
        d: privateKey,
        x: bytesToBase64Url(point.slice(1, 33)),
        y: bytesToBase64Url(point.slice(33, 65)),
      },
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['sign']
    ));
  }
  return signingKeys.get(cacheKey);
}

/** The VAPID Authorization header for one push service origin (RFC 8292). */
async function vapidAuthorization(platform, audience) {
  const header = textToBase64Url(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const claims = textToBase64Url(JSON.stringify({
    aud: audience,
    exp: Math.floor(Date.now() / 1000) + 12 * 60 * 60,
    sub: VAPID_SUBJECT,
  }));
  const unsigned = `${header}.${claims}`;
  const signature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    await signingKey(platform),
    encoder.encode(unsigned)
  );
  return `vapid t=${unsigned}.${bytesToBase64Url(signature)}, k=${vapidKeyPair(platform).publicKey}`;
}

/**
 * The stable identity of a subscription: web push endpoint or FCM token.
 * Used as the UNIQUE dedupe_key so re-subscribing the same device updates the
 * row in place instead of piling up duplicates.
 */
function dedupeKeyFor(payload) {
  return payload?.endpoint || payload?.token || null;
}

/**
 * Add (or refresh) a subscription. Upserts on dedupe_key so redundant
 * subscriptions for the same device collapse into one row.
 * @param {Object} payload - The subscription payload
 * @param {string} platform - web | web-firebase | expo
 */
async function addSubscription(payload, platform = 'web') {
  const dedupeKey = dedupeKeyFor(payload);
  if (!dedupeKey) {
    throw new Error('Subscription payload missing endpoint/token');
  }
  await db.upsert('push_subscriptions?on_conflict=dedupe_key', {
    dedupe_key: dedupeKey,
    platform,
    subscription: payload,
    updated_at: new Date().toISOString(),
  });
}

/**
 * Tracks the subrequests a broadcast may still make. `take()` reserves one and
 * returns false once the budget is spent.
 */
function createBudget(total) {
  let left = total;
  return {
    take() {
      if (left <= 0) return false;
      left--;
      return true;
    },
    get left() {
      return left;
    },
  };
}

/** Every subscription, a page at a time (PostgREST caps a single read). */
async function getSubscriptions(budget) {
  const rows = [];
  for (let offset = 0; budget.take(); offset += PAGE_SIZE) {
    const page = await db.select(
      `push_subscriptions?select=platform,subscription&order=dedupe_key&limit=${PAGE_SIZE}&offset=${offset}`
    );
    rows.push(...(page || []));
    if (!page || page.length < PAGE_SIZE) break;
  }
  return rows;
}

/** Delete dead subscriptions, many per request. */
async function pruneSubscriptions(keys, budget) {
  const unique = [...new Set(keys.filter(Boolean))];
  for (let i = 0; i < unique.length; i += PRUNE_BATCH) {
    if (!budget.take()) return;
    try {
      await db.remove(`push_subscriptions?dedupe_key=${inList(unique.slice(i, i + PRUNE_BATCH))}`);
    } catch (error) {
      console.error('Failed to prune push subscriptions:', error);
    }
  }
}

/**
 * Send the "go fetch" trigger to Expo push tokens (the mobile app).
 * `_contentAvailable` makes it a silent background push on iOS; `priority:
 * high` wakes Android from a data message. Tokens Expo reports as
 * DeviceNotRegistered are returned for pruning.
 */
async function sendExpoPush(expoSubs, budget, prune) {
  const summary = { attempted: expoSubs.length, sent: 0, failed: 0, errors: {}, deferred: 0 };
  const countError = (code) => {
    summary.errors[code] = (summary.errors[code] || 0) + 1;
  };

  for (let i = 0; i < expoSubs.length; i += 100) {
    const batchSubs = expoSubs.slice(i, i + 100);
    if (!budget.take()) {
      summary.deferred += expoSubs.length - i;
      break;
    }
    const messages = batchSubs.map(({ subscription }) => ({
      to: subscription.token,
      data: { trigger: 'grade_check' },
      priority: 'high',
      _contentAvailable: true,
    }));

    try {
      const res = await fetch(EXPO_PUSH_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(messages),
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`Expo answered ${res.status}: ${text.slice(0, 300)}`);
      const tickets = JSON.parse(text)?.data ?? [];
      tickets.forEach((ticket, idx) => {
        if (ticket.status === 'error') {
          summary.failed++;
          countError(ticket.details?.error || 'unknown');
          if (ticket.details?.error === 'DeviceNotRegistered') {
            prune.push(dedupeKeyFor(batchSubs[idx].subscription));
          } else {
            console.error('Expo rejected push ticket:', ticket.message, ticket.details);
          }
        } else {
          summary.sent++;
        }
      });
    } catch (error) {
      // The whole batch never reached Expo (network/5xx), so none of it landed.
      summary.failed += batchSubs.length;
      countError('request_failed');
      console.error('Failed to send Expo push batch:', error.message);
    }
  }
  return summary;
}

async function sendWebPush(webSubs, budget, prune) {
  const summary = { attempted: webSubs.length, sent: 0, failed: 0, pruned: 0, deferred: 0 };
  const authorizations = new Map();
  const sendable = [];

  for (const { subscription, platform } of webSubs) {
    // Web Push needs a real `{ endpoint }` subscription. Some legacy rows (e.g.
    // platform: 'android') hold a bare FCM token, which nothing here can send
    // to, so prune them rather than retrying them every run forever.
    if (!subscription?.endpoint) {
      prune.push(dedupeKeyFor(subscription));
      summary.pruned++;
      continue;
    }
    sendable.push({ subscription, platform });
  }

  // Random order, so a run that runs out of budget doesn't starve the same rows.
  for (let i = sendable.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [sendable[i], sendable[j]] = [sendable[j], sendable[i]];
  }

  for (let i = 0; i < sendable.length; i++) {
    if (!budget.take()) {
      summary.deferred = sendable.length - i;
      break;
    }
    const { subscription, platform } = sendable[i];
    try {
      const audience = new URL(subscription.endpoint).origin;
      const cacheKey = `${platform}|${audience}`;
      if (!authorizations.has(cacheKey)) {
        authorizations.set(cacheKey, vapidAuthorization(platform, audience));
      }
      const res = await fetch(subscription.endpoint, {
        method: 'POST',
        headers: { Authorization: await authorizations.get(cacheKey), TTL: WEB_PUSH_TTL, 'Content-Length': '0' },
      });
      await res.body?.cancel();
      if (res.ok) {
        summary.sent++;
      } else if (res.status === 404 || res.status === 410) {
        summary.failed++;
        summary.pruned++;
        prune.push(dedupeKeyFor(subscription));
      } else {
        summary.failed++;
        console.error(`Web push to ${platform} failed with status ${res.status}`);
      }
    } catch (error) {
      summary.failed++;
      console.error(`Failed to send notification to ${platform}:`, error.message);
    }
  }
  return summary;
}

/**
 * Send the "go fetch" trigger to every subscribed device.
 *
 * Returns a per-transport delivery summary. This used to return nothing and
 * merely console.error each rejection, so `/push/trigger` answered `success:
 * true` even when Expo rejected 100% of tickets — which hid a total Android
 * outage (missing FCM credentials) behind a green response for weeks.
 */
async function sendPushToAllDevices({ budget: total } = {}) {
  const budget = createBudget(total ?? (Number(env.PUSH_SUBREQUEST_BUDGET) || 45));
  const subscriptions = await getSubscriptions(budget);
  console.log('Sending push to', subscriptions.length, 'subscriptions');

  const prune = [];
  const expoSubs = subscriptions.filter(
    ({ platform, subscription }) => platform === 'expo' && subscription?.token
  );
  const webSubs = subscriptions.filter(({ platform }) => platform !== 'expo');

  // Expo first: one request covers 100 phones, so it is the best use of budget.
  const expo = await sendExpoPush(expoSubs, budget, prune);
  // Hold back what pruning needs, so dead rows are always cleaned up.
  const pruneReserve = Math.ceil((prune.length + webSubs.length) / PRUNE_BATCH);
  const webAllowance = Math.max(0, budget.left - pruneReserve);
  const webBudget = createBudget(webAllowance);
  const web = await sendWebPush(webSubs, webBudget, prune);
  for (let spent = webAllowance - webBudget.left; spent > 0; spent--) budget.take();
  await pruneSubscriptions(prune, budget);

  return { expo, web };
}

export {
  addSubscription,
  getSubscriptions,
  sendPushToAllDevices,
  getVapidPublicKey
};
