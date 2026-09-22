/**
 * `/canvas/assignments` — the LMS-only route.
 *
 * A gradebook portal only ever shows assignments underneath a class, as rows in
 * a grade table; an LMS is built around them, with real due / unlock / lock
 * timestamps, submission state and per-assignment class statistics. This route
 * publishes that: one flat, chronologically-ordered list across every course, so
 * a client can render "what's due this week" without stitching together N
 * `/single-class` calls.
 *
 * It is a superset of the assignment data in `/single-class`, so the two share
 * the same fetch (`_gradebook.js`) and differ only in shape and filtering.
 *
 * Options
 *   term               term label from `termList`; scopes to that grading period.
 *   course / class     limit to one course (id, or exact name).
 *   status             one status or a list: upcoming, overdue, missing, late,
 *                      submitted, pending, graded, excused, past, undated.
 *   dueAfter/dueBefore ISO dates; keeps only assignments due in that window.
 *   ungraded           false drops assignments that don't count toward a grade.
 *   includeDescription true includes Canvas's (often very large) HTML body.
 *   limit              cap the number of rows returned, after sorting.
 *   order              'due' (default, soonest first), 'recent' (newest due
 *                      first) or 'course'.
 */

import { ValidationError } from '../../core/errors.js';
import { ERROR_MESSAGES } from '../config/constants.js';
import { fetchCourses, buildTerms, findCourse, userTimeZone } from './_courses.js';
import { boolOption } from './_api.js';
import { fetchGroupsForCourses, shapeAssignment } from './_gradebook.js';
import { termFields } from './classes.js';

const STATUSES = new Set([
  'upcoming',
  'overdue',
  'missing',
  'late',
  'submitted',
  'pending',
  'graded',
  'excused',
  'past',
  'undated',
]);

function requestedStatuses(options) {
  const raw = options.status;
  if (!raw) return null;
  const list = (Array.isArray(raw) ? raw : String(raw).split(','))
    .map((s) => String(s).trim().toLowerCase())
    .filter(Boolean);
  if (!list.length) return null;
  const unknown = list.filter((s) => !STATUSES.has(s));
  if (unknown.length) {
    throw new ValidationError(`Unknown status: ${unknown.join(', ')}. Valid: ${[...STATUSES].join(', ')}`);
  }
  return new Set(list);
}

/**
 * Does this row match the requested statuses?
 *
 * `status` is a single word for where an assignment stands, and "graded" wins
 * over everything once a score exists — which would otherwise make
 * `status: 'late'` useless, since work that was handed in late is usually also
 * graded. So a filter also matches the flags in `badges`, letting `late` and
 * `missing` mean "flagged as such" regardless of what has happened since.
 */
const BADGE_ALIAS = { late: 'late', missing: 'missing', exempt: 'excused' };

function matchesStatus(row, statuses) {
  if (statuses.has(row.status)) return true;
  return row.badges.some((badge) => statuses.has(BADGE_ALIAS[badge]));
}

function parseBound(value, label) {
  if (!value) return null;
  const date = new Date(value);
  if (isNaN(date.getTime())) throw new ValidationError(`${label} must be a valid date`);
  return date.getTime();
}

/** Sort comparators. Undated work always sinks to the bottom of a date sort. */
function comparator(order) {
  if (order === 'course') {
    return (a, b) =>
      a.courseName.localeCompare(b.courseName) ||
      (a.dueAt ? Date.parse(a.dueAt) : Infinity) - (b.dueAt ? Date.parse(b.dueAt) : Infinity) ||
      a.name.localeCompare(b.name);
  }
  const direction = order === 'recent' ? -1 : 1;
  return (a, b) => {
    const at = a.dueAt ? Date.parse(a.dueAt) : null;
    const bt = b.dueAt ? Date.parse(b.dueAt) : null;
    if (at === null && bt === null) return a.name.localeCompare(b.name);
    if (at === null) return 1;
    if (bt === null) return -1;
    if (at !== bt) return (at - bt) * direction;
    return a.courseName.localeCompare(b.courseName) || a.name.localeCompare(b.name);
  };
}

async function assignments(session, link, options, progressTracker) {
  const statuses = requestedStatuses(options);
  const dueAfter = parseBound(options.dueAfter, 'dueAfter');
  const dueBefore = parseBound(options.dueBefore, 'dueBefore');
  const order = options.order || 'due';
  if (!['due', 'recent', 'course'].includes(order)) {
    throw new ValidationError("order must be one of: due, recent, course");
  }

  const allCourses = await fetchCourses(session, link, options, progressTracker);
  const terms = buildTerms(allCourses, options);

  // A course filter is optional here (unlike /single-class, which is about one
  // class by definition) — it just narrows the fan-out.
  let courses = allCourses;
  if (options.course || options.class) {
    const one = findCourse(allCourses, options);
    if (!one) throw new ValidationError(ERROR_MESSAGES.CLASS_NOT_FOUND);
    courses = [one];
  }

  const includeDescription = boolOption(options.includeDescription);
  const timeZone = await userTimeZone(session, link);
  const results = await fetchGroupsForCourses(
    session,
    link,
    courses,
    (course) => terms.idForCourse(terms.term, course.id),
    progressTracker
  );

  progressTracker?.update?.(85, 'Parsing assignments');
  const now = Date.now();
  // Only meaningful when the selected term has no grading period behind it (the
  // synthetic `Total` column); then a date window is the honest way to scope.
  const window = terms.windowFor(terms.term);

  const rows = [];
  const unavailable = [];
  for (const { course, groups, error } of results) {
    if (error) unavailable.push({ course: String(course.id), name: course.name || '', reason: error });
    for (const group of groups) {
      for (const assignment of group?.assignments || []) {
        if (!assignment) continue;
        rows.push(shapeAssignment(assignment, group, course, timeZone, now, includeDescription));
      }
    }
  }

  const filtered = rows.filter((row) => {
    if (!boolOption(options.ungraded, true) && (row.omitFromFinalGrade || row.gradingType === 'not_graded')) return false;
    if (statuses && !matchesStatus(row, statuses)) return false;

    const due = row.dueAt ? Date.parse(row.dueAt) : null;
    if (dueAfter !== null && (due === null || due < dueAfter)) return false;
    if (dueBefore !== null && (due === null || due > dueBefore)) return false;
    // `grading_period_id` already scoped the fetch where a period exists; this
    // only bites for a course that reported no matching period.
    if (window && due !== null && (due < window.start.getTime() || due > window.end.getTime())) return false;
    return true;
  });

  filtered.sort(comparator(order));

  const counts = { total: filtered.length };
  for (const row of filtered) counts[row.status] = (counts[row.status] || 0) + 1;

  const limit = Number(options.limit);
  const limited = Number.isFinite(limit) && limit > 0 ? filtered.slice(0, limit) : filtered;

  return {
    ...termFields(terms, terms.term),
    counts,
    assignments: limited,
    // Named so a client can say "3 of 9 courses couldn't be read" rather than
    // silently showing a short list.
    ...(unavailable.length ? { unavailable } : {}),
  };
}

export { assignments };
