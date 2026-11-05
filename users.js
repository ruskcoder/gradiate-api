/**
 * User bookkeeping: one row per student in `users`, recording when we first saw
 * them sign in. Per-school totals are computed live by `school_stats()`.
 */

import { db, filterValue } from './database.js';

/**
 * Record that `username` just signed in, and report when they FIRST did.
 *
 * A returning user's `firstLoggedIn` is never rewritten — only mutable profile
 * fields (school, name) are refreshed — so the timestamp keeps meaning "first
 * ever seen" rather than "seen most recently".
 *
 * The refresh's result is never used, so with `waitUntil` it runs after the
 * response is sent instead of delaying it.
 *
 * @returns {Promise<{firstLoggedIn: string|null}>}
 */
async function recordLogin(username, school, name, waitUntil) {
  const user = filterValue(username);
  // username isn't unique in the schema; take the earliest row, which is the
  // real first login.
  const existing = await db.select(
    `users?select=firstLoggedIn&username=eq.${user}&order=firstLoggedIn.asc.nullsfirst&limit=1`
  );

  if (existing && existing.length > 0) {
    const fields = {};
    if (school) fields.school = school;
    if (name) fields.name = name;
    if (Object.keys(fields).length) {
      // Refreshing profile fields is best-effort; failing it shouldn't cost the
      // caller their student info.
      const refresh = db.update(`users?username=eq.${user}`, fields)
        .catch((error) => console.error('Failed to update existing user fields:', error));
      if (waitUntil) waitUntil(refresh);
      else await refresh;
    }
    return { firstLoggedIn: existing[0].firstLoggedIn };
  }

  // `school` is NOT NULL, so a scrape that didn't find one can't create a row.
  if (!school) return { firstLoggedIn: null };

  // `firstLoggedIn` is deliberately omitted so the column default (now()) fills
  // it: the timestamp then comes from the database clock rather than from
  // whichever API instance happened to serve the request.
  const inserted = await db.insert(
    'users?select=firstLoggedIn',
    [{ username, school, name: name || null }],
    'return=representation'
  );

  // Per-school totals are computed live from `users` by the `school_stats()` function.
  return { firstLoggedIn: inserted?.[0]?.firstLoggedIn ?? null };
}

export {
  recordLogin
};
