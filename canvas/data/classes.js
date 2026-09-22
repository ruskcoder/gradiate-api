/**
 * Classes overview + single-class assignment detail.
 *
 * /classes      one courses call (+ one enrollments call per grading period that
 *               isn't already covered) = per-term AVERAGES only
 *               -> `scoresIncluded: false`.
 * /single-class additionally opens the course's assignment groups for the chosen
 *               term, which carry the categories, their weights, every assignment
 *               and this student's submissions -> `scoresIncluded: true`.
 *
 * The split mirrors PowerSchool: the class list stays one cheap request no matter
 * how many courses a student has, and assignments are paid for per class, on
 * demand. See `_courses.js` for the term model and `_gradebook.js` for the
 * assignment shaping.
 */

import { ValidationError } from '../../core/errors.js';
import { ERROR_MESSAGES } from '../config/constants.js';
import {
  fetchCourses,
  buildTerms,
  fetchAverages,
  shapeClass,
  findCourse,
  userTimeZone,
} from './_courses.js';
import { fetchGroups, buildDetail } from './_gradebook.js';

/** The term fields every gradebook response carries. */
function termFields(terms, term) {
  return {
    termsIncluded: true,
    hasSubterms: terms.hasSubterms,
    termList: terms.termList,
    termTree: terms.termTree,
    term,
    currentTerms: terms.currentTerms,
  };
}

async function classes(session, link, options, progressTracker) {
  const courses = await fetchCourses(session, link, options, progressTracker);
  const terms = buildTerms(courses, options);
  const averages = await fetchAverages(session, link, courses, terms, options, progressTracker);

  progressTracker?.update?.(80, 'Parsing grades');
  return {
    scoresIncluded: false,
    ...termFields(terms, terms.term),
    classes: courses.map((course) => shapeClass(course, averages, terms.term, link)),
  };
}

async function singleClass(session, link, options, progressTracker) {
  if (!options.course && !options.class) {
    throw new ValidationError('Missing required parameters (class or course)');
  }

  const courses = await fetchCourses(session, link, options, progressTracker);
  const course = findCourse(courses, options);
  if (!course) throw new ValidationError(ERROR_MESSAGES.CLASS_NOT_FOUND);

  const terms = buildTerms(courses, options);
  const [averages, timeZone] = await Promise.all([
    fetchAverages(session, link, [course], terms, options, progressTracker),
    userTimeZone(session, link),
  ]);

  progressTracker?.update?.(65, 'Loading assignments');
  const gradingPeriodId = terms.idForCourse(terms.term, course.id);
  const groups = await fetchGroups(session, link, course.id, gradingPeriodId);

  progressTracker?.update?.(85, 'Parsing assignments');
  const detail = buildDetail(course, groups, timeZone);
  const shaped = shapeClass(course, averages, terms.term, link);

  return {
    scoresIncluded: true,
    ...termFields(terms, terms.term),
    class: {
      ...shaped,
      averageType: detail.averageType,
      scores: detail.scores,
      categories: detail.categories,
    },
  };
}

export { classes, singleClass, termFields };
