/**
 * Classes + single-class — fetches the Assignments page (optionally switching
 * report-card run/term via an ASP.NET postback), then parses every class card
 * into grades, assignment scores, and category breakdowns.
 *
 * Term switching caches the viewstate on `session.cache.classes` so a follow-up
 * term request can postback without re-fetching the base page.
 */

import * as cheerio from 'cheerio';
import { HAC_ENDPOINTS } from '../config/constants.js';
import { checkSessionValidity } from '../auth/credentials.js';
import { ValidationError } from '../../core/errors.js';

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

async function fetchAssignmentsPage(session, link, term, progressTracker) {
  const classesCache = session.cache.classes;
  const fetchNew = !term ||
    (classesCache && classesCache.term === term) ||
    !(term && classesCache && classesCache.viewstate && classesCache.eventvalidation);

  let $, viewstate, eventvalidation, year;

  if (fetchNew) {
    progressTracker?.update?.(65, term ? 'Going to term' : 'Fetching classes');
    const scoresResponse = await session.get(link + HAC_ENDPOINTS.ASSIGNMENTS);
    checkSessionValidity(scoresResponse);
    $ = cheerio.load(scoresResponse.data);

    const data = extractViewStateData($);
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
    $ = cheerio.load(termResponse.data);
    session.cache.classes = extractViewStateData($);
  }

  return $;
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
  const $ = await fetchAssignmentsPage(session, link, options.term, progressTracker);
  const { term, termList } = extractTermInfo($);
  return { scoresIncluded: true, termList, term, classes: extractClasses($) };
}

async function singleClass(session, link, options, progressTracker) {
  if (!options.class) {
    throw new ValidationError('Missing required parameters (class)');
  }
  const $ = await fetchAssignmentsPage(session, link, options.term, progressTracker);
  const { term, termList } = extractTermInfo($);
  const currentClass = extractClasses($).find((c) => c.name === options.class);
  if (!currentClass) {
    throw new ValidationError('Class not found');
  }
  return { scoresIncluded: true, termList, term, class: currentClass };
}

export { classes, singleClass };
