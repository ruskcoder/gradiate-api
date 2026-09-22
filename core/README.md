# Core — the platform-agnostic engine

Core owns **every public route** and **every login type**. A platform is a plain
registry object that contributes only what's unique to its portal: how to log in
with a username/password, and how to fetch/parse each page. Sessions, SSO logins,
auto-relogin, progress streaming, error types, and the response envelope all live
here — never copy them into a platform.

## What core provides

| Module | Exports | Purpose |
|---|---|---|
| `errors.js` | `APIError`, `AuthenticationError`, `ValidationError`, `HTTP_STATUS` | Typed errors → JSON responses |
| `progressTracker.js` | `ProgressTracker` | SSE progress (`stream:true`) or plain JSON |
| `session.js` | `createSession`, `restoreCookiesIntoSession`, `createSuccessResponse`, `SessionWrapper`, … | Cookie-jar axios sessions + the `{ success, ..., session }` envelope |
| `reauthSession.js` | `createReauthSession` | Transparent auto-relogin wrapper (platform supplies `isSessionExpired`) |
| `validation.js` | `createLoginValidation` | Standard login-body validation helper |
| `auth/index.js` | `authenticate`, `performLogin` | The one auth entry point: validate → reuse/relogin → dispatch by loginType |
| `auth/classlink.js` | `loginClassLink` | Generic ClassLink SSO (clsession + credentials + 2FA icon), tile chosen by `ssoFilter` |
| `auth/token.js` | `applyToken`, `tokenFrom` | Bearer-token login (`Authorization: Bearer`) for portals whose API credential *is* the session |
| `auth/microsoft.js` | `loginMicrosoft` | Microsoft SSO extension point (stub) |
| `routes.js` | `createPlatformRoutes`, `ROUTE_TABLE` | Builds a router from a platform registry |

Everything is re-exported from `core/index.js`.

## The platform registry contract

A platform's `index.js` default-exports:

```js
{
  name: 'HAC',
  mount: '/hac',                                  // URL prefix
  ssoFilter: ['hac', 'homeaccess'],               // picks the SSO dashboard tile
  loginTypes: ['credentials', 'classlink'],       // which logins this portal accepts ('token' too)
  homeEndpoint: 'HomeAccess',                      // path for the cheap session probe
  formatLink,                                      // (raw) => normalized base URL
  credentialsAuth,                                 // (session, loginData, progress) => { session, username }
  isSessionExpired,                                // (html) => bool  — powers auto-relogin
  finalizeSSO,                                     // optional (session, link, ctx) => { session, link }
  data: {                                          // (session, link, options, progress) => data
    info, classes, singleClass, schedule, attendance, teachers, ipr, reportCard, transcript,
    assignments,                                   // LMS-only
  },
}
```

`createPlatformRoutes(platform)` mounts `/login` plus a route for each `data`
key present (see `ROUTE_TABLE` in `routes.js`); any canonical route the platform
omits returns a standard 404.

## Request lifecycle

1. `routes.js` creates a `ProgressTracker` and calls `authenticate(req, platform, pt)`.
2. `auth/index.js` validates the body, reuses a fresh client session if possible,
   else dispatches: `credentials` → `platform.credentialsAuth`; SSO types →
   `auth/classlink.js` / `auth/microsoft.js` (then `platform.finalizeSSO`).
3. The base session is wrapped by `createReauthSession` so an expired page
   transparently triggers a re-login mid-request.
4. `routes.js` calls the matching `platform.data[...]` function and wraps its
   return value with `createSuccessResponse` (adds `success` + serialized session).

## Adding a platform

`cp -r template myplatform`, fill in `auth/credentials.js` + `data/*.js` +
`config/constants.js`, set the registry fields in `index.js`, then register it in
the top-level `index.js`:

```js
import myplatform from './myplatform/index.js';
const platforms = [hac, myplatform];
```

See [`../template`](../template/README.md) for the full walkthrough and
[`../hac`](../hac) for a complete reference implementation.

## Adding a login type

Implement it once in `core/auth/` (mirroring `classlink.js`) and wire it into the
dispatch in `auth/index.js`. Platforms opt in by listing it in `loginTypes` and
providing an `ssoFilter` — no platform code changes.

`token` is the one login type with no cookie: the credential travels in an
`Authorization: Bearer` header, which a deserialized session does not carry, so
`stampSession` re-applies it on every reused session (reading the token from the
request or from the session's own round-tripped `loginMetadata`). It also relaxes
`validateStatus`, because a token API reports a rejected credential with a status
code and a JSON body that the platform — and `isSessionExpired`, which only ever
sees bodies — needs to read. See [`../canvas`](../canvas/README.md).
