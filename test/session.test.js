import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createSession, createSuccessResponse, restoreCookiesIntoSession } from '../core/session.js';

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
