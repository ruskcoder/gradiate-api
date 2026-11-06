import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createSession, createSuccessResponse, restoreCookiesIntoSession } from '../core/session.js';
import { bindEnv } from '../core/env.js';
import { createTiming } from '../core/timing.js';

const realFetch = globalThis.fetch;
let calls;

/** Route fetch calls to `handler(url, init)`; record each call. */
function mockFetch(handler) {
  globalThis.fetch = async (url, init) => {
    const headers = new Headers(init.headers);
    calls.push({ url, method: init.method, headers, body: init.body });
    return handler(url, init, headers);
  };
}

beforeEach(() => { calls = []; });
afterEach(() => { globalThis.fetch = realFetch; });

test('follows redirects hop by hop, collecting cookies set along the way', async () => {
  mockFetch((url) => {
    if (url === 'https://portal.example.org/login') {
      return new Response(null, { status: 302, headers: [['Location', '/home'], ['Set-Cookie', 'SID=1; Path=/'], ['Set-Cookie', 'Pref=x; Path=/']] });
    }
    return new Response('<html>home</html>', { status: 200 });
  });
  const session = createSession();
  const res = await session.post('https://portal.example.org/login', { user: 'a b', pass: 'p&q', skip: undefined, flag: true });

  assert.equal(res.data, '<html>home</html>');
  assert.equal(res.request.res.responseUrl, 'https://portal.example.org/home');
  assert.equal(calls[0].body, 'user=a+b&pass=p%26q&flag=true');
  assert.equal(calls[0].headers.get('content-type'), 'application/x-www-form-urlencoded');
  // 302 after POST becomes a GET without a body, carrying the new cookies.
  assert.equal(calls[1].method, 'GET');
  assert.equal(calls[1].body, undefined);
  assert.equal(calls[1].headers.get('content-type'), null);
  assert.equal(calls[1].headers.get('cookie'), 'SID=1; Pref=x');
});

test('maxRedirects: 0 returns the redirect itself', async () => {
  mockFetch(() => new Response(null, { status: 302, headers: { Location: 'https://x.example/cb?code=abc&s=1' } }));
  const res = await createSession().get('https://idp.example/auth', {
    maxRedirects: 0,
    validateStatus: (s) => s >= 200 && s < 400,
  });
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, 'https://x.example/cb?code=abc&s=1');
});

test('non-2xx throws an error carrying the response and status', async () => {
  mockFetch(() => new Response('nope', { status: 403 }));
  await assert.rejects(createSession().get('https://x.example/'), (error) => {
    assert.equal(error.status, 403);
    assert.equal(error.response.status, 403);
    assert.equal(error.message, 'Request failed with status code 403');
    return true;
  });
});

test('parses JSON bodies and sends JSON when asked', async () => {
  mockFetch(() => new Response('{"ok":true}', { status: 200 }));
  const res = await createSession().post('https://x.example/ws', { ids: [1] }, {
    headers: { 'content-type': 'application/json;charset=UTF-8' },
  });
  assert.deepEqual(res.data, { ok: true });
  assert.equal(calls[0].body, '{"ids":[1]}');
  assert.equal(calls[0].headers.get('content-type'), 'application/json;charset=UTF-8');
});

test('drops Authorization on a cross-site redirect', async () => {
  mockFetch((url) => url.startsWith('https://a.example')
    ? new Response(null, { status: 302, headers: { Location: 'https://b.example/next' } })
    : new Response('done'));
  await createSession().get('https://a.example/start', { headers: { Authorization: 'Bearer t' } });
  assert.equal(calls[0].headers.get('authorization'), 'Bearer t');
  assert.equal(calls[1].headers.get('authorization'), null);
});

test('session envelope round-trips cookies and cache', async () => {
  mockFetch(() => new Response('ok', { headers: { 'Set-Cookie': 'K=v; Path=/' } }));
  const session = createSession();
  await session.get('https://hac.example.org/HomeAccess');
  session.cache.link = 'https://hac.example.org/';
  const envelope = JSON.parse(JSON.stringify(createSuccessResponse({}, session).session));

  const restored = restoreCookiesIntoSession(createSession(), envelope);
  assert.equal(restored.cache.link, 'https://hac.example.org/');
  await restored.get('https://hac.example.org/HomeAccess/Content');
  assert.equal(calls.at(-1).headers.get('cookie'), 'K=v');
});

/** A portal that never answers, except that it honours the abort signal. */
const stalled = (url, init) => new Promise((resolve, reject) => {
  init.signal?.addEventListener('abort', () => reject(init.signal.reason));
});

test('a stalled GET is abandoned after PORTAL_TIMEOUT_MS and retried once', async () => {
  bindEnv({ PORTAL_TIMEOUT_MS: '40', PORTAL_RETRIES: '1' });
  let attempt = 0;
  mockFetch((url, init) => (++attempt === 1 ? stalled(url, init) : new Response('ok')));
  const timing = createTiming('/test');
  const res = await createSession(timing).get('https://slow.example/page');
  assert.equal(res.data, 'ok');
  assert.equal(calls.length, 2);
  assert.equal(timing.timeouts, 1);
  assert.equal(timing.retries, 1);
  assert.equal(timing.calls, 2);
});

test('a stalled POST is not retried and fails with a 504 naming the host', async () => {
  bindEnv({ PORTAL_TIMEOUT_MS: '40', PORTAL_RETRIES: '1' });
  mockFetch(stalled);
  await assert.rejects(createSession().post('https://slow.example/login', { a: 1 }), (error) => {
    assert.equal(error.status, 504);
    assert.equal(error.message, 'slow.example took too long to respond');
    return true;
  });
  assert.equal(calls.length, 1);
});

test('timing keeps the slowest calls without query strings or token-like segments', () => {
  const timing = createTiming('/hac/classes');
  timing.record(new URL('https://launchpad.classlink.com/login/twoformauth/c4b800e6-bd15-46dc-9637-b71c709d9d6a?x=secret'), 900, 200, 1);
  timing.record(new URL('https://hac.example.org/HomeAccess/Content/Student/Assignments.aspx'), 300, 200, 1);
  assert.deepEqual(timing.slowest.map((s) => s.call), [
    'launchpad.classlink.com/login/twoformauth/:id',
    'hac.example.org/HomeAccess/Content/Student/Assignments.aspx',
  ]);
  assert.equal(timing.portalMs, 1200);
});

test('timing says how a request authenticated and why it failed, without query strings', () => {
  const lines = [];
  const realLog = console.log;
  console.log = (line) => lines.push(JSON.parse(line));
  try {
    const timing = createTiming('/hac/classes');
    timing.authHow('login: session expired');
    timing.authHow('relogin');
    const error = Object.assign(new TypeError('x is undefined at https://hac.example.org/a?code=SECRET'), { status: undefined });
    timing.fail(error);
    timing.log('error 500');
    const known = createTiming('/hac/info');
    known.fail(Object.assign(new Error('Invalid session or password'), { status: 401 }));
    known.log('error 401');
  } finally {
    console.log = realLog;
  }
  assert.equal(lines[0].auth, 'login: session expired + relogin');
  assert.equal(lines[0].error.name, 'TypeError');
  assert.ok(!JSON.stringify(lines[0]).includes('SECRET'));
  assert.ok(lines[0].error.at, 'an unexpected error names where it was thrown');
  assert.equal(lines[1].error.status, 401);
  assert.equal(lines[1].error.at, undefined, 'a handled error needs no stack frame');
});
