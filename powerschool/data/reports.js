/**
 * Report card / grade history — guardian/termgrades.html.
 *
 * The page is ONE `<table class="grid">` holding a run of repeated blocks:
 *   [ term-header row (`<th colspan=5>C1</th>`) ]
 *   [ column-header row (Course / Grade / % / Cit / Hrs) ]
 *   [ one course row per class … ]
 * for every stored term (C1-C6, P1-P6, E1/E2, S1/S2, Y1, …).
 *
 * We split that stream on each term header into one report-card "run" per term,
 * emitting the same `{ reportCards: [{ reportCardRun, report: [rows] }] }` shape
 * HAC returns so a single UI renders both. Each row carries `course`,
 * `description`, `grade` (the posted letter/number, `*` = in progress) and
 * `percent`; the column-driven UI shows whichever keys are present.
 */

import * as cheerio from '../../core/html.js';
import { ENDPOINTS } from '../config/constants.js';
import { checkSessionValidity } from '../auth/credentials.js';
import { fetchHome, parseStudents, selectedStudentId } from './_grid.js';

/** A term header row is a lone `<th colspan>` naming the term (e.g. "C1"). */
function termHeaderLabel($, tr) {
  const ths = $(tr).find('th');
  if (ths.length === 1 && ths.first().attr('colspan')) {
    return ths.first().text().replace(/00A0/g, ' ').trim();
  }
  return null;
}

/** The Course/Grade/%/Cit/Hrs label row — skipped, not data. */
function isColumnHeaderRow($, tr) {
  return $(tr).find('th').length > 1;
}

function reportCard(session, link, options, progressTracker) {
  return (async () => {
    if (options.studentId) await fetchHome(session, link, options.studentId, progressTracker);
    progressTracker?.update?.(60, 'Loading grade history');
    const res = await session.get(link + ENDPOINTS.TERM_GRADES);
    checkSessionValidity(res);
    progressTracker?.update?.(80, 'Parsing report cards');

    const $ = cheerio.load(res.data);
    const table = $('table.grid').first();
    const reportCards = [];
    let current = null;

    table.find('tr').each((_, tr) => {
      const term = termHeaderLabel($, tr);
      if (term) {
        current = { reportCardRun: term, report: [] };
        reportCards.push(current);
        return;
      }
      if (!current || isColumnHeaderRow($, tr)) return;

      const courseCell = $(tr).find('td.table-element-text-align-start').first();
      if (!courseCell.length) return;
      const tds = $(tr).find('td');
      const course = courseCell.text().replace(/00A0/g, ' ').trim();
      const grade = $(tds[1]).text().replace(/00A0/g, ' ').trim();
      const percent = $(tds[2]).text().replace(/00A0/g, ' ').trim();
      if (course) current.report.push({ course, description: course, grade, percent });
    });

    // Drop empty runs (a term header with no course rows underneath).
    const filled = reportCards.filter((rc) => rc.report.length > 0);

    return {
      reportCards: filled,
      students: parseStudents($),
      studentId: options.studentId || selectedStudentId($),
    };
  })();
}

export { reportCard };
