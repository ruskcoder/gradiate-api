import { fileURLToPath } from 'url';
import path from 'path';
import process from 'process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import dotenv from 'dotenv';

dotenv.config();

const app = express();

// Sit behind a reverse proxy (Vercel / nginx) in production; trust it so the
// rate limiter keys off the real client IP rather than the proxy's.
app.set('trust proxy', 1);

// Baseline security headers (nosniff, frameguard, HSTS, etc.). The API serves
// JSON + a tiny static site, so the permissive defaults are fine.
app.use(helmet());

// Cap request bodies. Login/session envelopes are small; without a limit a
// client could POST an arbitrarily large body and exhaust memory.
app.use(express.json({ limit: '256kb' }));

app.use((err, req, res, next) => {
  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    return res.status(400).json({ 
      success: false, 
      message: 'Invalid JSON: ' + err.message 
    });
  }
  next(err);
});

import * as webPushService from './web-push.js';
import supabase from './database.js';
import { createPlatformRoutes } from './core/index.js';
import hac from './hac/index.js';
import skywardLegacy from './skyward-legacy/index.js';
import powerschool from './powerschool/index.js';
import demo from './demo/index.js';

// Every platform is a registry object; core turns it into routes and mounts it
// at its declared prefix. Add a platform by importing it and pushing it here.
const platforms = [hac, skywardLegacy, powerschool];

// All origins are allowed (Vercel preview deployments use unpredictable hosts).
// The API uses no cookies/credentials from the browser, so this is safe.
app.use(cors());

// Global rate limit — a coarse ceiling against scraping/abuse. The data routes
// make outbound requests to school portals on the caller's behalf, so an
// unthrottled client could use the API to hammer those portals.
const globalLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: Number(process.env.RATE_LIMIT_PER_MIN) || 120,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { success: false, message: 'Too many requests, please slow down.' },
});
app.use(globalLimiter);

// Tighter limit for unauthenticated write/enumeration endpoints (subscription
// spam, username enumeration).
const strictLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: Number(process.env.STRICT_RATE_LIMIT_PER_MIN) || 20,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { success: false, message: 'Too many requests, please slow down.' },
});

for (const platform of platforms) {
  app.use(platform.mount, createPlatformRoutes(platform));
}
app.use('/demo', demo);

app.use('/static', express.static(__dirname + '/static'));
app.get('/', (req, res) => {
  res.sendFile(__dirname + '/index.html');
});

// Kept at its original path so existing web/mobile builds don't 404, but the
// referral programme is gone: this now only answers "is this user blocked?".
// That check reads BLOCKED_USERS, never the database, so it no longer 500s for a
// username that has never signed in.
app.get('/referral', strictLimiter, async (req, res) => {
  try {
    let { username } = req.query;
    // `?username=a&username=b` parses to an array; reject anything non-string.
    if (!username || typeof username !== 'string') {
      return res.status(400).json({ error: 'username is required' });
    }
    username = username.toLowerCase();

    const blockedEnv = process.env.BLOCKED_USERS || '';
    const blockedList = blockedEnv.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
    const blocked = blockedList.includes(username);

    res.json({ blocked });
  } catch (error) {
    console.error('Blocked-user lookup failed:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

app.get('/vapid-public-key', (req, res) => {
  const { platform } = req.query;
  const publicKey = webPushService.getVapidPublicKey(platform);
  res.json({ publicKey });
});

// Public read of the announcements table for the web app. These are broadcast
// notices, not per-user data, so no auth is required.
app.get('/web-notifications', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('notifications')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) {
      throw error;
    }

    res.json({ data });
  } catch (error) {
    console.error('web-notifications fetch failed:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

app.post('/subscribe', strictLimiter, async (req, res) => {
  try {
    const { payload, platform = 'web' } = req.body;
    if (!payload) {
      return res.status(400).json({ message: 'payload is required' });
    }
    await webPushService.addSubscription(payload, platform);
    console.log('New device subscribed:', platform);
    res.status(201).json({ message: 'Subscription received successfully.' });
  } catch (error) {
    console.error('Failed to save subscription:', error);
    res.status(500).json({ message: 'Failed to save subscription' });
  }
});

async function sendPushToAllDevices() {
  return webPushService.sendPushToAllDevices();
}

// Deployment schedulers can call this endpoint because in-process timers do not
// survive scale-to-zero/serverless restarts. Keep it protected: broadcasting a
// trigger makes every subscribed client perform a portal fetch.
app.post('/push/trigger', strictLimiter, async (req, res) => {
  const configuredSecret = process.env.PUSH_TRIGGER_SECRET;
  const suppliedSecret = req.get('authorization')?.replace(/^Bearer\s+/i, '');
  if (!configuredSecret || suppliedSecret !== configuredSecret) {
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  }
  try {
    const delivery = await sendPushToAllDevices();
    // Report what actually landed. A broadcast where every ticket was rejected
    // is not a success, however cleanly the request itself completed — reporting
    // it as one is what hid a total Android push outage behind a 200.
    const attempted = delivery.expo.attempted + delivery.web.attempted;
    const sent = delivery.expo.sent + delivery.web.sent;
    res.json({ success: attempted === 0 || sent > 0, delivery });
  } catch (error) {
    console.error('Scheduled push trigger failed:', error);
    res.status(500).json({ success: false, message: 'Push trigger failed' });
  }
});

// How often to fire the "go fetch" trigger, in minutes. Falls back to 1 hour.
const pushIntervalMinutes = Number(process.env.PUSH_INTERVAL_MINUTES) || 60;
setInterval(() => {
  sendPushToAllDevices()
    .catch(() => console.error('Failed to send push notifications.'));
}, 1000 * 60 * pushIntervalMinutes);
console.log(`Push trigger scheduled every ${pushIntervalMinutes} minute(s)`);

app.use((err, req, res, next) => {
  console.error('Global error handler:', err);

  const status = err.status || err.statusCode || 500;
  // Only surface a message for deliberate 4xx client errors (validation, auth).
  // For 5xx, hide the internal error text so stack/DB details aren't leaked.
  const message = status < 500 ? err.message || 'Bad Request' : 'Internal Server Error';

  if (!res.headersSent) {
    res.status(status).json({
      success: false,
      message,
    });
  }
});

const port = Number(process.env.PORT) || 3000;
app.listen(port, () => {
  console.log(`Main App listening on http://localhost:${port}`);
});

export default app;
