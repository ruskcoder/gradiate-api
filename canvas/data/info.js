/**
 * Student info — the profile, plus the school name read off the courses the user
 * is enrolled in.
 *
 * Canvas is an LMS, not a student information system: it has no date of birth,
 * grade level, counselor or home language to report, so those come back empty
 * (the apps already tolerate blanks from PowerSchool for the same reason). What
 * it does have — the account the courses live under, the user's email, login and
 * time zone — is filled in instead, and the two requests run in parallel so the
 * route still costs about one round-trip.
 */

import { ENDPOINTS } from '../config/constants.js';
import { apiGet } from './_api.js';
import { fetchCourses, validZone } from './_courses.js';

/**
 * The account name to show as "school".
 *
 * `include[]=account` gives each course its owning account. Districts usually
 * put schools in subaccounts under a root account, so the most common account
 * across a student's courses is their school; a root account (no
 * `parent_account_id`) is the district itself and is reported as both.
 */
function schoolAndDistrict(courses) {
  const seen = new Map();
  for (const course of courses) {
    const account = course?.account;
    if (!account?.name) continue;
    const entry = seen.get(account.name) || { count: 0, account };
    entry.count += 1;
    seen.set(account.name, entry);
  }
  if (!seen.size) return { school: '', district: '' };

  const [, top] = [...seen.entries()].sort((a, b) => b[1].count - a[1].count)[0];
  const isRoot = !top.account.parent_account_id;
  return { school: top.account.name, district: isRoot ? top.account.name : '' };
}

async function info(session, link, options, progressTracker) {
  progressTracker?.update?.(30, 'Loading profile');

  const [profile, courses] = await Promise.all([
    apiGet(session, link, ENDPOINTS.PROFILE, {}, 'profile'),
    // The school name is the only reason to load courses here, so a failure is
    // not worth failing the route over.
    fetchCourses(session, link, options, null).catch(() => []),
  ]);

  progressTracker?.update?.(80, 'Parsing student info');
  const { school, district } = schoolAndDistrict(courses);
  const timeZone = validZone(profile?.time_zone) || '';
  // Cache the zone for the date-formatting routes: it round-trips in the session
  // envelope, so /info effectively pre-warms them.
  try {
    if (timeZone && session.cache) session.cache.timeZone = timeZone;
  } catch { /* non-fatal */ }

  return {
    name: profile?.name || profile?.short_name || '',
    grade: '',
    school,
    district,
    dob: '',
    counselor: '',
    language: profile?.locale || '',

    // Canvas-specific extras.
    userId: profile?.id !== undefined ? String(profile.id) : '',
    username: profile?.login_id || '',
    email: profile?.primary_email || '',
    avatar: profile?.avatar_url || '',
    timeZone,
    bio: profile?.bio || '',
    courseCount: courses.length,
    enrollmentTerms: [...new Set(courses.map((c) => c?.term?.name).filter(Boolean))],

    link,
  };
}

export { info };
