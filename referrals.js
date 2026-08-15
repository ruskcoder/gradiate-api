/**
 * User bookkeeping: one row per (username, school), recording when we first saw
 * that student sign in.
 *
 * This used to run a referral programme (a generated code per user, a
 * `referredFrom` link, and a `numReferrals` tally). That's gone — the table now
 * exists purely to know who uses the app and since when.
 */

import supabase from './database.js';

/**
 * Record that `username` just signed in, and report when they FIRST did.
 *
 * A returning user's `firstLoggedIn` is never rewritten — only mutable profile
 * fields (school) are refreshed — so the timestamp keeps meaning "first ever
 * seen" rather than "seen most recently".
 *
 * @returns {Promise<{firstLoggedIn: string|null}>}
 */
async function recordLogin(username, school) {
  // The unique index is on (username, school), so a student who transfers can
  // legitimately own more than one row. Take the earliest — that's the real
  // first login — instead of assuming a single row like the old code did.
  const { data: existing, error: lookupError } = await supabase
    .from('referrals')
    .select('firstLoggedIn')
    .eq('username', username)
    .order('firstLoggedIn', { ascending: true, nullsFirst: true })
    .limit(1);

  if (lookupError) throw lookupError;

  if (existing && existing.length > 0) {
    if (school) {
      const { error: updateError } = await supabase
        .from('referrals')
        .update({ school })
        .eq('username', username);
      // Refreshing the school is best-effort; failing it shouldn't cost the
      // caller their student info.
      if (updateError) console.error('Failed to update existing user fields:', updateError);
    }
    return { firstLoggedIn: existing[0].firstLoggedIn };
  }

  // `firstLoggedIn` is deliberately omitted so the column default (now()) fills
  // it: the timestamp then comes from the database clock rather than from
  // whichever API instance happened to serve the request.
  const { data: inserted, error } = await supabase
    .from('referrals')
    .insert([{ username, school }])
    .select('firstLoggedIn')
    .single();

  if (error) throw error;
  return { firstLoggedIn: inserted.firstLoggedIn };
}

export {
  recordLogin
};
