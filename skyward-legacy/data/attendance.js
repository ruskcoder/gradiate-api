/**
 * Attendance — POST sfattendance001.w. This Skyward build renders attendance as
 * a history grid (Date / Attendance / Period / Class), not a monthly calendar,
 * so we read that table into the { month, year, events } shape the apps expect,
 * keyed by date. (The calendar variant is kept as a fallback for districts that
 * render one instead.)
 */

import * as cheerio from 'cheerio';
import { checkSessionValidity, tokenBody, portalUrl, lazyPortalUrl } from '../auth/credentials.js';

const MONTH_REGEX = /\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{4}\b/i;

function parseHistoryTable($) {
  const table = $('table[id^="grid_attendanceHistory"]').first();
  if (!table || table.length === 0) return null;

  const events = {};
  let latest = null;

  table.find('tbody tr').each(function () {
    const tds = $(this).find('td');
    if (tds.length < 2) return;
    const dateRaw = $(tds[0]).text().trim();          // "Thu May 21, 2026"
    const code = $(tds[1]).text().replace(/\s+/g, ' ').trim();
    const periodText = tds[2] ? $(tds[2]).text().trim() : '';
    const className = tds[3] ? $(tds[3]).text().trim() : '';

    const parsed = new Date(dateRaw);
    if (isNaN(parsed)) return;
    if (!latest || parsed > latest) latest = parsed;

    const date = `${parsed.getMonth() + 1}/${parsed.getDate()}/${String(parsed.getFullYear()).slice(-2)}`;
    const periods = periodText ? periodText.split(/[,&]/).map((s) => s.trim()).filter(Boolean) : [];

    // `classes` is an array to match PowerSchool/HAC so one UI renders every
    // platform's attendance without per-platform shape handling.
    const cls = className && className !== 'View Classes' ? className : '';
    (events[date] = events[date] || []).push({
      event: code,
      periods,
      classes: cls ? [cls] : [],
      color: '',
    });
  });

  if (Object.keys(events).length === 0) return null;
  return {
    month: latest ? latest.toLocaleString('en-US', { month: 'long' }) : '',
    year: latest ? String(latest.getFullYear()) : '',
    events,
  };
}

// Fallback: the classic monthly-calendar variant.
function parseCalendar($) {
  const events = {};
  const colorKey = {};
  $('.sg-clearfix div').each(function () {
    const style = $(this).children().eq(0).attr('style');
    const name = $(this).children().eq(1).text().trim();
    if (style && name) {
      const m = style.match(/#([0-9a-f]{3,6})/i);
      if (m) colorKey[name] = `#${m[1]}`.toLowerCase();
    }
  });

  let monthDisplay = '';
  const mm = $('body').text().match(MONTH_REGEX);
  if (mm) monthDisplay = mm[0];
  const [monthName = '', year = ''] = monthDisplay ? monthDisplay.split(' ') : [];
  const monthNum = monthName ? new Date(`${monthName} 1, 2000`).getMonth() + 1 : '';

  $('.sg-asp-calendar').first().find('tr').slice(2).find('td').each(function (index) {
    if ([0, 6].includes(index % 7)) return;
    const td = $(this);
    const dayMatch = td.text().trim().match(/^(\d{1,2})/);
    if (!dayMatch) return;
    const date = `${monthNum}/${dayMatch[1]}/${String(year).slice(-2)}`;
    if (td.attr('title')) {
      const lines = td.attr('title').split('\n').map((l) => l.trim()).filter(Boolean);
      const eventMap = {};
      for (let i = 0; i < lines.length; i += 2) {
        const name = lines[i + 1];
        if (name) (eventMap[name] = eventMap[name] || []).push(lines[i]);
      }
      events[date] = Object.entries(eventMap).map(([event, periods]) => ({
        event, periods, classes: [], color: colorKey[event] || '',
      }));
    }
  });

  return { month: monthName, year, events };
}

async function attendance(session, link, options, progressTracker) {
  const res = await session.post(lazyPortalUrl(session, link, 'ATTENDANCE'), tokenBody(session), {
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      Referer: portalUrl(session, link, 'HOME'),
    },
  });
  checkSessionValidity(res);
  progressTracker?.update?.(75, 'Parsing attendance');

  const $ = cheerio.load(res.data);
  return parseHistoryTable($) || parseCalendar($);
}

export { attendance };
