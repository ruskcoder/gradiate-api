/**
 * User bookkeeping: one row per student in `users`, recording when we first saw
 * them sign in, plus a per-school tally in `school_counts`.
 */

import supabase from './database.js';

/**
 * Record that `username` just signed in, and report when they FIRST did.
 *
 * A returning user's `firstLoggedIn` is never rewritten — only mutable profile
 * fields (school, name) are refreshed — so the timestamp keeps meaning "first
 * ever seen" rather than "seen most recently".
 *
 * @returns {Promise<{firstLoggedIn: string|null}>}
 */
async function recordLogin(username, school, name) {
  // username isn't unique in the schema; take the earliest row, which is the
  // real first login.
  const { data: existing, error: lookupError } = await supabase
    .from('users')
    .select('firstLoggedIn')
    .eq('username', username)
    .order('firstLoggedIn', { ascending: true, nullsFirst: true })
    .limit(1);

  if (lookupError) throw lookupError;

  if (existing && existing.length > 0) {
    const fields = {};
    if (school) fields.school = school;
    if (name) fields.name = name;
    if (Object.keys(fields).length) {
      const { error: updateError } = await supabase
        .from('users')
        .update(fields)
        .eq('username', username);
      // Refreshing profile fields is best-effort; failing it shouldn't cost the
      // caller their student info.
      if (updateError) console.error('Failed to update existing user fields:', updateError);
    }
    return { firstLoggedIn: existing[0].firstLoggedIn };
  }

  // `school` is NOT NULL, so a scrape that didn't find one can't create a row.
  if (!school) return { firstLoggedIn: null };

  // `firstLoggedIn` is deliberately omitted so the column default (now()) fills
  // it: the timestamp then comes from the database clock rather than from
  // whichever API instance happened to serve the request.
  const { data: inserted, error } = await supabase
    .from('users')
    .insert([{ username, school, name: name || null }])
    .select('firstLoggedIn')
    .single();

  if (error) throw error;

  // `school_counts` is kept in sync by a database trigger on `users`.
  return { firstLoggedIn: inserted.firstLoggedIn };
}

export {
  recordLogin
};
