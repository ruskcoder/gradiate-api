/**
 * Assignment-group fetching and the two shapes built from it.
 *
 * One request per course answers everything either route needs:
 *
 *   GET api/v1/courses/:id/assignment_groups
 *       ?include[]=assignments&include[]=submission&include[]=score_statistics
 *       &grading_period_id=<the course's id for the selected term>
 *
 * Assignment groups ARE Canvas's grade categories, so this single call yields the
 * category names and their weights, every assignment inside them, and — because
 * the token belongs to the student — that student's own submission for each.
 * Fetching assignments and submissions separately would cost two round-trips and
 * still miss the category names.
 *
 * `grading_period_id` is what scopes the result to a term. Omitting it (the
 * synthetic `Total` column) returns the whole course.
 */

import { ENDPOINTS, GROUP_INCLUDES, MAX_CONCURRENCY } from '../config/constants.js';
import { apiList, mapPool } from './_api.js';
import { formatDate, formatTime } from './_courses.js';

/** Badge vocabulary shared with the other platforms, so clients render one set. */
function badgesFor(assignment, submission) {
  const badges = new Set();
  if (submission?.excused) badges.add('exempt');
  if (assignment?.omit_from_final_grade) badges.add('exempt');
  if (submission?.missing || submission?.late_policy_status === 'missing') badges.add('missing');
  if (submission?.late || submission?.late_policy_status === 'late') badges.add('late');
  if (submission?.workflow_state === 'pending_review') badges.add('incomplete');
  return [...badges];
}

/** Round to at most two decimals without trailing zeros ("90", "87.33"). */
function trim(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * 100) / 100;
}

function numberOr(value, fallback = null) {
  if (value === null || value === undefined || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Fetch the assignment groups for one course and term.
 * `gradingPeriodId` is null for the whole-course (`Total`) column.
 */
async function fetchGroups(session, link, courseId, gradingPeriodId) {
  return apiList(
    session,
    link,
    ENDPOINTS.ASSIGNMENT_GROUPS(courseId),
    { include: GROUP_INCLUDES, grading_period_id: gradingPeriodId ?? undefined },
    { what: 'assignments' }
  );
}

/** Fetch groups for many courses at once, tolerating per-course failures. */
async function fetchGroupsForCourses(session, link, courses, gradingPeriodIdFor, progressTracker) {
  progressTracker?.update?.(60, 'Loading assignments');
  const results = await mapPool(courses, MAX_CONCURRENCY, async (course) => {
    try {
      return { course, groups: await fetchGroups(session, link, course.id, gradingPeriodIdFor(course)) };
    } catch (error) {
      // A single locked or restricted course shouldn't blank the whole list.
      console.warn(`canvas: assignments for course ${course.id} unavailable:`, error?.message);
      return { course, groups: [], error: error?.message || 'unavailable' };
    }
  });
  return results;
}

/* -------------------------------------------------------------------------- */
/* /single-class shape                                                        */
/* -------------------------------------------------------------------------- */

/**
 * One assignment in the shared `Score` shape.
 *
 * Canvas has no per-assignment weight the way PowerSchool does — an assignment's
 * influence IS its `points_possible` — so `weight` is 1 and the weighted fields
 * mirror the raw ones, which is exactly the `percentwise` convention the other
 * platforms use for unweighted work.
 */
function shapeScore(assignment, group, submission, timeZone) {
  const points = numberOr(submission?.score);
  const possible = numberOr(assignment?.points_possible, 0) || 0;
  const percent = points !== null && possible > 0 ? (points / possible) * 100 : 0;

  // `grade` is already in the assignment's own scheme — a letter for
  // letter_grade, "complete" for pass_fail, the number otherwise — so prefer it
  // over the raw points, the same way the PowerSchool parser prefers
  // `scorelettergrade`.
  const display = submission?.grade ?? (points !== null ? String(points) : '');

  return {
    id: String(assignment.id),
    name: assignment.name || '',
    category: group?.name || '',
    percentage: `${trim(percent)}%`,
    score: display === null ? '' : String(display),
    scorePoints: points !== null ? points : '',
    totalPoints: assignment.points_possible ?? '',
    weight: 1,
    weightedScore: points !== null ? points : '',
    weightedTotalPoints: assignment.points_possible ?? '',
    dateDue: formatDate(assignment.due_at, timeZone),
    dateAssigned: formatDate(assignment.unlock_at || assignment.created_at, timeZone),
    timeDue: formatTime(assignment.due_at, timeZone),
    dueAt: assignment.due_at || null,
    gradingType: assignment.grading_type || '',
    url: assignment.html_url || '',
    badges: badgesFor(assignment, submission),
  };
}

/**
 * Turn a course's assignment groups into `{ scores, categories, averageType }`.
 *
 * `averageType` reports how Canvas actually computes the class average, which is
 * a per-course setting:
 *   - `apply_assignment_group_weights` on  -> `categorywise` (each group's
 *     `group_weight` is a fixed share of the grade);
 *   - off -> `percentwise` (one big points-earned / points-possible ratio, i.e.
 *     every assignment weighted by its own point value).
 *
 * When weights are off, `categoryWeight` is still filled in — derived from each
 * group's share of the total points — so a client can render the same category
 * breakdown either way.
 */
function buildDetail(course, groups, timeZone) {
  const weighted = course?.apply_assignment_group_weights === true;
  const scores = [];
  const categories = {};
  const groupPoints = new Map();

  for (const group of groups) {
    const name = group?.name || 'Assignments';
    const category = categories[name] || { studentsPoints: 0, maximumPoints: 0 };
    categories[name] = category;

    for (const assignment of group?.assignments || []) {
      if (!assignment) continue;
      // `include[]=submission` returns the student's own submission (or none).
      const submission = Array.isArray(assignment.submission)
        ? assignment.submission[0]
        : assignment.submission || null;

      const score = shapeScore(assignment, group, submission, timeZone);
      scores.push(score);

      const points = numberOr(submission?.score);
      const possible = numberOr(assignment.points_possible, 0) || 0;
      // Only graded, non-excused, grade-counting work moves a category average —
      // otherwise an ungraded future assignment would read as a zero.
      const counts = points !== null && !submission?.excused && !assignment.omit_from_final_grade;
      if (counts) {
        category.studentsPoints += points;
        category.maximumPoints += possible;
        groupPoints.set(name, (groupPoints.get(name) || 0) + possible);
      }
    }
  }

  const groupWeight = new Map(
    groups.map((g) => [g?.name || 'Assignments', numberOr(g?.group_weight, 0) || 0])
  );
  const totalPoints = [...groupPoints.values()].reduce((sum, p) => sum + p, 0);

  for (const [name, category] of Object.entries(categories)) {
    const percent = category.maximumPoints ? (category.studentsPoints / category.maximumPoints) * 100 : 0;
    const weight = weighted
      ? groupWeight.get(name) || 0
      : totalPoints
        ? ((groupPoints.get(name) || 0) / totalPoints) * 100
        : 0;

    category.studentsPoints = trim(category.studentsPoints);
    category.maximumPoints = trim(category.maximumPoints);
    category.percent = `${trim(percent)}%`;
    category.categoryWeight = trim(weight);
    category.categoryPoints = trim((percent / 100) * weight);
  }

  return { scores, categories, averageType: weighted ? 'categorywise' : 'percentwise' };
}

/* -------------------------------------------------------------------------- */
/* /assignments shape                                                         */
/* -------------------------------------------------------------------------- */

/** Canvas submission types that a student cannot actually turn in online. */
const NON_SUBMITTABLE = new Set(['none', 'not_graded', 'on_paper', 'wiki_page', 'external_tool']);

/**
 * One word for where an assignment stands, derived in the order a student would
 * read it: excused beats graded, graded beats anything about the due date, and a
 * due date only matters for work that is still outstanding.
 */
function statusFor(assignment, submission, now) {
  if (submission?.excused) return 'excused';
  if (submission?.workflow_state === 'graded' && submission?.score !== null && submission?.score !== undefined) {
    return 'graded';
  }
  if (submission?.submitted_at) {
    if (submission.workflow_state === 'pending_review') return 'pending';
    return submission.late ? 'late' : 'submitted';
  }
  if (submission?.missing || submission?.late_policy_status === 'missing') return 'missing';

  const due = assignment?.due_at ? new Date(assignment.due_at).getTime() : null;
  if (!due || isNaN(due)) return 'undated';
  if (due >= now) return 'upcoming';

  const types = assignment?.submission_types || [];
  // Nothing to hand in, so a past due date just means it has happened.
  if (types.every((t) => NON_SUBMITTABLE.has(t))) return 'past';
  return 'overdue';
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * One assignment in the LMS-only `/assignments` shape: the full date set (due,
 * unlock, lock), the submission story, and the grade if there is one.
 *
 * `description` is Canvas's full HTML body and is frequently enormous, so it is
 * included only on request (`options.includeDescription`).
 */
function shapeAssignment(assignment, group, course, timeZone, now, includeDescription) {
  const submission = Array.isArray(assignment.submission)
    ? assignment.submission[0]
    : assignment.submission || null;

  const points = numberOr(submission?.score);
  const possible = numberOr(assignment.points_possible, 0) || 0;
  const percent = points !== null && possible > 0 ? (points / possible) * 100 : null;
  const due = assignment.due_at ? new Date(assignment.due_at).getTime() : null;

  return {
    id: String(assignment.id),
    course: String(course.id),
    courseName: course.name || course.course_code || `Course ${course.id}`,
    courseCode: course.course_code || '',
    name: assignment.name || '',
    category: group?.name || '',
    url: assignment.html_url || '',
    ...(includeDescription ? { description: assignment.description || '' } : {}),

    // Dates — both the raw ISO instant (for sorting / relative times on the
    // client) and a preformatted local rendering in the user's Canvas zone.
    dueAt: assignment.due_at || null,
    dueDate: formatDate(assignment.due_at, timeZone),
    dueTime: formatTime(assignment.due_at, timeZone),
    unlockAt: assignment.unlock_at || null,
    unlockDate: formatDate(assignment.unlock_at, timeZone),
    lockAt: assignment.lock_at || null,
    lockDate: formatDate(assignment.lock_at, timeZone),
    daysUntilDue: due && !isNaN(due) ? Math.ceil((due - now) / DAY_MS) : null,

    // What it is worth and how it is graded.
    pointsPossible: assignment.points_possible ?? null,
    gradingType: assignment.grading_type || '',
    submissionTypes: assignment.submission_types || [],
    published: assignment.published !== false,
    omitFromFinalGrade: assignment.omit_from_final_grade === true,

    // Where it stands.
    status: statusFor(assignment, submission, now),
    submitted: Boolean(submission?.submitted_at),
    submittedAt: submission?.submitted_at || null,
    graded: submission?.workflow_state === 'graded',
    gradedAt: submission?.graded_at || null,
    attempt: submission?.attempt ?? null,

    // The grade, when there is one.
    score: points !== null ? points : null,
    grade: submission?.grade ?? null,
    percentage: percent === null ? null : `${trim(percent)}%`,
    pointsDeducted: numberOr(submission?.points_deducted),
    badges: badgesFor(assignment, submission),

    // Class-wide stats, when the teacher publishes them.
    statistics: assignment.score_statistics
      ? {
          min: assignment.score_statistics.min ?? null,
          max: assignment.score_statistics.max ?? null,
          mean: assignment.score_statistics.mean ?? null,
        }
      : null,
  };
}

export {
  fetchGroups,
  fetchGroupsForCourses,
  buildDetail,
  shapeScore,
  shapeAssignment,
  statusFor,
  badgesFor,
  trim,
  numberOr,
};
