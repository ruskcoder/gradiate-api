import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CookieJar } from '../core/cookies.js';

test('stores and sends cookies by domain, path and secure flag', () => {
  const jar = new CookieJar();
  jar.setCookieSync('A=1; Path=/; HttpOnly; Secure; SameSite=Lax', 'https://x.example.com/a/b');
  jar.setCookieSync('B=2; Domain=example.com; Path=/p; Max-Age=3600', 'https://x.example.com/');
  jar.setCookieSync('C=3; Expires=Wed, 21 Oct 2099 07:28:00 GMT', 'https://x.example.com/dir/page');
  // Same order tough-cookie produced: longest path first.
  assert.equal(jar.getCookieString('https://x.example.com/p/q'), 'B=2; A=1');
  assert.equal(jar.getCookieString('https://y.example.com/p'), 'B=2');
  assert.equal(jar.getCookieString('http://x.example.com/'), '');
  assert.equal(jar.getCookieString('https://x.example.com/dir/x'), 'C=3; A=1');
  assert.equal(jar.getCookieString('https://other.com/'), '');
});

test('rejects cookies for foreign domains and public suffixes', () => {
  const jar = new CookieJar();
  assert.equal(jar.setCookieSync('A=1; Domain=evil.com', 'https://x.example.com/'), undefined);
  assert.equal(jar.setCookieSync('A=1; Domain=com', 'https://x.example.com/'), undefined);
  assert.equal(jar.setCookieSync('novalue', 'https://x.example.com/'), undefined);
  assert.equal(jar.setCookieSync('__Host-A=1; Path=/', 'https://x.example.com/'), undefined);
  assert.equal(jar.cookies.length, 0);
});

test('replaces and expires cookies', () => {
  const jar = new CookieJar();
  jar.setCookieSync('S=old; Path=/', 'https://h.example.com/');
  jar.setCookieSync('S=new; Path=/', 'https://h.example.com/');
  assert.equal(jar.getCookieString('https://h.example.com/'), 'S=new');
  jar.setCookieSync('S=gone; Path=/; Max-Age=0', 'https://h.example.com/');
  assert.equal(jar.getCookieString('https://h.example.com/'), '');
  jar.setCookieSync('T=1; Expires=Thu, 01 Jan 1970 00:00:00 GMT', 'https://h.example.com/');
  assert.equal(jar.cookies.length, 0);
});

test('round-trips the tough-cookie JSON format clients already store', () => {
  // Captured from tough-cookie@5.1.2 `jar.toJSON()`.
  const legacy = {
    version: 'tough-cookie@5.1.2',
    storeType: 'MemoryCookieStore',
    rejectPublicSuffixes: true,
    cookies: [
      { key: 'ASP.NET_SessionId', value: 'abc', domain: 'hac.example.org', path: '/', secure: true, httpOnly: true, hostOnly: true, creation: '2026-11-05T19:01:53.627Z', lastAccessed: '2026-11-05T19:01:53.627Z', sameSite: 'lax' },
      { key: 'B', value: '2', maxAge: 3600, domain: 'example.org', path: '/p', hostOnly: false, creation: '2026-11-05T19:01:53.628Z', lastAccessed: new Date().toISOString() },
      { key: 'Old', value: 'x', expires: '2001-01-01T00:00:00.000Z', domain: 'hac.example.org', path: '/', hostOnly: true },
      { key: 7, value: 'bad' },
    ],
  };
  const jar = CookieJar.fromJSON(JSON.parse(JSON.stringify(legacy)));
  assert.equal(jar.getCookieString('https://hac.example.org/p'), 'B=2; ASP.NET_SessionId=abc');
  const json = jar.toJSON();
  assert.equal(json.cookies.length, 2); // expired and malformed entries dropped
  assert.equal(json.cookies[0].sameSite, 'lax');
  assert.equal(json.cookies[0].creation, '2026-11-05T19:01:53.627Z');
  const again = CookieJar.fromJSON(JSON.stringify(json));
  assert.equal(again.getCookieString('https://hac.example.org/p'), 'B=2; ASP.NET_SessionId=abc');
});

test('garbage input yields an empty jar instead of throwing', () => {
  assert.equal(CookieJar.fromJSON('not json').cookies.length, 0);
  assert.equal(CookieJar.fromJSON({ cookies: 'nope' }).cookies.length, 0);
  assert.equal(CookieJar.fromJSON(null).cookies.length, 0);
});
