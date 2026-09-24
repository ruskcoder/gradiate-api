/**
 * Skyward (legacy "Skyport" / Student & Family Access) constants.
 *
 * `link` is the portal host root (e.g. https://skyward.springbranchisd.com/);
 * pages live in a portal directory under it (see DEFAULT_PORTAL_PATH).
 */

const ERROR_MESSAGES = {
  // Skyward returns a tiny "...invalid..." blob on a bad login / expired session.
  INVALID_LOGIN: 'invalid',
  INVALID_USERNAME_PASSWORD: 'Invalid username or password',
  MISSING_PARAMETERS: 'Missing one or more required parameters',
  BELL_SCHEDULE_NOT_FOUND: 'Bell Schedule not found',
};

// Portal page directory, relative to `link`. Older installs serve Skyward under
// the ISAPI path; newer ones (e.g. Spring Branch since 2026-09) 301 that to
// `Student/web/`. The real directory is detected at login from where the login
// page lands and cached on session.cache.skyward.portalPath; this is the fallback.
const DEFAULT_PORTAL_PATH = 'scripts/wsisa.dll/WService=wsEAplus/';

// Page files, appended to the detected portal path (see portalUrl in
// auth/credentials.js). The detail dialog goes through httploader.p.
const SKYWARD_ENDPOINTS = {
  LOGIN: 'seplog01.w',
  LOGIN_POST: 'skyporthttp.w',
  HOME: 'sfhome01.w',
  GRADEBOOK: 'sfgradebook001.w',
  CLASS_DETAILS: 'httploader.p?file=sfgradebook001.w',
  INFO: 'sfstudentinfo001.w',
  SCHEDULE: 'sfschedule001.w',
  ATTENDANCE: 'sfattendance001.w',
  ACADEMIC_HISTORY: 'sfacademichistory001.w',
};

export { ERROR_MESSAGES, SKYWARD_ENDPOINTS, DEFAULT_PORTAL_PATH };
