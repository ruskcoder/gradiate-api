/**
 * Schedule — POST sfschedule001.w and read the MATRIX view (periods down the
 * side, term columns across). Each meeting becomes a row keyed like HAC's
 * schedule so the apps render it the same way.
 */

import * as cheerio from 'cheerio';
import { checkSessionValidity, tokenBody, portalUrl, lazyPortalUrl } from '../auth/credentials.js';

function parseSchedule($) {
  let building = '';
  const header = $('div[id^="MATRIX_scheduleGrid_"] h3').first().text() || '';
  const bMatch = header.match(/for\s+(.+)$/i);
  if (bMatch) building = bMatch[1].trim();

  // The matrix repeats each class across term columns; collapse to one row per
  // (course, period) and merge the terms it meets. Field names mirror HAC's
  // schedule (Periods/Description/Course/...) so the apps render it identically.
  const byKey = new Map();
  const matrix = $('div[id^="MATRIX_scheduleGrid_"] table.schedule').first();

  matrix.find('tbody > tr').each(function () {
    const period = $(this).find('td.period').first().text().replace(/Period\s*/i, '').trim();

    $(this).find('td.classDesc').each(function (termIndex) {
      const inner = $(this).find('td[scope="row"]').first();
      if (!inner || inner.length === 0) return;
      const parts = (inner.html() || '')
        .split(/<br\s*\/?\s*>/i)
        .map((p) => cheerio.load(p).text().trim())
        .filter(Boolean);
      if (parts.length === 0) return;

      let days = '';
      let room = '';
      if (parts[2]) {
        const dMatch = parts[2].match(/Days\s+([A-Za-z,]+)/i);
        if (dMatch) days = dMatch[1].replace(/\s+/g, '');
        const rMatch = parts[2].match(/Room\s+(.+)$/i);
        if (rMatch) room = rMatch[1].trim();
      }

      const name = parts[0] || '';
      const key = `${name}|${period}`;
      const existing = byKey.get(key);
      if (existing) {
        existing._terms.add(termIndex + 1);
      } else {
        byKey.set(key, {
          Periods: period || '',
          Course: name,
          Description: name,
          Teacher: parts[1] || '',
          Room: room || 'N/A',
          Days: days || '',
          Building: building || '',
          Status: 'Active',
          _terms: new Set([termIndex + 1]),
        });
      }
    });
  });

  return [...byKey.values()].map(({ _terms, ...row }) => {
    const terms = [..._terms].sort((a, b) => a - b);
    return { ...row, 'Marking Periods': terms.map((t) => `Term ${t}`).join(', ') };
  });
}

async function schedule(session, link, options, progressTracker) {
  const res = await session.post(lazyPortalUrl(session, link, 'SCHEDULE'), tokenBody(session), {
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      Referer: portalUrl(session, link, 'HOME'),
    },
  });
  checkSessionValidity(res);
  progressTracker?.update?.(75, 'Parsing schedule');

  return { schedule: parseSchedule(cheerio.load(res.data)) };
}

export { schedule };
