/**
 * Classes + single-class — fetches the Assignments page (optionally switching
 * report-card run/term via an ASP.NET postback), then parses every class card
 * into grades, assignment scores, and category breakdowns.
 *
 * Term switching caches the viewstate on `session.cache.classes` so a follow-up
 * term request can postback without re-fetching the base page.
 *
 * Pages are read by the DOM-free scanner in fastScan.js first (several times
 * cheaper on Workers CPU), falling back to the cheerio code below whenever the
 * scanner can't vouch for the page. `HAC_FAST_PATH` controls this: unset/"on"
 * scans first, "off" always uses cheerio, "verify" runs both, logs any
 * difference and returns the cheerio result.
 */

import * as cheerio from '../../core/html.js';
import { HAC_ENDPOINTS } from '../config/constants.js';
import { checkSessionValidity } from '../auth/credentials.js';
import { ValidationError } from '../../core/errors.js';
import { env } from '../../core/env.js';
import { scanViewState, scanTermInfo, scanClasses, hiddenRanges } from './fastScan.js';

function splitClassHeaderAndCourseName(classText) {
  const parts = classText.split(' ');
  return {
    classHeader: parts.slice(0, 3).join(' '),
    courseName: parts.slice(3).join(' '),
  };
}

function createTermData(reportCardRun = '') {
  return {
    '__EVENTTARGET': 'ctl00$plnMain$btnRefreshView',
    '__EVENTARGUMENT': '',
    '__LASTFOCUS': '',
    '__VIEWSTATEGENERATOR': 'B0093F3C',
    'ctl00$plnMain$ddlReportCardRuns': reportCardRun,
  };
}

function extractViewStateData($) {
  return {
    viewstate: $('input[name="__VIEWSTATE"]').val(),
    eventvalidation: $('input[name="__EVENTVALIDATION"]').val(),
    // A dropdown with fewer than two runs (start of year / summer) has no option
    // at index 1; `.val()` is then undefined and `.substring` used to throw a 500.
    year: ($('select[name="ctl00$plnMain$ddlReportCardRuns"] option').eq(1).val() || '').substring(2),
    term: $('select[name="ctl00$plnMain$ddlReportCardRuns"] option[selected="selected"]').text().trim(),
  };
}

/**
 * A fetched Assignments page. Its DOM is built only if a reader needs it, and
 * script/comment ranges are found once for all fast readers.
 */
function pageOf(html) {
  let $;
  let ranges;
  return {
    html,
    get $() { return ($ ??= cheerio.load(html)); },
    get ranges() { return (ranges ??= hiddenRanges(html)); },
  };
}

/** Read the page with the fast scanner, falling back to (or checking against) cheerio. */
function read(page, label, fast, slow) {
  const mode = (env.HAC_FAST_PATH || 'on').toLowerCase();
  if (mode === 'off' || typeof page.html !== 'string') return slow(page.$);
  const quick = fast(page.html, page.ranges);
  if (mode === 'verify') {
    const reference = slow(page.$);
    if (JSON.stringify(quick) !== JSON.stringify(reference)) {
      console.warn(`hac fast path: ${label} ${quick === null ? 'fell back' : 'MISMATCH'}`);
    }
    return reference;
  }
  if (quick !== null) return quick;
  console.warn(`hac fast path: ${label} fell back to cheerio`);
  return slow(page.$);
}

const readViewState = (page) => read(page, 'viewstate', scanViewState, extractViewStateData);
const readTermInfo = (page) => read(page, 'terms', scanTermInfo, extractTermInfo);
const readClasses = (page) => read(page, 'classes', scanClasses, extractClasses);

async function fetchAssignmentsPage(session, link, term, progressTracker) {
  const classesCache = session.cache.classes;
  const fetchNew = !term ||
    (classesCache && classesCache.term === term) ||
    !(term && classesCache && classesCache.viewstate && classesCache.eventvalidation);

  let page, viewstate, eventvalidation, year;

  if (fetchNew) {
    progressTracker?.update?.(65, term ? 'Going to term' : 'Fetching classes');
    const scoresResponse = await session.get(link + HAC_ENDPOINTS.ASSIGNMENTS);
    checkSessionValidity(scoresResponse);
    page = pageOf(scoresResponse.data);

    const data = readViewState(page);
    ({ viewstate, eventvalidation, year } = data);
    session.cache.classes = { viewstate, eventvalidation, year, term: data.term };
  } else {
    progressTracker?.update?.(65, 'Going to term');
    ({ viewstate, eventvalidation, year } = classesCache);
  }

  if (term) {
    const termData = createTermData(`${term}-${year}`);
    termData['__VIEWSTATE'] = viewstate;
    termData['__EVENTVALIDATION'] = eventvalidation;

    const termResponse = await session.post(link + HAC_ENDPOINTS.ASSIGNMENTS, termData);
    checkSessionValidity(termResponse);
    page = pageOf(termResponse.data);
    session.cache.classes = readViewState(page);
  }

  return page;
}

function extractTermInfo($) {
  const term = $('#plnMain_ddlReportCardRuns').find('option[selected="selected"]').text().trim();
  const termList = $('#plnMain_ddlReportCardRuns').find('option')
    .toArray()
    .map((e) => $(e).text().trim())
    .slice(1);
  return { term, termList };
}

function extractClasses($) {
  const scheduleData = {};

  $('.AssignmentClass').each(function () {
    const classHeader = splitClassHeaderAndCourseName(
      $(this).find('.sg-header .sg-header-heading').text().trim()
    ).classHeader.trim();

    if (!scheduleData[classHeader]) {
      scheduleData[classHeader] = {
        course: classHeader,
        name: splitClassHeaderAndCourseName(
          $(this).find('.sg-header .sg-header-heading').eq(0).text().trim()
        ).courseName.trim(),
      };
    }

    const averageText = $(this).find('.sg-header .sg-header-heading.sg-right').text().trim().split(' ').pop();
    scheduleData[classHeader].average = averageText.endsWith('%') ? averageText.slice(0, -1) : averageText;

    scheduleData[classHeader].scores = [];
    $(this).find('.sg-content-grid > .sg-asp-table > tbody > .sg-asp-table-data-row').each(function () {
      const assignment = {
        name: $(this).children().eq(2).children().first().text().trim(),
        category: $(this).children().eq(3).text().trim(),
        percentage: $(this).children().eq(9).text().trim().slice(0, -1),
        score: $(this).children().eq(4).text().trim(),
        totalPoints: parseFloat($(this).children().eq(5).text().trim()) || '',
        weight: parseFloat($(this).children().eq(6).text().trim()) || '',
        weightedScore: parseFloat($(this).children().eq(7).text().trim()) || '',
        weightedTotalPoints: parseFloat($(this).children().eq(8).text().trim()) || '',
        dateDue: $(this).children().eq(0).text().trim(),
        dateAssigned: $(this).children().eq(1).text().trim(),
        badges: [],
      };

      if (assignment.score && assignment.score.includes('Missing')) {
        assignment.badges.push('missing');
        assignment.score = 0;
      }
      if (assignment.score && assignment.score.includes('Exempt')) {
        assignment.badges.push('exempt');
        assignment.score = '';
      }
      if (assignment.name.endsWith(' *')) {
        assignment.badges.push('dropped');
        assignment.name = assignment.name.slice(0, -2).trim();
      }

      assignment.score = parseFloat(assignment.score) || assignment.score;
      scheduleData[classHeader].scores.push(assignment);
    });

    scheduleData[classHeader].categories = {};
    $(this).find('.sg-content-grid .sg-asp-table-group tr.sg-asp-table-data-row').each(function () {
      const categoryName = $(this).children().eq(0).text().trim();
      scheduleData[classHeader].categories[categoryName] = {
        studentsPoints: $(this).children().eq(1).text().trim(),
        maximumPoints: $(this).children().eq(2).text().trim(),
        percent: $(this).children().eq(3).text().trim(),
        categoryWeight: $(this).children().eq(4).text().trim(),
        categoryPoints: $(this).children().eq(5).text().trim(),
      };
    });
  });

  return Object.values(scheduleData);
}

async function classes(session, link, options, progressTracker) {
  const page = await fetchAssignmentsPage(session, link, options.term, progressTracker);
  const { term, termList } = readTermInfo(page);
  return { scoresIncluded: true, termList, term, classes: readClasses(page) };
}

async function singleClass(session, link, options, progressTracker) {
  if (!options.class) {
    throw new ValidationError('Missing required parameters (class)');
  }
  const page = await fetchAssignmentsPage(session, link, options.term, progressTracker);
  const { term, termList } = readTermInfo(page);
  const currentClass = readClasses(page).find((c) => c.name === options.class);
  if (!currentClass) {
    throw new ValidationError('Class not found');
  }
  return { scoresIncluded: true, termList, term, class: currentClass };
}

export { classes, singleClass, extractClasses, extractTermInfo, extractViewStateData };
