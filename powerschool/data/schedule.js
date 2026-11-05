/**
 * Schedule + bell schedule, both read from guardian/myschedule.html.
 *
 * The "matrix" view is a weekday grid of class blocks; each block cell carries
 * `Course<br>Teacher<br>Room<br>HH:MM AM - HH:MM PM` and a name="attCellYYYYMMDD"
 * that dates the column. We parse every block once and reshape it two ways:
 *   - schedule()      -> one row per course, with the weekdays it meets.
 *   - bellSchedule()  -> per-weekday ordered period times (see bellSchedule.js).
 */

import * as cheerio from '../../core/html.js';
import { ENDPOINTS } from '../config/constants.js';
import { checkSessionValidity } from '../auth/credentials.js';
import { parseStudents, selectedStudentId, fetchHome } from './_grid.js';

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const TIME_RE = /(\d{1,2}:\d{2}\s*[AP]M)\s*[-–]\s*(\d{1,2}:\d{2}\s*[AP]M)/i;

/** Fetch myschedule.html (switching student first if asked) and return blocks. */
async function fetchScheduleBlocks(session, link, options, progressTracker) {
  // Switch active student on the home page first (myschedule follows the session's
  // selected student), then load the schedule matrix.
  if (options.studentId) await fetchHome(session, link, options.studentId, progressTracker);
  progressTracker?.update?.(60, 'Loading schedule');
  const res = await session.get(link + ENDPOINTS.MY_SCHEDULE);
  checkSessionValidity(res);
  const $ = cheerio.load(res.data);
  return { $, blocks: parseBlocks($) };
}

/** Every class block: { course, teacher, room, startTime, endTime, date, day }. */
function parseBlocks($) {
  const blocks = [];
  $('#tableStudentSchedMatrix td[name^="attCell"]').each((_, td) => {
    const parts = ($(td).html() || '')
      .split(/<br\s*\/?>/i)
      .map((p) => cheerio.load(p).root().text().replace(/\u00A0/g, ' ').trim())
      .filter(Boolean);
    if (parts.length < 2) return;

    const timePart = parts.find((p) => TIME_RE.test(p)) || '';
    const tm = TIME_RE.exec(timePart);
    const course = parts[0];
    const teacher = parts[1] && !TIME_RE.test(parts[1]) ? parts[1] : '';
    // Room is the part between teacher and time, when present.
    const room = parts.length > 3 && !TIME_RE.test(parts[2]) ? parts[2] : '';

    const dateStr = ($(td).attr('name') || '').replace('attCell', '');
    let day = '';
    if (/^\d{8}$/.test(dateStr)) {
      const d = new Date(`${dateStr.slice(0, 4)}-${dateStr.slice(4, 6)}-${dateStr.slice(6, 8)}`);
      if (!isNaN(d)) day = WEEKDAYS[d.getDay()];
    }

    blocks.push({
      course,
      teacher,
      room,
      startTime: tm ? tm[1].replace(/\s+/g, ' ').trim() : '',
      endTime: tm ? tm[2].replace(/\s+/g, ' ').trim() : '',
      date: dateStr,
      day,
    });
  });
  return blocks;
}

/** Collapse blocks to one row per course with the set of weekdays it meets. */
function toSchedule(blocks) {
  const byCourse = new Map();
  for (const b of blocks) {
    if (!b.course) continue;
    const key = `${b.course}|${b.startTime}`;
    const existing = byCourse.get(key);
    if (existing) {
      if (b.day) existing._days.add(b.day);
    } else {
      byCourse.set(key, {
        Course: b.course,
        Description: b.course,
        Teacher: b.teacher,
        Room: b.room || 'N/A',
        StartTime: b.startTime,
        EndTime: b.endTime,
        Building: '',
        Status: 'Active',
        Periods: '',
        _days: new Set(b.day ? [b.day] : []),
      });
    }
  }
  const order = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
  return [...byCourse.values()].map(({ _days, ...row }) => ({
    ...row,
    Days: [..._days].sort((a, b) => order[a] - order[b]).join(', '),
  }));
}

async function schedule(session, link, options, progressTracker) {
  const { $, blocks } = await fetchScheduleBlocks(session, link, options, progressTracker);
  progressTracker?.update?.(80, 'Parsing schedule');
  return {
    schedule: toSchedule(blocks),
    students: parseStudents($),
    studentId: options.studentId || selectedStudentId($),
  };
}

export { schedule, fetchScheduleBlocks, WEEKDAYS };
