/**
 * Teachers — reduces the already-fetched course list to class -> teacher, so no
 * extra round-trip is needed.
 *
 * `include[]=teachers` returns Canvas's UserDisplay objects, which deliberately
 * carry no email address; reading one would mean a course-roster request per
 * course, and students are frequently not permitted to make it. `email` is
 * therefore returned empty rather than costing N requests that usually 403.
 */

import { fetchCourses, teacherNames } from './_courses.js';

async function teachers(session, link, options, progressTracker) {
  const courses = await fetchCourses(session, link, options, progressTracker);
  progressTracker?.update?.(80, 'Parsing teachers');

  return {
    teachers: courses.map((course) => ({
      class: course.name || course.course_code || `Course ${course.id}`,
      course: String(course.id),
      teacher: teacherNames(course),
      email: '',
      room: '',
      teachers: (course.teachers || []).map((t) => ({
        id: t?.id !== undefined ? String(t.id) : '',
        name: t?.display_name || t?.short_name || '',
        avatar: t?.avatar_image_url || '',
      })),
    })),
  };
}

export { teachers };
