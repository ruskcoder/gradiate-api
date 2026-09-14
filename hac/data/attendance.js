/**
 * Attendance — the MonthlyView calendar. Optionally navigates to a requested
 * month via ASP.NET prev/next postbacks, then maps each weekday cell to its
 * event(s) and color. The current month's parsed page is cached on the session
 * so month navigation within one request doesn't re-fetch.
 */

import * as cheerio from 'cheerio';
import { HAC_ENDPOINTS, ERROR_MESSAGES, MONTH_INPUTS } from '../config/constants.js';
import { checkSessionValidity } from '../auth/credentials.js';
import { ValidationError } from '../../core/errors.js';

function createMonthData(viewState = '', eventValidation = '', eventArgument = '') {
  return {
    '__EVENTTARGET': 'ctl00$plnMain$cldAttendance',
    '__EVENTARGUMENT': eventArgument,
    '__VIEWSTATE': viewState,
    '__VIEWSTATEGENERATOR': 'C0F72E2D',
    '__EVENTVALIDATION': eventValidation,
    'ctl00$plnMain$hdnValidMHACLicense': 'N',
    'ctl00$plnMain$hdnPeriod': '',
    'ctl00$plnMain$hdnAttendance': '',
    'ctl00$plnMain$hdnDismissTime': '',
    'ctl00$plnMain$hdnArriveTime': '',
    'ctl00$plnMain$hdnColorLegend': '',
    'ctl00$plnMain$hdnCalTooltip': '',
    'ctl00$plnMain$hdnCalPrvMthToolTip': '',
    'ctl00$plnMain$hdnCalNxtMthToolTip': '',
    'ctl00$plnMain$hdnMultipleAttendenceCodes': 'Multiple Attendance Codes',
    'ctl00$plnMain$hdnSchoolClosed': 'School Closed',
    'ctl00$plnMain$hdnLegendNoCodes': 'Attendance Codes could not be found.',
    'ctl00$plnMain$hdnHyperlinkText_exist': '(Alerts Are Limited. Click to View List of Selected Choices.)',
    'ctl00$plnMain$hdnHyperlinkText_Noexist': '(Limit Alerts to Specific Types of Attendance)',
  };
}

function processAttendanceDate(dateQuery) {
  if (!dateQuery) return null;
  const [reqMonth = '', reqYear] = String(dateQuery).split('-');
  const monthIndex = MONTH_INPUTS[reqMonth.toLowerCase()];
  const year = parseInt(reqYear);
  // A missing/garbled year used to yield a NaN month code, which never matches
  // and burned all 15 navigation postbacks against the portal.
  if (monthIndex === undefined || isNaN(year)) {
    throw new ValidationError(ERROR_MESSAGES.INVALID_MONTH);
  }
  return { monthIndex, reqYear: year };
}

/** Month code from a calendar prev/next link's `__doPostBack(…,'V1234')` href. */
function monthCodeFromLink(el) {
  const part = (el.attr('href') || '').split('\'')[3];
  return part ? parseInt(part.slice(1)) : NaN;
}

function calculateMonthCode(year, monthIndex) {
  const jan1 = new Date(2000, 0, 1);
  const targetDate = new Date(year, monthIndex, 1);
  return Math.floor((targetDate - jan1) / 86400000);
}

function extractCurrentMonthInfo($) {
  const monthDisplay = $('#plnMain_cldAttendance > tbody > tr:nth-child(1) > td > table > tbody > tr > td:nth-child(2)').text().trim();
  const [monthName, year] = monthDisplay.split(' ');
  const monthIndex = new Date(monthName + ' 1, 2000').getMonth();
  return { monthName, year: parseInt(year), monthIndex, monthCode: calculateMonthCode(parseInt(year), monthIndex) };
}

async function navigateToMonth(session, link, targetMonthCode, initialCheerio) {
  const maxLoops = 15;
  let loops = 0;
  let $ = initialCheerio;

  if (!$) {
    const currentPage = await session.get(link + HAC_ENDPOINTS.ATTENDANCE);
    $ = cheerio.load(currentPage.data);
  }

  while (loops < maxLoops) {
    loops++;
    const prevElement = $('a[title="Go to the previous month"]');
    const nextElement = $('a[title="Go to the next month"]');
    let prev, next;

    if (!nextElement.text() && !prevElement.text()) {
      return $; // no navigation links at all (logged out / unexpected page)
    } else if (!nextElement.text()) {
      prev = monthCodeFromLink(prevElement);
      if (isNaN(prev) || targetMonthCode > prev) return $;
    } else if (!prevElement.text()) {
      next = monthCodeFromLink(nextElement);
      if (isNaN(next) || targetMonthCode < next) return $;
    } else {
      prev = monthCodeFromLink(prevElement);
      next = monthCodeFromLink(nextElement);
    }

    const monthData = createMonthData(
      $('input[name="__VIEWSTATE"]').val(),
      $('input[name="__EVENTVALIDATION"]').val()
    );

    if (targetMonthCode <= prev) {
      monthData['__EVENTARGUMENT'] = `V${prev}`;
    } else if (targetMonthCode >= next) {
      monthData['__EVENTARGUMENT'] = `V${next}`;
    } else {
      break;
    }

    const response = await session.post(link + HAC_ENDPOINTS.ATTENDANCE, monthData);
    $ = cheerio.load(response.data);
  }

  return $;
}

function extractAttendanceData($) {
  const events = {};
  const colorKey = {};

  $('.sg-clearfix div').each(function () {
    const styleAttr = $(this).children().eq(0).attr('style');
    if (styleAttr) {
      const color = styleAttr.substring(18).split(';')[0].toLowerCase();
      colorKey[$(this).children().eq(1).text().trim()] = color;
    }
  });

  const monthDisplay = $('#plnMain_cldAttendance > tbody > tr:nth-child(1) > td > table > tbody > tr > td:nth-child(2)').text().trim();

  $('.sg-asp-calendar tr').slice(2).find('td').each(function (index) {
    if ([0, 6].includes(index % 7)) return; // skip weekends

    const dateText = $(this).text() + ' ' + monthDisplay;
    const dateParts = dateText.split(' ');
    const month = new Date(dateParts[1] + ' 1, 2000').getMonth() + 1;
    const formattedDate = `${month}/${dateParts[0]}/${dateParts[2].slice(-2)}`;

    if ($(this).attr('title')) {
      const lines = $(this).attr('title').split('\n').map((l) => l.trim()).filter((l) => l);
      const eventMap = {};
      for (let i = 0; i < lines.length; i += 2) {
        const period = lines[i];
        const eventName = lines[i + 1];
        if (eventName) {
          (eventMap[eventName] = eventMap[eventName] || []).push(period);
        }
      }
      events[formattedDate] = Object.entries(eventMap).map(([eventName, periods]) => ({
        event: eventName,
        periods,
        classes: [],
        color: colorKey[eventName] || '',
      }));
    } else if ($(this).attr('style')) {
      const color = $(this).attr('style').substring(17).split(';')[0].toLowerCase();
      if (color === '#cccccc') {
        events[formattedDate] = [{ event: 'School Closed', periods: [], classes: [], color }];
      } else {
        const eventName = Object.entries(colorKey).find(([, col]) => col === color)?.[0] || '';
        if (eventName) {
          events[formattedDate] = [{ event: eventName, periods: [], classes: [], color }];
        }
      }
    }
  });

  return { month: monthDisplay.split(' ')[0], year: monthDisplay.split(' ')[1], events };
}

async function attendance(session, link, options) {
  const requestedDate = options.date ? processAttendanceDate(options.date) : null;
  const targetMonthCode = requestedDate ? calculateMonthCode(requestedDate.reqYear, requestedDate.monthIndex) : null;

  // Always fetch fresh. This used to stash the cheerio `$` in session.cache, which
  // is serialized to the client: the function was silently dropped, the stale
  // month info round-tripped, and a client-sent truthy `attendanceState.$` was
  // then called as a function and crashed the route.
  if (session.cache) delete session.cache.attendanceState;
  const attendanceResponse = await session.get(link + HAC_ENDPOINTS.ATTENDANCE);
  checkSessionValidity(attendanceResponse);
  let $ = cheerio.load(attendanceResponse.data);
  const currentMonthInfo = extractCurrentMonthInfo($);

  if (targetMonthCode && targetMonthCode !== currentMonthInfo.monthCode) {
    $ = await navigateToMonth(session, link, targetMonthCode, $);
  }

  return extractAttendanceData($);
}

export { attendance };
