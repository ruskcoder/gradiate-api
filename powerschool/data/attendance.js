/**
 * Attendance — guardian/attendance.html.
 *
 * PowerSchool renders attendance as a course×day matrix inside `<table class="grid">`:
 * a header row dates every column (`<th title="Mon, Aug 11, 2025 : A Day">`) and
 * each body row carries, per class, two half-day cells (the A- and B-block
 * expressions) holding an attendance code. A code legend at the bottom
 * (`#legend`) maps each letter to its meaning (T=Tardy, EX=Absent Excused, …).
 *
 * Districts differ in how much of the year one grid spans: some emit ONE grid for
 * the whole year, others emit several stacked grids (e.g. one per reporting term
 * or month) running down the page. We therefore read EVERY dated grid and merge
 * their events, so no month is dropped just because it lived in a later table.
 *
 * We reshape that matrix into the same `{ month, year, events }` calendar shape
 * HAC/Skyward return — `events` keyed by `M/D/YY`, each an array of
 * `{ event, periods, classes, color }` — so a single UI renders every platform's
 * attendance on the calendar. `month`/`year` default the calendar to the current
 * month (events already span every month, keyed by date). A blank/`.`/`-` half
 * means present or no meeting and is skipped; `color` is left for the UI to fill.
 */

import * as cheerio from '../../core/html.js';
import { ENDPOINTS } from '../config/constants.js';
import { checkSessionValidity } from '../auth/credentials.js';
import { fetchHome, parseStudents, selectedStudentId } from './_grid.js';

/** Split an element's inner HTML on <br> into trimmed text lines. */
function brLines($, el) {
  const html = el ? $(el).html() : '';
  if (!html) return [];
  return html
    .split(/<br\s*\/?>/i)
    .map((chunk) => cheerio.load(chunk).text().replace(/00A0/g, ' ').trim());
}

/** Parse `#legend` "Attendance Codes:" line into { CODE: description } (minus Blank). */
function parseLegend($) {
  const map = {};
  $('#legend p').each((_, p) => {
    const text = $(p).text();
    if (!/Attendance Codes/i.test(text)) return;
    text.replace(/Attendance Codes:\s*/i, '').split('|').forEach((pair) => {
      const m = pair.trim().match(/^([A-Za-z]+)\s*=\s*(.+)$/);
      if (m && m[1] !== 'Blank') map[m[1]] = m[2].trim();
    });
  });
  return map;
}

/** Every attendance matrix on the page: grid tables whose header dates columns. */
function attendanceTables($) {
  const tables = [];
  $('table.grid').each((_, t) => {
    if ($(t).find('th[title*=" : "]').length) tables.push($(t));
  });
  return tables;
}

/**
 * Read one dated grid into the accumulating { date -> { name -> entry } } map.
 * Returns the latest date seen in this table (or the running latest).
 */
function parseAttendanceGrid($, table, legend, events, latest) {
  // Column index -> M/D/YY, read from each dated header cell's title.
  const dates = $(table).find('th[title*=" : "]').map((_, th) => {
    const dt = new Date($(th).attr('title').split(' : ')[0]);
    if (isNaN(dt)) return '';
    if (!latest || dt > latest) latest = dt;
    return `${dt.getMonth() + 1}/${dt.getDate()}/${String(dt.getFullYear()).slice(-2)}`;
  }).get();

  $(table).find('tr').each((_, tr) => {
    const courseCell = $(tr).find('td.table-element-text-align-start').first();
    if (!courseCell.length) return;
    const tds = $(tr).children('td');
    const course = brLines($, courseCell[0])[0] || '';
    const expr = brLines($, tds[1]);          // ["A1(A)", "A1(B)"] block expressions
    const dayCells = tds.slice(2);            // one cell per dated column

    dayCells.each((k, td) => {
      const date = dates[k];
      if (!date) return;
      brLines($, td).forEach((code, half) => {
        // `.` = class didn't meet this half, blank = present, `-` = not in session.
        if (!code || code === '.' || code === '-' || !legend[code]) return;
        const name = legend[code];
        const bucket = (events[date] = events[date] || {});
        const entry = (bucket[name] = bucket[name] || { event: name, periods: [], classes: [] });
        const period = expr[half] || '';
        if (period && !entry.periods.includes(period)) entry.periods.push(period);
        if (course && !entry.classes.includes(course)) entry.classes.push(course);
      });
    });
  });

  return latest;
}

function attendance(session, link, options, progressTracker) {
  return (async () => {
    // Switch the portal's active student (POST to home) before reading attendance.
    if (options.studentId) await fetchHome(session, link, options.studentId, progressTracker);
    progressTracker?.update?.(55, 'Loading attendance');
    const res = await session.get(link + ENDPOINTS.ATTENDANCE);
    checkSessionValidity(res);
    progressTracker?.update?.(80, 'Parsing attendance');

    const $ = cheerio.load(res.data);
    const legend = parseLegend($);
    const events = {};
    let latest = null;

    // Merge every dated grid on the page — one district emits a single year-long
    // grid, another a stack of shorter (per-term / per-month) grids; both must be
    // read or whole months go missing.
    for (const table of attendanceTables($)) {
      latest = parseAttendanceGrid($, table, legend, events, latest);
    }

    // Flatten each date's { name: entry } map into the events array shape.
    const eventsOut = {};
    for (const [date, byName] of Object.entries(events)) {
      eventsOut[date] = Object.values(byName).map((e) => ({
        event: e.event,
        periods: e.periods,
        classes: e.classes,
        color: '',
      }));
    }

    // Events span the whole year keyed by date, so `month`/`year` are just the
    // calendar's default position: today when there's live data, else the last
    // dated column (end of the loaded year) as a fallback.
    const now = new Date();
    const hasCurrentMonthData = Object.keys(eventsOut).length > 0;
    const anchor = hasCurrentMonthData ? now : latest;
    return {
      month: anchor ? anchor.toLocaleString('en-US', { month: 'long' }) : '',
      year: anchor ? String(anchor.getFullYear()) : '',
      events: eventsOut,
      students: parseStudents($),
      studentId: options.studentId || selectedStudentId($),
    };
  })();
}

export { attendance };
