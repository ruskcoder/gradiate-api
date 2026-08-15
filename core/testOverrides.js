/**
 * Test-only grade overrides.
 *
 * Grade-change notifications are hard to exercise against a real portal: you'd
 * have to wait for a teacher to actually enter a score. This lets the test
 * account fake one — rows in `test_grade_overrides` map a course name to the
 * average the API should report for it, so flipping a row and re-fetching looks
 * exactly like a real grade change to every client.
 *
 * Deliberately narrow: it only ever engages for the username in TESTUSER or
 * USERNAME, and it only rewrites the average field. Everything else about the
 * response — assignments, categories, terms — is passed through untouched, so
 * the clients can't tell the difference.
 */

import process from 'process';
import supabase from '../database.js';
import { debugLog } from './debug.js';

const OVERRIDE_TABLE = 'test_grade_overrides';

/**
 * True only for the configured test account(s). Comparison is case-insensitive
 * because portals echo usernames back with inconsistent casing.
 *
 * NOTE: `USERNAME` is also a built-in Windows environment variable (the OS
 * account name), and dotenv does not overwrite variables that already exist. On
 * a Windows dev box `process.env.USERNAME` is therefore the OS user, not the
 * value in .env — set TESTUSER there instead.
 */
function isTestUser(username) {
  if (!username) return false;
  const candidate = String(username).trim().toLowerCase();
  const allowed = [process.env.TESTUSER, process.env.USERNAME]
    .filter(Boolean)
    .map((value) => String(value).trim().toLowerCase());
  return allowed.includes(candidate);
}

/**
 * Course name (lowercased) -> override value. Read fresh on every call rather
 * than cached: the point of the table is to change a value and immediately see
 * the effect, and it's only ever queried for the test account.
 */
async function fetchGradeOverrides() {
  const { data, error } = await supabase
    .from(OVERRIDE_TABLE)
    .select('courseName, avgOverride');

  if (error) throw error;

  const overrides = new Map();
  for (const row of data || []) {
    if (!row?.courseName) continue;
    overrides.set(String(row.courseName).trim().toLowerCase(), String(row.avgOverride ?? ''));
  }
  return overrides;
}

function overrideOne(cls, overrides) {
  const key = String(cls?.name ?? '').trim().toLowerCase();
  if (!key || !overrides.has(key)) return cls;

  const value = overrides.get(key);
  const patched = { ...cls, average: value };

  // All-in-one portals (Skyward, PowerSchool) also carry a per-term `averages`
  // dict that the UIs read instead of `average`. Override those too, but leave
  // empty cells empty — a blank means "term not in session", and filling it
  // would invent a term the student isn't enrolled in.
  if (cls.averages && typeof cls.averages === 'object') {
    patched.averages = Object.fromEntries(
      Object.entries(cls.averages).map(([term, current]) => [term, current === '' ? current : value])
    );
  }

  debugLog('test-override', `${cls.name} -> ${value}`);
  return patched;
}

/**
 * The pure half: apply an already-fetched override map to a payload. Split out
 * from the DB lookup so the rewrite rules can be tested without a database.
 */
function applyOverrideMap(payload, overrides) {
  const hasList = Array.isArray(payload?.classes);
  const hasSingle = payload?.class && typeof payload.class === 'object';
  if ((!hasList && !hasSingle) || !overrides || overrides.size === 0) return payload;

  const patched = { ...payload };
  if (hasList) patched.classes = payload.classes.map((cls) => overrideOne(cls, overrides));
  if (hasSingle) patched.class = overrideOne(payload.class, overrides);
  return patched;
}

/**
 * Rewrite averages in a `classes` / `singleClass` payload for the test account.
 * Returns the payload untouched for everyone else, and on any lookup failure —
 * a broken test fixture must never cost a real user their grades.
 */
async function applyGradeOverrides(payload, username) {
  if (!payload || !isTestUser(username)) return payload;
  if (!Array.isArray(payload.classes) && !payload.class) return payload;

  let overrides;
  try {
    overrides = await fetchGradeOverrides();
  } catch (error) {
    console.error('Grade override lookup failed; returning real grades:', error);
    return payload;
  }
  return applyOverrideMap(payload, overrides);
}

export { applyGradeOverrides, applyOverrideMap, isTestUser };
