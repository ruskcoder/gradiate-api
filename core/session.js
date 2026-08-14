import axios from 'axios';
import { wrapper } from 'axios-cookiejar-support';
import { CookieJar } from 'tough-cookie';
import { attachDebugLogger } from './debug.js';

class SessionWrapper {
  constructor(axiosInstance) {
    this.axios = axiosInstance;
    this.cache = {
      lastValidationTime: null,
      verificationToken: null
    };
    this.loginMetadata = null;
  }

  async get(url, config) {
    return this.axios.get(url, config);
  }

  async post(url, data, config) {
    return this.axios.post(url, data, config);
  }

  get defaults() {
    return this.axios.defaults;
  }

  setLoginMetadata(loginType, loginData) {
    this.loginMetadata = { loginType, loginData };
  }

  getLoginMetadata() {
    return this.loginMetadata;
  }

  setLastValidationTime(time) {
    this.cache.lastValidationTime = time;
  }

  getLastValidationTime() {
    return this.cache.lastValidationTime;
  }

  isSessionFresh(minutes = 5) {
    const lastValidation = this.cache.lastValidationTime;
    if (!lastValidation) return false;
    const elapsed = Date.now() - lastValidation;
    return elapsed < minutes * 60 * 1000;
  }

  setVerificationToken(token) {
    this.cache.verificationToken = token;
  }

  getVerificationToken() {
    return this.cache.verificationToken;
  }
}

function createSession() {
  const jar = new CookieJar();
  const axiosInstance = wrapper(axios.create({
    withCredentials: true,
    jar,
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded'
    }
  }));
  attachDebugLogger(axiosInstance, 'new');

  return new SessionWrapper(axiosInstance);
}

function createSuccessResponse(data, session = null) {
  const response = { success: true, ...data };
  if (session) {
    response.session = {
      cookies: session.defaults.jar.toJSON(),
      cache: session.cache || {},
      loginMetadata: session.getLoginMetadata()
    };
  }
  return response;
}

function restoreSession(sessionData) {
  const jar = new CookieJar();

  if (sessionData.cookies) {
    jar.fromJSON(sessionData.cookies);
  }

  const axiosInstance = wrapper(axios.create({
    withCredentials: true,
    jar,
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded'
    }
  }));
  attachDebugLogger(axiosInstance, 'restored');

  const session = new SessionWrapper(axiosInstance);

  if (sessionData.cache) {
    session.cache = sessionData.cache;
  }

  if (sessionData.loginMetadata) {
    session.setLoginMetadata(sessionData.loginMetadata.loginType, sessionData.loginMetadata.loginData);
  }

  return session;
}

/**
 * Seed raw portal cookies (captured by a client-side WebView after an SSO sign-in)
 * into a session's jar, scoped to the portal host. `cookies` may be:
 *   - a Cookie-header string:  "JSESSIONID=abc; other=def"
 *   - an array of { name, value } (or { name, value, domain, path })
 *   - an object map:           { JSESSIONID: "abc", other: "def" }
 * Used by the `microsoftSession` login type so the API can ride a session the
 * user established in a real browser (surviving MFA / risk challenges).
 */
function seedCookiesIntoSession(session, cookies, url) {
  if (!cookies || !url) return session;
  let host;
  try { host = new URL(url).hostname; } catch { return session; }
  const jar = session.defaults.jar;

  const pairs = [];
  if (typeof cookies === 'string') {
    for (const part of cookies.split(/;\s*/)) {
      const eq = part.indexOf('=');
      if (eq > 0) pairs.push([part.slice(0, eq).trim(), part.slice(eq + 1)]);
    }
  } else if (Array.isArray(cookies)) {
    for (const c of cookies) if (c && c.name) pairs.push([c.name, c.value ?? '']);
  } else if (typeof cookies === 'object') {
    for (const [k, v] of Object.entries(cookies)) {
      // @react-native-cookies returns { name: { value, domain, ... } }.
      pairs.push([k, v && typeof v === 'object' ? v.value ?? '' : v]);
    }
  }

  for (const [name, value] of pairs) {
    if (!name) continue;
    try {
      jar.setCookieSync(`${name}=${value}; Domain=${host}; Path=/`, url);
    } catch { /* skip a cookie the jar rejects */ }
  }
  return session;
}

function restoreCookiesIntoSession(session, sessionData) {
  if (!sessionData) {
    return session;
  }

  try {
    const data = typeof sessionData === 'string' ? JSON.parse(sessionData) : sessionData;

    if (data.cookies) {
      session.defaults.jar = CookieJar.fromJSON(data.cookies);
      if (data.cache) {
        session.cache = { ...session.cache, ...data.cache };
      }
      if (data.loginMetadata) {
        session.setLoginMetadata(data.loginMetadata.loginType, data.loginMetadata.loginData);
      }
    } else {
      session.defaults.jar = CookieJar.fromJSON(data);
    }
  } catch (error) {
    console.error('Failed to restore session data:', error);
  }

  return session;
}

export {
  SessionWrapper,
  createSession,
  createSuccessResponse,
  restoreSession,
  restoreCookiesIntoSession,
  seedCookiesIntoSession
};
