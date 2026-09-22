/**
 * The shared Canvas gradebook core: one course fetch, the term model built from
 * it, and the helpers every route reuses.
 *
 * `/classes`, `/teachers`, `/single-class` and `/assignments` all start from the
 * same request:
 *
 *   GET api/v1/courses?enrollment_type=student&enrollment_state=active
 *       &include[]=total_scores&include[]=current_grading_period_scores
 *       &include[]=grading_periods&include[]=term&include[]=teachers&include[]=account
 *
 * which is enough for the course list, the teacher row, the school name, the
 * term columns AND the average in the grading period currently in progress.
 *
 * ## The term model
 *
 * Canvas's answer to "terms" is grading periods: a flat, dated, non-overlapping
 * set attached to the account and inherited by each course. That is a genuinely
 * flatter structure than PowerSchool's cascading P1 -> C1 -> S1 -> Y1 columns, so
 * this platform reports a flat `termTree` (`hasSubterms: false`) rather than
 * inventing a hierarchy the data doesn't have.
 *
 * Sitting alongside those periods is the whole-course grade, surfaced as the
 * synthetic `Total` column — the same role Y1 plays on PowerSchool. It is offered
 * only when Canvas says it is meaningful (`totals_for_all_grading_periods_option`,
 * the account setting behind the "All Grading Periods" option in the gradebook),
 * or when the account has no grading periods at all, in which case it is the only
 * grade there is.
 *
 * Per-period averages for periods OTHER than the one in progress are not in the
 * course payload, so they come from one extra enrollments call per grading period
 * (`users/self/enrollments?grading_period_id=...`), fired in parallel. That keeps
 * the `averages` map on each class complete, matching the contract the other
 * platforms already publish.
 */

import {
  ENDPOINTS,
  COURSE_INCLUDES,
  TOTAL_TERM_LABEL,
  MAX_CONCURRENCY,
  MAX_PERIOD_FETCHES,
} from '../config/constants.js';
import { apiGet, apiList, boolOption, mapPool } from './_api.js';

/* -------------------------------------------------------------------------- */
/* Courses                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Every course the token's user is an active student in.
 * `enrollment_type=student` matters: a TA or teacher account would otherwise get
 * back courses it teaches, which have no grade of the user's own.
 */
async function fetchCourses(session, link, options = {}, progressTracker) {
  progressTracker?.update?.(25, 'Loading courses');
  const courses = await apiList(
    session,
    link,
    ENDPOINTS.COURSES,
    {
      enrollment_type: 'student',
      // Concluded courses are hidden by default; `options.includeConcluded`
      // swaps in the completed set for looking back at a finished term.
      enrollment_state: boolOption(options.includeConcluded) ? 'completed' : 'active',
      include: COURSE_INCLUDES,
    },
    { what: 'courses' }
  );

  // A course outside its availability window comes back as a stub with nothing
  // but `access_restricted_by_date`; it has no name and no grade, so drop it.
  return courses.filter((c) => c && c.id && !c.access_restricted_by_date);
}

/** The user's own StudentEnrollment on a course (the one carrying their grades). */
function studentEnrollment(course) {
  const enrollments = Array.isArray(course?.enrollments) ? course.enrollments : [];
  return (
    enrollments.find((e) => e?.type === 'student' || e?.type === 'StudentEnrollment') ||
    enrollments[0] ||
    null
  );
}

/** Comma-joined teacher list for a course, from `include[]=teachers`. */
function teacherNames(course) {
  return (course?.teachers || [])
    .map((t) => t?.display_name || t?.short_name || t?.name)
    .filter(Boolean)
    .join(', ');
}

/* -------------------------------------------------------------------------- */
/* Terms (grading periods)                                                    */
/* -------------------------------------------------------------------------- */

function toDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return isNaN(date.getTime()) ? null : date;
}

/**
 * Collapse every course's grading periods into one ordered set of term columns.
 *
 * Courses in different subaccounts can carry different grading-period *ids* for
 * what is, to the student, the same "Quarter 1" tab — so periods are keyed by
 * title and remember every id they were seen under. `idForCourse` later resolves
 * a title back to the id that specific course uses, which is what the per-course
 * assignment calls need.
 */
function collectPeriods(courses) {
  const byTitle = new Map();

  for (const course of courses) {
    for (const period of course.grading_periods || []) {
      const title = (period?.title || '').trim();
      if (!title) continue;

      const entry =
        byTitle.get(title) || { title, ids: new Set(), byCourse: new Map(), start: null, end: null };
      if (period.id !== undefined && period.id !== null) {
        entry.ids.add(period.id);
        entry.byCourse.set(String(course.id), period.id);
      }
      const start = toDate(period.start_date);
      const end = toDate(period.end_date);
      if (start && (!entry.start || start < entry.start)) entry.start = start;
      if (end && (!entry.end || end > entry.end)) entry.end = end;
      byTitle.set(title, entry);
    }
  }

  const periods = [...byTitle.values()];
  periods.sort((a, b) => {
    if (a.start && b.start && a.start.getTime() !== b.start.getTime()) return a.start - b.start;
    if (a.start && !b.start) return -1;
    if (!a.start && b.start) return 1;
    return a.title.localeCompare(b.title);
  });
  return periods;
}

/** A grading period's window, with the end pushed to the last instant of its day. */
function periodWindow(period) {
  if (!period?.start || !period?.end) return null;
  const end = new Date(period.end.getTime());
  // `end_date` is often midnight-start of the final day, so a bare comparison
  // would read the period as over for the whole of that day.
  if (end.getHours() === 0 && end.getMinutes() === 0 && end.getSeconds() === 0) {
    end.setHours(23, 59, 59, 999);
  }
  return { start: period.start, end };
}

/**
 * Build the term model for a course set.
 *
 * Returns `termList` / `termTree` / `term` / `currentTerms` (the shared contract
 * every platform publishes) plus the internal bits the data functions need:
 * `periods`, `totalLabel`, `idForCourse(title, courseId)` and `windowFor(title)`.
 */
function buildTerms(courses, options = {}) {
  const periods = collectPeriods(courses);

  // Canvas only lets the whole-course total stand next to the periods when the
  // account opted into it; otherwise the course-level score is just a duplicate
  // of the period in progress and would be a misleading extra tab.
  const totalsAllowed =
    periods.length === 0 ||
    courses.some((c) => studentEnrollment(c)?.totals_for_all_grading_periods_option === true);

  // Never collide with a grading period an account actually named "Total".
  let totalLabel = TOTAL_TERM_LABEL;
  const titles = new Set(periods.map((p) => p.title));
  while (titles.has(totalLabel)) totalLabel += '*';

  const termList = [...periods.map((p) => p.title), ...(totalsAllowed ? [totalLabel] : [])];

  // Canvas names the period in progress itself, which beats date arithmetic
  // (it accounts for closed periods and for a course's own overrides). Fall back
  // to date containment when no enrollment reports one.
  const reported = courses
    .map((c) => studentEnrollment(c)?.current_grading_period_title)
    .find((t) => t && titles.has(t));

  const now = Date.now();
  const active = periods
    .map((p) => ({ period: p, window: periodWindow(p) }))
    .filter(({ window }) => window && window.start.getTime() <= now && now <= window.end.getTime())
    .sort((a, b) => b.window.end - b.window.start - (a.window.end - a.window.start))
    .map(({ period }) => period.title);

  const activeTitles = reported ? [reported] : active;
  // Coarsest first, finest last: the whole-course total encloses every period.
  const currentTerms = [...(totalsAllowed ? [totalLabel] : []), ...activeTitles];

  const requested = options.term && termList.includes(options.term) ? options.term : null;
  const term =
    requested ||
    // Over a break nothing is active, so fall back to the last column — there is
    // always a sensible default to render.
    (currentTerms.length ? currentTerms[currentTerms.length - 1] : termList[termList.length - 1]) ||
    '';

  return {
    termList,
    termTree: termList.map((label) => ({ label, children: [] })),
    hasSubterms: false,
    term,
    currentTerms,
    periods,
    totalLabel,
    totalsAllowed,
    /** Grading-period id this course uses for `title`, or null for the total column. */
    idForCourse(title, courseId) {
      if (!title || title === totalLabel) return null;
      const period = periods.find((p) => p.title === title);
      if (!period) return null;
      return period.byCourse.get(String(courseId)) ?? [...period.ids][0] ?? null;
    },
    /** The `{ start, end }` window for a title, or null for the total column. */
    windowFor(title) {
      if (!title || title === totalLabel) return null;
      return periodWindow(periods.find((p) => p.title === title));
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Averages                                                                   */
/* -------------------------------------------------------------------------- */

/** PowerSchool-style "A 93": the letter and the number when both exist. */
function formatAverage(grade, score) {
  const number = score === null || score === undefined || score === '' ? '' : String(score);
  const letter = grade === null || grade === undefined || grade === '' ? '' : String(grade);
  if (letter && number) return `${letter} ${number}`;
  return letter || number;
}

/**
 * `{ courseId: { termLabel: "A 93" } }` for every term in `termList`.
 *
 * The course payload already carries two of the columns — the whole-course total
 * and the period in progress — so only the remaining periods cost a request, and
 * those run in parallel. A period whose request fails is simply left out of the
 * map rather than failing the whole route: a missing average degrades to a blank
 * cell, which is much better than no gradebook.
 */
async function fetchAverages(session, link, courses, terms, options = {}, progressTracker) {
  const averages = new Map();
  const put = (courseId, label, value) => {
    const key = String(courseId);
    if (!averages.has(key)) averages.set(key, {});
    if (value !== '') averages.get(key)[label] = value;
  };

  for (const course of courses) {
    const enrollment = studentEnrollment(course);
    if (!enrollment) continue;

    if (terms.totalsAllowed) {
      put(
        course.id,
        terms.totalLabel,
        formatAverage(enrollment.computed_current_grade, enrollment.computed_current_score)
      );
    }
    const currentTitle = enrollment.current_grading_period_title;
    if (currentTitle && terms.termList.includes(currentTitle)) {
      put(
        course.id,
        currentTitle,
        formatAverage(
          enrollment.current_period_computed_current_grade,
          enrollment.current_period_computed_current_score
        )
      );
    }
  }

  // Which periods still need a lookup, and are worth one.
  const covered = new Set(
    courses.map((c) => studentEnrollment(c)?.current_grading_period_title).filter(Boolean)
  );
  let missing = terms.periods.filter((p) => !covered.has(p.title));
  if (missing.length > MAX_PERIOD_FETCHES) {
    // Too many periods to price in wholesale — fetch only the one being shown.
    missing = missing.filter((p) => p.title === options.term || p.title === terms.term);
  }

  if (missing.length) {
    progressTracker?.update?.(45, 'Loading term grades');
    await mapPool(missing, MAX_CONCURRENCY, async (period) => {
      const id = [...period.ids][0];
      if (id === undefined) return;
      try {
        const enrollments = await apiList(
          session,
          link,
          ENDPOINTS.ENROLLMENTS,
          { state: ['active'], type: ['StudentEnrollment'], grading_period_id: id },
          { what: 'term grades' }
        );
        for (const enrollment of enrollments) {
          const grades = enrollment?.grades || {};
          put(enrollment.course_id, period.title, formatAverage(grades.current_grade, grades.current_score));
        }
      } catch (error) {
        // One unreadable grading period must not sink the gradebook.
        console.warn(`canvas: grading period "${period.title}" averages unavailable:`, error?.message);
      }
    });
  }

  return averages;
}

/* -------------------------------------------------------------------------- */
/* Shaping                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * One course in the shared `Class` shape. Canvas has no periods or rooms — it is
 * an LMS, not a master schedule — so those are returned blank rather than
 * stuffed with something that looks like data but isn't.
 */
function shapeClass(course, averages, term, link) {
  const perTerm = averages.get(String(course.id)) || {};
  return {
    course: String(course.id),
    name: course.name || course.course_code || `Course ${course.id}`,
    code: course.course_code || '',
    period: '',
    teacher: teacherNames(course),
    email: '',
    room: '',
    termName: course.term?.name || '',
    url: `${link}courses/${course.id}`,
    averages: perTerm,
    average: perTerm[term] || '',
  };
}

/** Find a course by `options.course` (id — preferred) or `options.class` (name). */
function findCourse(courses, options) {
  const byId = options.course ? courses.find((c) => String(c.id) === String(options.course)) : null;
  if (byId) return byId;
  if (options.class) {
    const wanted = String(options.class).trim().toLowerCase();
    return (
      courses.find((c) => (c.name || '').trim().toLowerCase() === wanted) ||
      courses.find((c) => (c.course_code || '').trim().toLowerCase() === wanted) ||
      null
    );
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* Dates                                                                      */
/* -------------------------------------------------------------------------- */

function validZone(zone) {
  if (!zone) return null;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return zone;
  } catch {
    return null;
  }
}

/**
 * The user's Canvas time zone, cached on the session.
 *
 * Canvas timestamps are UTC, and a due date of 11:59 PM local is stored in the
 * next UTC day for most of the Americas — formatting in UTC would show every
 * assignment as due a day late. The profile carries the right zone, and because
 * `session.cache` round-trips to the client and back, the lookup costs one
 * request per *login*, not one per call.
 */
async function userTimeZone(session, link) {
  const cached = validZone(session.cache?.timeZone);
  if (cached) return cached;
  let zone = 'UTC';
  try {
    const profile = await apiGet(session, link, ENDPOINTS.PROFILE, {}, 'profile');
    zone = validZone(profile?.time_zone) || 'UTC';
  } catch {
    // Date formatting is not worth failing a gradebook over.
  }
  try {
    if (session.cache) session.cache.timeZone = zone;
  } catch { /* a frozen cache just means we look it up again next time */ }
  return zone;
}

/** ISO 8601 -> "9/11/2026" in the user's own zone. Empty string for no date. */
function formatDate(iso, timeZone) {
  const date = iso ? new Date(iso) : null;
  if (!date || isNaN(date.getTime())) return '';
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
  }).formatToParts(date);
  const get = (type) => parts.find((p) => p.type === type)?.value || '';
  return `${get('month')}/${get('day')}/${get('year')}`;
}

/** ISO 8601 -> "11:59 PM" in the user's own zone. Empty string for no date. */
function formatTime(iso, timeZone) {
  const date = iso ? new Date(iso) : null;
  if (!date || isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', minute: '2-digit' }).format(date);
}

export {
  fetchCourses,
  studentEnrollment,
  teacherNames,
  buildTerms,
  fetchAverages,
  formatAverage,
  shapeClass,
  findCourse,
  userTimeZone,
  formatDate,
  formatTime,
  validZone,
};
