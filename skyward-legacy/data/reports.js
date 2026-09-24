/**
 * Academic history -> transcript. POST sfacademichistory001.w and group course
 * rows under their school-year / grade-level headers.
 *
 * Skyward legacy Family Access exposes no separate report-card / interim page in
 * the captured flow, so only `transcript` is wired up; core returns a clean 404
 * for reportCard / ipr.
 */

import * as cheerio from 'cheerio';
import { checkSessionValidity, tokenBody, portalUrl, lazyPortalUrl } from '../auth/credentials.js';

// Academic history is delivered as Skyward grid JSON: each row is
// { h:"<tr...>", c:[{h:"<td...>...</td>"}, ...] } (the row's own `h` is only the
// opening <tr>, cells live in `c`). We pull out every "tb":{"r":[ ... ] } array,
// JSON.parse it (before any unescaping, so it stays valid), then read each row's
// cell text. Year-header rows switch the active year bucket.
function extractRowArrays(raw) {
  const arrays = [];
  const marker = '"tb":{"r":';
  let from = 0;
  let idx;
  while ((idx = raw.indexOf(marker, from)) !== -1) {
    const open = raw.indexOf('[', idx);
    from = idx + marker.length;
    if (open === -1) continue;
    // Scan for the matching ] with string awareness.
    let depth = 0;
    let inStr = false;
    let esc = false;
    let end = -1;
    for (let p = open; p < raw.length; p++) {
      const ch = raw[p];
      if (esc) { esc = false; continue; }
      if (ch === '\\') { esc = true; continue; }
      if (ch === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (ch === '[') depth++;
      else if (ch === ']') { depth--; if (depth === 0) { end = p; break; } }
    }
    if (end === -1) continue;
    try {
      arrays.push(JSON.parse(raw.substring(open, end + 1)));
    } catch (e) { /* skip malformed grid */ }
  }
  return arrays;
}

function cellText($, h) {
  try { return cheerio.load(h || '').root().text().replace(/\s+/g, ' ').trim(); }
  catch (e) { return ''; }
}

function parseTranscript(rawHtml) {
  const raw = String(rawHtml);
  const rowArrays = extractRowArrays(raw);

  const years = [];
  let current = null;

  for (const rows of rowArrays) {
    for (const row of rows) {
      const cells = (row.c || []).map((c) => cellText(cheerio, c.h));
      const joined = cells.join(' ').replace(/\s+/g, ' ').trim();
      if (!joined) continue;

      const header = joined.match(/^(\d{4}\s*-\s*\d{4}),?\s*Grade\s*(\w+)\s*(.*)$/i);
      if (header) {
        current = {
          year: header[1].replace(/\s+/g, ''),
          grade: header[2].trim(),
          school: (header[3] || '').trim(),
          courses: [],
        };
        years.push(current);
        continue;
      }

      if (!current) continue;
      const name = cells.find(Boolean);
      if (name && !/^(class|course|description|grade|credit|semester)$/i.test(name)) {
        const grades = cells.slice(cells.indexOf(name) + 1).filter(Boolean);
        if (grades.length > 0) current.courses.push({ course: name, grades });
      }
    }
  }

  return years.filter((y) => y.courses.length > 0);
}

// Skyward term labels -> the report-card column keys the apps already render.
const REPORT_LABEL_MAP = {
  '1ST': 'first', '2ND': 'second', '3RD': 'third', '4TH': 'fourth', '5TH': 'fifth', '6TH': 'sixth',
  SM1: 'sem1', SM2: 'sem2', EX1: 'exam1', EX2: 'exam2', EOY: 'eoy',
  CZ1: 'cnd1', CZ2: 'cnd2', CZ3: 'cnd3', CZ4: 'cnd4', CZ5: 'cnd5', CZ6: 'cnd6',
};

// The current-year report card is the first grade grid on the academic-history
// page. Read its header labels, then map each course row's cells onto the shared
// report-card column keys.
function parseReportCard(rawHtml) {
  const arrays = extractRowArrays(String(rawHtml));
  if (arrays.length === 0) return [];

  const rows = arrays[0];
  let labels = null;
  // Each class spans two semester sections (fall columns first/second/sem1,
  // spring columns fourth/.../sem2); merge them into one row per course so the
  // report card reads as a single line per class.
  const byCourse = new Map();

  for (const row of rows) {
    const cells = (row.c || []).map((c) => cellText(cheerio, c.h));
    const first = (cells[0] || '').trim();
    if (/^class$/i.test(first)) { labels = cells; continue; }
    if (/^\d{4}\s*-\s*\d{4}/.test(first)) continue; // year header
    if (!labels || !first) continue;

    const entry = byCourse.get(first) || { course: first, description: first };
    for (let i = 1; i < labels.length; i++) {
      const key = REPORT_LABEL_MAP[(labels[i] || '').trim().toUpperCase()];
      if (key && cells[i]) entry[key] = cells[i];
    }
    byCourse.set(first, entry);
  }

  const report = [...byCourse.values()];
  return report.length > 0 ? [{ reportCardRun: '1', report }] : [];
}

async function reportCard(session, link, options, progressTracker) {
  const res = await session.post(lazyPortalUrl(session, link, 'ACADEMIC_HISTORY'), tokenBody(session), {
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      Referer: portalUrl(session, link, 'HOME'),
    },
  });
  checkSessionValidity(res);
  progressTracker?.update?.(75, 'Parsing report card');

  return { reportCards: parseReportCard(res.data) };
}

async function transcript(session, link, options, progressTracker) {
  const res = await session.post(lazyPortalUrl(session, link, 'ACADEMIC_HISTORY'), tokenBody(session), {
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      Referer: portalUrl(session, link, 'HOME'),
    },
  });
  checkSessionValidity(res);
  progressTracker?.update?.(75, 'Parsing transcript');

  return { transcriptData: parseTranscript(res.data) };
}

export { transcript, reportCard };
