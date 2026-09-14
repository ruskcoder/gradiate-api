/**
 * Shared PowerSchool scraping core.
 *
 * Every data route starts from the "Grades and Attendance" home page
 * (guardian/home.html). That single page carries:
 *   - the student switcher (a parent account can hold several students),
 *   - the per-term average grid (the flat term columns P1/C1/…, or T1-T4, Q1-Q4,
 *     etc. — whatever the district defines), and
 *   - the per-class scores.html links whose begdate/enddate/frn/fg are the EXACT
 *     inputs the assignment-detail lookup needs.
 *
 * Multi-student handling is stateless: the client sends the chosen `studentId`
 * on each call, and we POST it as `selected_student_id` to switch the portal's
 * server-side selection before reading the page. With no `studentId` we read
 * whichever student is currently selected.
 */

import * as cheerio from 'cheerio';
import { ENDPOINTS } from '../config/constants.js';
import { checkSessionValidity } from '../auth/credentials.js';
import { groupByFamily, forestHasChildren } from '../../core/termTree.js';

// Header labels that are structural, not term columns.
const NON_TERM_HEADERS = new Set(['Exp', 'Course', 'Absences', 'Tardies', '']);

/**
 * Fetch the home grid HTML, optionally switching to a specific student first.
 * Returns { html, $ }.
 */
async function fetchHome(session, link, studentId, progressTracker) {
  progressTracker?.update?.(35, 'Loading grades');
  let res;
  if (studentId) {
    // Switch the portal's active student, then it returns that student's home.
    res = await session.post(
      link + ENDPOINTS.HOME,
      new URLSearchParams({ selected_student_id: String(studentId) }).toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );
  } else {
    res = await session.get(link + ENDPOINTS.HOME);
  }
  checkSessionValidity(res);
  return { html: res.data, $: cheerio.load(res.data) };
}

/** Parse the student switcher: [{ id, name, selected }]. Empty for single-student accounts. */
function parseStudents($) {
  const students = [];
  $('#students-list li').each((_, li) => {
    const a = $(li).find('a').first();
    const name = a.text().trim();
    const m = (a.attr('href') || '').match(/switchStudent\((\d+)\)/);
    if (name && m) {
      students.push({ id: m[1], name, selected: $(li).hasClass('selected') });
    }
  });
  return students;
}

/** The currently-selected student's id (used as student_ids in the detail lookup). */
function selectedStudentId($) {
  const students = parseStudents($);
  const sel = students.find((s) => s.selected) || students[0];
  return sel ? sel.id : null;
}

/** Text nodes of an element, trimmed, non-empty — e.g. "91<br>91" -> ["91","91"]. */
function textLines($, el) {
  const lines = [];
  $(el).contents().each((_, n) => {
    if (n.type === 'text') {
      const t = $(n).text().replace(/\u00A0/g, ' ').trim();
      if (t) lines.push(t);
    }
  });
  return lines;
}

/** Locate the grade grid (the "Attendance By Class" table with the scores links). */
function gradeTable($) {
  let table = null;
  $('table.linkDescList.grid, table.linkDescList').each((_, t) => {
    if (table) return;
    if ($(t).find('a[href*="scores.html"]').length > 0) table = t;
  });
  return table ? $(table) : null;
}

/**
 * Read the header row's ordered term labels (P1, C1, …, or T1-T4, etc.). These map
 * one-to-one, in order, onto each class row's grade cells.
 */
function parseTermLabels($, table) {
  const labels = [];
  // The first header row (th2) holds the rowspan=2 column headers.
  const headerRow = table.find('tr.th2').first().length
    ? table.find('tr.th2').first()
    : table.find('tr').first();
  headerRow.find('th[rowspan="2"], th[scope="col"]').each((_, th) => {
    const t = $(th).text().replace(/\u00A0/g, ' ').trim();
    if (!NON_TERM_HEADERS.has(t) && !/Last Week|This Week|^[MTWHF]$/.test(t)) {
      labels.push(t);
    }
  });
  return labels;
}

/** Parse a single grade cell -> { average, letterGrade, href } (href drives detail). */
function parseGradeCell($, td) {
  const a = $(td).find('a').first();
  if (!a.length) return { average: '', letterGrade: '', href: '' };
  const href = a.attr('href') || '';
  const lines = textLines($, a[0]);
  // "[ i ]" is an in-session class with no posted grade yet.
  const clean = lines.filter((l) => l !== '[ i ]');
  if (clean.length === 0) return { average: '', letterGrade: '', href };
  const letterGrade = clean[0];
  const average = clean[clean.length - 1];
  return {
    average,
    letterGrade: letterGrade !== average ? letterGrade : '',
    href,
  };
}

/**
 * Parse the whole gradebook grid into { termList, term, classes }.
 *   classes[i] = { course, name, period, teacher, email, room, averages, _hrefs }
 *   averages   = { <termLabel>: "<displayed grade>" }
 *   _hrefs     = { <termLabel>: "<scores.html?…>" }  (internal, for singleClass)
 */
function parseGradebook($, options = {}) {
  const table = gradeTable($);
  if (!table) return { termList: [], term: null, classes: [] };

  const termLabels = parseTermLabels($, table);
  const classes = [];

  table.find('tr[id^="ccid_"]').each((_, row) => {
    const cells = $(row).children('td');
    const courseCell = $(row).find('td.table-element-text-align-start').first();
    if (!courseCell.length) return;

    const courseIdx = cells.index(courseCell);
    // Term grade cells sit between the course cell and the trailing
    // Absences/Tardies columns, in the same order as the header term labels.
    const gradeCells = cells.slice(courseIdx + 1, cells.length - 2);

    const name = courseCell.clone().children().remove().end().text().replace(/\u00A0/g, ' ').trim();
    const period = $(cells[0]).text().replace(/\u00A0/g, ' ').trim();
    const teacher = (courseCell.find('a[title^="Details about"]').attr('title') || '')
      .replace(/^Details about\s*/i, '').trim();
    const email = (courseCell.find('a[href^="mailto:"]').attr('href') || '').replace(/^mailto:/i, '').trim();
    // Room lives in the "- Rm: <n>" span pair at the end of the course cell.
    let room = '';
    const rmSpan = courseCell.find('span.display-flex').first();
    if (rmSpan.length) room = rmSpan.find('span').last().text().replace(/\u00A0/g, ' ').trim();

    const averages = {};
    const _hrefs = {};
    gradeCells.each((k, td) => {
      const label = termLabels[k];
      if (!label) return;
      const { average, href } = parseGradeCell($, td);
      // A greyed-out ("Not available" / notInSession) cell has no link at all —
      // the class simply doesn't exist for that term, so drop it entirely rather
      // than reporting a blank average. An in-session-but-ungraded "[ i ]" cell
      // still carries an href, so it is kept (with an empty average).
      if (!href) return;
      averages[label] = average;
      _hrefs[label] = href;
    });

    classes.push({ course: name, name, period, teacher, email, room, averages, _hrefs });
  });

  // A term column is real only if at least one class is in session for it (has a link).
  const termList = termLabels.filter((label) => classes.some((c) => c._hrefs[label]));

  // Group the flat columns by letter type (P, C, S, …): one top tab per family,
  // its columns as subtabs.
  const termTree = groupByFamily(termList);
  const hasSubterms = forestHasChildren(termTree);

  const currentTerms = activeTerms(termList, classes);
  const term = pickCurrentTerm(termList, classes, options.term, currentTerms);
  return { termList, termTree, hasSubterms, term, currentTerms, classes };
}

/**
 * Every term column whose date window contains today — the terms that are
 * "currently being graded" right now. A district can have several active at once
 * (e.g. a progress period P, its cycle C, and the semester S all enclosing today);
 * the UI shows the finest as current and can post a per-term grade-change
 * notification for each. Ordered coarsest→finest (widest span first) so the last
 * entry is the bottom-most/most-specific term. Empty over breaks (nothing active).
 */
function activeTerms(termList, classes) {
  const now = Date.now();
  const active = [];
  for (const label of termList) {
    const r = termDateRange(classes, label);
    if (!r || isNaN(r.beg) || isNaN(r.end)) continue;
    if (r.beg.getTime() <= now && now <= r.end.getTime()) {
      active.push({ label, span: r.end - r.beg });
    }
  }
  active.sort((a, b) => b.span - a.span);
  return active.map((a) => a.label);
}

/** Pull a term's date window from any class's scores.html href for that term. */
function termDateRange(classes, label) {
  for (const c of classes) {
    const href = c._hrefs[label];
    if (!href) continue;
    const beg = /begdate=([\d/]+)/.exec(href);
    const end = /enddate=([\d/]+)/.exec(href);
    if (beg && end) {
      // `end[1]` parses as midnight-start of the last day (e.g. "6/15/2026" ->
      // 00:00:00 on the 15th), so a bare comparison against `Date.now()` would
      // read the term as already expired for the entirety of its actual last
      // day. Push the end boundary to the last instant of that day instead.
      const endDate = new Date(end[1]);
      endDate.setHours(23, 59, 59, 999);
      return { beg: new Date(beg[1]), end: endDate };
    }
  }
  return null;
}

/**
 * Choose the "current" term. Honors an explicit request; otherwise picks the
 * shortest term window that contains today (the active progress period), falling
 * back to the last valid column. This is date-driven, so it works regardless of a
 * district's term naming.
 */
function pickCurrentTerm(termList, classes, requested, currentTerms) {
  if (requested && termList.includes(requested)) return requested;
  if (termList.length === 0) return null;
  // The finest active term (narrowest window containing today) is the last of
  // the coarse→fine `currentTerms`. Falls back to the last column over breaks,
  // when nothing is active (e.g. summer), so there's always a sensible default.
  const active = currentTerms || activeTerms(termList, classes);
  return active.length ? active[active.length - 1] : termList[termList.length - 1];
}

/** Strip the internal href map before returning a class to the client. */
function publicClass(cls) {
  const { _hrefs, ...rest } = cls;
  return { ...rest, average: rest.averages?.[rest.currentTerm] };
}

export {
  fetchHome,
  parseStudents,
  selectedStudentId,
  parseGradebook,
  publicClass,
  gradeTable,
  textLines,
};
