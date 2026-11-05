import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../index.js';
import ProgressTracker from '../core/progressTracker.js';

const ctx = { waitUntil() {} };
const call = (path, init = {}, env = {}) => worker.fetch(new Request(`https://api.test${path}`, init), env, ctx);
const post = (path, body, env) => call(path, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: typeof body === 'string' ? body : JSON.stringify(body),
}, env);

test('CORS preflight is cached by the browser for a day', async () => {
  const res = await call('/hac/classes', {
    method: 'OPTIONS',
    headers: { 'Access-Control-Request-Headers': 'content-type' },
  });
  assert.equal(res.status, 204);
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
  assert.equal(res.headers.get('access-control-allow-headers'), 'content-type');
  assert.equal(res.headers.get('access-control-max-age'), '86400');
});

test('routes match case-insensitively, with or without a trailing slash', async () => {
  for (const path of ['/hac', '/HAC/', '/hac/']) {
    const res = await post(path, {});
    assert.equal(res.status, 200, path);
    assert.deepEqual(await res.json(), { message: 'HAC API', success: true });
  }
});

test('responses carry CORS and security headers', async () => {
  const res = await post('/hac', {});
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.match(res.headers.get('content-security-policy'), /default-src 'self'/);
});

test('bad JSON and missing fields are 400s with a message', async () => {
  const bad = await post('/hac/classes', '{nope');
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).message, /^Invalid JSON/);

  const missing = await post('/hac/classes', { loginType: 'carrier-pigeon' });
  assert.equal(missing.status, 400);
  assert.match((await missing.json()).message, /loginType must be one of/);
});

test('unimplemented capabilities and unknown paths are 404s', async () => {
  const ipr = await post('/powerschool/ipr', {});
  assert.equal(ipr.status, 404);
  assert.equal((await ipr.json()).message, 'PowerSchool does not support ipr');
  const unknown = await call('/nope');
  assert.equal(unknown.status, 404);
});

test('rate limited requests get a 429', async () => {
  const env = { RATE_LIMITER: { limit: async () => ({ success: false }) } };
  const res = await call('/vapid-public-key', { headers: { 'cf-connecting-ip': '1.2.3.4' } }, env);
  assert.equal(res.status, 429);
});

test('referral lookup reads BLOCKED_USERS', async () => {
  const env = { BLOCKED_USERS: 'Alice, bob' };
  const res = await call('/referral?username=ALICE', {}, env);
  assert.deepEqual(await res.json(), { blocked: true });
  const twice = await call('/referral?username=a&username=b', {}, env);
  assert.equal(twice.status, 400);
});

test('push trigger requires the shared secret', async () => {
  const res = await call('/push/trigger', { method: 'POST' }, { PUSH_TRIGGER_SECRET: 's3cret' });
  assert.equal(res.status, 401);
});

test('streaming progress uses the framing the apps parse', async () => {
  const tracker = new ProgressTracker(true);
  const response = tracker.response();
  tracker.update(4, 'Authenticating');
  tracker.complete({ success: true, n: 1 });
  const text = await response.text();
  assert.equal(text, '{"percent":4,"message":"Authenticating"}\n\n{"success":true,"n":1}');
  assert.equal(response.headers.get('content-type'), 'text/event-stream; charset=utf-8');
});

test('non-streaming errors become JSON with the status', async () => {
  const tracker = new ProgressTracker(false);
  tracker.error(401, 'Invalid username or password');
  const res = tracker.response();
  assert.equal(res.status, 401);
  assert.deepEqual(await res.json(), { success: false, status: 401, message: 'Invalid username or password' });
});
