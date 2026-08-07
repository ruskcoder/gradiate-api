import webPush from 'web-push';
import axios from 'axios';
import dotenv from 'dotenv';
import process from 'process';
import supabase from './database.js';

dotenv.config();

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';

const webPublicKey = "BBXwLd6Bj9NMB8PrS7CoWUMvY345XnMrqlEyjhWF_bEJjbhO465fN0m637BMmcYqtHX0BGPiLzQd33c6tlUDfNI";
const webPrivateKey = process.env.VAPID_PRIVATE_KEY;

const firebasePublicKey = process.env.FIREBASE_PUBLIC_KEY;
const firebasePrivateKey = process.env.FIREBASE_PRIVATE_KEY;

webPush.setVapidDetails(
  'mailto:ruskcoder@gradexis.com',
  webPublicKey,
  webPrivateKey
);

/**
 * The stable identity of a subscription: web push endpoint or FCM token.
 * Used as the UNIQUE dedupe_key so re-subscribing the same device updates the
 * row in place instead of piling up duplicates.
 * @param {Object} payload
 * @returns {string|null}
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

  const { error } = await supabase
    .from('push_subscriptions')
    .upsert(
      {
        dedupe_key: dedupeKey,
        platform,
        subscription: payload,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'dedupe_key' }
    );

  if (error) throw error;
}

/**
 * Get all subscriptions from the store.
 * @returns {Promise<Array<{platform: string, subscription: Object}>>}
 */
async function getSubscriptions() {
  const { data, error } = await supabase
    .from('push_subscriptions')
    .select('platform, subscription');

  if (error) throw error;
  return data || [];
}

/**
 * Delete a dead subscription (expired endpoint / unregistered token).
 * @param {string} dedupeKey
 */
async function removeSubscription(dedupeKey) {
  if (!dedupeKey) return;
  await supabase.from('push_subscriptions').delete().eq('dedupe_key', dedupeKey);
}

/**
 * True if a web-push error means the subscription is permanently gone and
 * should be pruned (as opposed to a transient failure worth keeping).
 */
function isGoneError(error) {
  return error?.statusCode === 404 || error?.statusCode === 410;
}

/**
 * Send the "go fetch" trigger to Expo push tokens (the mobile app). Batched
 * 100/request per Expo's limit. `_contentAvailable` makes it a silent
 * background push on iOS; `priority: high` wakes Android from a data message.
 * Tokens Expo reports as DeviceNotRegistered are pruned.
 * @param {Array<{subscription: Object}>} expoSubs
 */
async function sendExpoPush(expoSubs) {
  if (expoSubs.length === 0) return;

  for (let i = 0; i < expoSubs.length; i += 100) {
    const batchSubs = expoSubs.slice(i, i + 100);
    const messages = batchSubs.map(({ subscription }) => ({
      to: subscription.token,
      data: { trigger: 'grade_check' },
      priority: 'high',
      _contentAvailable: true,
    }));

    try {
      const res = await axios.post(EXPO_PUSH_URL, messages, {
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      });
      const tickets = res.data?.data ?? [];
      await Promise.all(
        tickets.map(async (ticket, idx) => {
          if (ticket.status === 'error') {
            if (ticket.details?.error === 'DeviceNotRegistered') {
              console.log('Pruning dead expo subscription');
              await removeSubscription(dedupeKeyFor(batchSubs[idx].subscription));
            } else {
              console.error('Expo rejected push ticket:', ticket.message, ticket.details);
            }
          }
        })
      );
      console.log(`Grade check trigger sent (expo x${batchSubs.length})`);
    } catch (error) {
      console.error('Failed to send Expo push batch:', error?.response?.data || error.message);
    }
  }
}

/**
 * Send the "go fetch" trigger to every subscribed device.
 * Duplicates are already prevented by the UNIQUE dedupe_key, so no in-memory
 * dedup is needed here.
 */
async function sendPushToAllDevices() {
  const subscriptions = await getSubscriptions();
  console.log('Sending push to', subscriptions.length, 'subscriptions');
  const notificationPayload = "trigger";

  // Expo tokens go out as one (or few) batched request(s); everything else is
  // sent per-subscription below.
  const expoSubs = subscriptions.filter(
    ({ platform, subscription }) => platform === 'expo' && subscription?.token
  );
  const expoPromise = sendExpoPush(expoSubs);

  const promises = subscriptions
    .filter(({ platform }) => platform !== 'expo')
    .map(async ({ subscription, platform }) => {
    const dedupeKey = dedupeKeyFor(subscription);

    // web-push requires a real `{ endpoint, keys }` subscription. Some legacy
    // rows (e.g. platform: 'android') hold a bare FCM token instead — there's
    // no FCM-sending code path in this service, so those can never succeed.
    // Prune them here rather than retrying (and erroring) every interval forever.
    if (!subscription?.endpoint) {
      console.log(`Pruning unsendable ${platform} subscription (no endpoint)`);
      await removeSubscription(dedupeKey);
      return;
    }

    // web / web-firebase (both go out via VAPID web-push)
    try {
      if (platform === 'web-firebase') {
        webPush.setVapidDetails('mailto:ruskcoder@gradexis.com', firebasePublicKey, firebasePrivateKey);
      } else {
        webPush.setVapidDetails('mailto:ruskcoder@gradexis.com', webPublicKey, webPrivateKey);
      }
      return await webPush.sendNotification(subscription, notificationPayload);
    } catch (error) {
      if (isGoneError(error)) {
        console.log('Pruning dead web subscription');
        await removeSubscription(dedupeKey);
      } else {
        console.error(`Failed to send notification to ${platform}:`, error);
      }
    }
  });

  return Promise.all([expoPromise, ...promises]);
}

/**
 * Get the appropriate VAPID public key
 * @param {string} platform - The platform type
 * @returns {string} The public key
 */
function getVapidPublicKey(platform) {
  if (platform === 'web-firebase') {
    return firebasePublicKey;
  }
  return webPublicKey;
}

export {
  addSubscription,
  getSubscriptions,
  removeSubscription,
  sendPushToAllDevices,
  getVapidPublicKey
};
