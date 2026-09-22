/**
 * Canvas LMS endpoint paths and tuning constants.
 *
 * Everything the platform talks to hangs off `API_BASE` on the district's own
 * Canvas host (`https://<district>.instructure.com/`), so there is nothing
 * district-specific to configure — unlike the HTML portals, Canvas's REST API is
 * identical on every instance.
 */

/** Prefix for every REST call, appended to the normalized instance link. */
const API_BASE = 'api/v1/';

const ENDPOINTS = {
  /** Cheapest authenticated call; doubles as the session probe. */
  PROFILE: 'users/self/profile',
  /** Active student enrollments — carries per-grading-period scores. */
  ENROLLMENTS: 'users/self/enrollments',
  /** Course list; `include[]` does almost all the work for `/classes`. */
  COURSES: 'courses',
  /** `courses/:id/assignment_groups` — categories + assignments + submissions in one call. */
  ASSIGNMENT_GROUPS: (courseId) => `courses/${courseId}/assignment_groups`,
};

/**
 * `include[]` values for the course list. Between them these turn one request
 * into everything `/classes` needs: the term columns (`grading_periods`), the
 * averages (`total_scores` + `current_grading_period_scores`, which also names
 * the grading period in progress right now), the teacher row, the school name
 * and the enrollment term.
 */
const COURSE_INCLUDES = [
  'total_scores',
  'current_grading_period_scores',
  'grading_periods',
  'term',
  'teachers',
  'account',
];

/** `include[]` for assignment groups: categories, their assignments, my submission. */
const GROUP_INCLUDES = ['assignments', 'submission', 'score_statistics'];

/** Canvas caps `per_page`; 100 is the documented practical maximum. */
const PER_PAGE = 100;

/** Hard stop on `Link: rel="next"` following, so a pathological account can't hang a request. */
const MAX_PAGES = 20;

/** Parallel per-course requests. Canvas throttles by cost, so stay modest. */
const MAX_CONCURRENCY = 5;

/**
 * Don't fan out one enrollment request per grading period when an account has an
 * unreasonable number of them; past that point only the terms actually being
 * displayed are priced in.
 */
const MAX_PERIOD_FETCHES = 8;

/**
 * Label for the synthetic "whole course" grade column. Canvas exposes it as the
 * course-level `computed_current_score`, which exists alongside the grading
 * periods whenever the account enables "all grading periods" totals — the same
 * role PowerSchool's Y1 column plays.
 */
const TOTAL_TERM_LABEL = 'Total';

const ERROR_MESSAGES = {
  INVALID_TOKEN: 'Canvas rejected the access token — generate a new one under Account → Settings.',
  CLASS_NOT_FOUND: 'Class not found',
  RATE_LIMITED: 'Canvas rate limit exceeded — wait a moment and try again.',
};

export {
  API_BASE,
  ENDPOINTS,
  COURSE_INCLUDES,
  GROUP_INCLUDES,
  PER_PAGE,
  MAX_PAGES,
  MAX_CONCURRENCY,
  MAX_PERIOD_FETCHES,
  TOTAL_TERM_LABEL,
  ERROR_MESSAGES,
};
