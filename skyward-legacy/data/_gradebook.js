/**
 * Skyward gradebook brain — shared by classes / single-class / teachers.
 *
 * Everything is data-driven from the page: student/entity ids come from the
 * grid element id, and every per-term detail request reads its EXACT params
 * (gbId, bucket, stuId, entityId) straight from the class's `showGradeInfo`
 * anchor. That's why the numbers line up and Skyward returns a valid detail
 * dialog for districts with any term layout (PR1/1ST/SM1, T1-T4, Q1-Q4, ...).
 *
 * Parsers marked "ported" were carried over from the reverse-engineering WIP;
 * the fetch + top-level gradebook parse below were rewritten to be dynamic.
 */

import * as cheerio from 'cheerio';
import { SKYWARD_ENDPOINTS } from '../config/constants.js';
import { skywardTokens, sessionId, checkSessionValidity, tokenBody } from '../auth/credentials.js';
import { nestByFrequency, groupByFamily, forestHasChildren, pathToLabel } from '../../core/termTree.js';

// ---------------------------------------------------------------------------
// Fetch: gradebook HTML + harvest every dynamic identifier we need later.
// ---------------------------------------------------------------------------
async function fetchGradebookHtml(session, link, progressTracker) {
  progressTracker?.update?.(55, 'Fetching gradebook');
  const url = link + SKYWARD_ENDPOINTS.GRADEBOOK;
  const looksLikeGrid = (t) => /stuGradesGrid_\d+_|showGradeInfo/.test(t || '');

  let res = null;
  try {
    // Lazy token body: if the reauth wrapper detects an expired session here and
    // re-logs-in, the retry rebuilds from the fresh encses/sessionid.
    res = await session.post(url, tokenBody(session), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
    });
  } catch (e) {
    res = null;
  }
  if (!res || !looksLikeGrid(res.data)) {
    try { res = await session.get(url); } catch (e) { /* keep last */ }
  }
  checkSessionValidity(res || {});

  const html = (res && res.data) || '';
  harvestIdentifiers(session, html);
  return html;
}

// Pull studentId/entityId + the per-class/per-term anchor map out of the page
// and cache them on session.cache.skyward so detail requests are exact.
function harvestIdentifiers(session, html) {
  session.cache = session.cache || {};
  const sky = (session.cache.skyward = session.cache.skyward || {});

  const gridMatch = /stuGradesGrid_(\d+)_(\d+)/.exec(html);
  if (gridMatch) {
    sky.studentId = gridMatch[1];
    sky.entityId = gridMatch[2];
  }

  const classGbMap = {};   // key -> a default gbId
  const classTermMap = {}; // key -> { LABEL: { gbId, bucket, isEoc, sId, eId } }
  const anchorRe = /<a[^>]*id=['"]showGradeInfo['"][^>]*>/gi;
  let am;
  while ((am = anchorRe.exec(html)) !== null) {
    const tag = am[0];
    const get = (attr) => {
      const m = new RegExp('data-' + attr + '=[\'"]([^\'"]*)[\'"]', 'i').exec(tag);
      return m ? m[1].trim() : '';
    };
    const cNI = get('cNI');
    const gId = get('gId');
    const lit = get('lit');
    if (!cNI || !gId) continue;
    const trk = get('trk') || '0';
    const sec = get('sec') || '0';
    const key = cNI + '_' + trk + '_' + sec;
    classGbMap[key] = classGbMap[key] || gId;
    if (!classTermMap[key]) classTermMap[key] = {};
    if (lit) {
      classTermMap[key][lit] = {
        gbId: gId,
        bucket: get('bkt') || '',
        isEoc: get('isEoc') || 'no',
        sId: get('sId') || sky.studentId || '',
        eId: get('eId') || sky.entityId || '',
      };
    }
  }
  if (Object.keys(classGbMap).length > 0) {
    sky.classGbMap = classGbMap;
    sky.classTermMap = classTermMap;
    sky.gbId = sky.gbId || classGbMap[Object.keys(classGbMap)[0]];
  }

  const filesMatch = /sff\.sv\('\s*filesAdded\s*'\s*,\s*'([^']+)'\)/i.exec(html)
    || /javascript\.filesAdded['"]?\s*[:=]\s*['"]([^'"\s]+)['"]/i.exec(html);
  if (filesMatch && filesMatch[1]) {
    sky.javascriptFilesAdded = decodeURIComponent(filesMatch[1]).replace(/%2C/g, ',');
  }
}

// ---------------------------------------------------------------------------
// Parse: the gradebook overview -> term tabs, subtabs, per-class averages.
// ---------------------------------------------------------------------------
/** Collect the forest's leaf labels in the flat chronological `termList` order. */
function leafLabels(termTree, termList) {
  const leaves = new Set();
  const walk = (n) => {
    if (!n.children || n.children.length === 0) leaves.add(n.label);
    else n.children.forEach(walk);
  };
  (termTree || []).forEach(walk);
  return termList.filter((l) => leaves.has(l));
}

/** True if any class has a numeric posted average under `label`. */
function anyNumericAverage(classes, label) {
  return classes.some((c) => {
    const v = c.averages && c.averages[label];
    return v !== undefined && v !== null && v !== '' && !isNaN(parseFloat(v));
  });
}

/**
 * The current term = the finest (leaf) column still being graded. Future progress
 * periods are blank, so the last leaf with a posted grade in any class is the one
 * in progress. Falls back to the last leaf, then the last column, so there is
 * always a sensible default (e.g. over the summer, when every term is graded, the
 * most recent finest term is chosen rather than a coarse year/semester summary).
 */
function pickCurrentLeaf(termTree, termList, classes) {
  const leaves = leafLabels(termTree, termList);
  if (leaves.length === 0) return termList.length ? termList[termList.length - 1] : '';
  for (let i = leaves.length - 1; i >= 0; i--) {
    if (anyNumericAverage(classes, leaves[i])) return leaves[i];
  }
  return leaves[leaves.length - 1];
}

function parseGradebook(htmlContent) {
  const gm = /stuGradesGrid_(\d+)_\d+/.exec(htmlContent);
  const studentId = gm ? gm[1] : '';

  const { termList, termTree, cascade, hasSubterms } = extractTermHierarchy(htmlContent);

  const classNames = extractClassInfo(htmlContent, studentId || '\\d+');

  const gridPattern = new RegExp("'stuGradesGrid_" + (studentId || '\\d+') + "_\\d+':\\s*(\\{)", 'g');
  const matches = [...htmlContent.matchAll(gridPattern)];
  if (matches.length === 0) throw new Error('Could not find grid data in gradebook HTML');

  const classesData = [];
  let headers = [];

  for (const match of matches) {
    const startPos = match.index + match[0].length - 1;
    const endPos = findMatchingBrace(htmlContent, startPos);
    if (endPos === -1) continue;
    const jsonStr = htmlContent.substring(startPos, endPos + 1).replace(/,(\s*[}\]])/g, '$1');
    let gridData;
    try { gridData = JSON.parse(jsonStr); } catch (e) { continue; }

    headers = [];
    if (gridData.th && gridData.th.r && gridData.th.r[0] && gridData.th.r[0].c) {
      for (const col of gridData.th.r[0].c) {
        try {
          headers.push(cheerio.load(col.h || '').text().replace(/ |&nbsp;/g, '').trim());
        } catch (e) {
          headers.push(((col.h || '').match(/>([^<]+)</) || [])[1] || '');
        }
      }
    }
    if (headers.length > 0 && headers[0] === 'Class') headers.shift();

    if (gridData.tb && gridData.tb.r) {
      for (const row of gridData.tb.r) {
        const rowHtml = row.h || '';
        if (!rowHtml.includes('group-parent=') || !row.c) continue;
        const groupMatch = /group-parent="([^"]+)"/.exec(rowHtml);
        if (!groupMatch) continue;
        const groupId = groupMatch[1];
        const classId = row.c.length > 0 ? (row.c[0].cId || groupId) : groupId;

        const grades = [];
        const columnHasData = [];
        for (let j = 1; j < row.c.length; j++) {
          const cellHtml = row.c[j].h || '';
          if (cellHtml.toLowerCase().includes('not used')) {
            grades.push(null);
            columnHasData.push(false);
          } else {
            let grade = '';
            try {
              const $c = cheerio.load(cellHtml);
              grade = ($c('a').text() || $c('div').text() || $c.text() || '')
                .replace(/ |&nbsp;/g, '').trim();
            } catch (e) { grade = ''; }
            grades.push(grade);
            columnHasData.push(true);
          }
        }
        if (grades.length > 0) classesData.push({ classId, groupId, grades, columnHasData });
      }
    }
  }

  const selectedHeaders = headers.slice();
  for (const info of classesData) {
    if (info.grades.length < headers.length) {
      const pad = headers.length - info.grades.length;
      info.grades = info.grades.concat(Array(pad).fill(''));
      info.columnHasData = info.columnHasData.concat(Array(pad).fill(true));
    }
  }

  const grouped = new Map();
  for (const info of classesData) {
    const parts = info.groupId.split('_');
    const courseId = parts.length > 1 ? parts.slice(1).join('_') : info.classId;
    const meta = classNames[courseId] || { name: courseId, period: '?', teacher: '?' };
    if (!info.grades.some((g) => g !== null && g !== '')) continue;

    const averages = {};
    for (let i = 0; i < selectedHeaders.length; i++) {
      const header = (selectedHeaders[i] || '').replace(/ | /g, '').trim();
      if (!header) continue;
      if (i < info.columnHasData.length && info.columnHasData[i]) {
        const g = i < info.grades.length ? info.grades[i] : '';
        averages[header] = (g === null || g === undefined) ? '' : String(g).trim();
      }
    }

    // Skyward splits a full-year class into one grid row per semester, each with
    // its own course id (e.g. 376214 fall / 376215 spring). Merge those rows
    // (same name/period/teacher) into a single class, remembering which section
    // owns each term so the detail lookup can target the right one.
    const key = meta.name + '|' + meta.period + '|' + meta.teacher;
    let cls = grouped.get(key);
    if (!cls) {
      cls = {
        averageType: 'categorywise',
        course: courseId,
        name: meta.name,
        period: meta.period,
        teacher: meta.teacher,
        email: meta.email || '',
        averages: {},
        sections: [],
        termCourse: {},
      };
      grouped.set(key, cls);
    }
    if (!cls.sections.includes(courseId)) cls.sections.push(courseId);
    for (const [label, val] of Object.entries(averages)) {
      cls.averages[label] = val;
      cls.termCourse[label] = courseId;
    }
  }

  const classes = [...grouped.values()];
  // Skyward exposes no per-column dates, so we can't date-match "today" the way
  // PowerSchool does. But the current grading period is the finest (leaf) column
  // still being graded: future progress periods are blank, so the LAST leaf that
  // carries a posted grade in any class is the one in progress now. Picking that
  // leaf — not the last column overall, which is a coarse semester summary (SM2)
  // — makes the UI default to the bottom-most current term (e.g. PR6), and
  // `currentTerms` is its ancestor path (coarsest→finest, e.g. SM2 → 3RD → PR6),
  // so notifications can fire for every active level. Mirrors PowerSchool.
  // (The frequency cascade is still used internally to find leaves/ancestors;
  // the exported `termTree` is grouped by letter type.)
  const term = pickCurrentLeaf(cascade, termList, classes);
  const currentTerms = term ? pathToLabel(cascade, term) : [];
  return { hasSubterms, termList, termTree, term, currentTerms, classes };
}

// ---------------------------------------------------------------------------
// Fetch + parse one class's detailed assignment dialog for a given term.
// ---------------------------------------------------------------------------
async function fetchClassDetail(session, link, courseId, termHint, progressTracker) {
  progressTracker?.update?.(70, 'Fetching assignment details');
  const sky = skywardTokens(session);
  const [corNumId, track = '0', section = '0'] = String(courseId).split('_');
  const key = corNumId + '_' + track + '_' + section;

  const termMap = (sky.classTermMap && sky.classTermMap[key]) || {};
  const labels = Object.keys(termMap);
  let chosen = null;
  if (termHint) chosen = labels.find((l) => l.toUpperCase() === String(termHint).toUpperCase()) || null;
  if (!chosen && labels.length > 0) chosen = labels[labels.length - 1];
  const anchor = chosen ? termMap[chosen] : null;

  // Lazy body: re-read the token fields (sessionid/encses/dwd/wfaacl) from the
  // session on each send so a reauth retry uses the refreshed login. The anchor-
  // derived identifiers (stuId/gbId/bucket) are student-scoped and stable across
  // sessions, so capturing them once is fine.
  const makeBody = () => {
    const t = skywardTokens(session);
    return new URLSearchParams({
      action: 'viewGradeInfoDialog',
      gridCount: '1',
      fromHttp: 'yes',
      stuId: (anchor && anchor.sId) || t.studentId || '',
      entityId: (anchor && anchor.eId) || t.entityId || '',
      corNumId,
      track,
      section,
      gbId: (anchor && anchor.gbId) || (t.classGbMap && t.classGbMap[key]) || t.gbId || '',
      bucket: (anchor && anchor.bucket) || '',
      subjectId: '',
      dialogLevel: '1',
      isEoc: (anchor && anchor.isEoc) || 'no',
      ishttp: 'true',
      sessionid: sessionId(t),
      'javascript.filesAdded': t.javascriptFilesAdded ||
        'jquery.1.8.2.js,qsfmain001.css,sfgradebook.css,qsfmain001.min.js,sfgradebook.js,sfprint001.js',
      encses: t.encses || '',
      dwd: t.dwd || '',
      wfaacl: t.wfaacl || '',
      requestId: String(Date.now()),
    }).toString();
  };

  const res = await session.post(link + SKYWARD_ENDPOINTS.CLASS_DETAILS,
    makeBody,
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' } });

  progressTracker?.update?.(85, 'Parsing assignment details');
  const parsed = parseClassDetailsHtml(res.data);
  if (parsed) {
    parsed.term = (parsed.term && String(parsed.term).trim()) || chosen || termHint || '';
    parsed.requestedTerm = chosen || termHint || '';
  }
  return parsed;
}

// ===== ported parsers =====================================================

function findMatchingBrace(text, startPos) {
  /**
   * Find the matching closing brace for an opening brace
   */
  let count = 1;
  let pos = startPos + 1;
  let inString = false;
  let escape = false;

  while (pos < text.length && count > 0) {
    const char = text[pos];

    if (escape) {
      escape = false;
      pos++;
      continue;
    }

    if (char === '\\') {
      escape = true;
      pos++;
      continue;
    }

    if (char === '"') {
      inString = !inString;
    } else if (!inString) {
      if (char === '{') {
        count++;
      } else if (char === '}') {
        count--;
      }
    }

    pos++;
  }

  return count === 0 ? pos - 1 : -1;
}

function extractTermHierarchy(htmlContent) {
  /**
   * Reconstruct the term cascade from the gradebook's ordered columns.
   *
   * Skyward's grid gives no per-column dates, only the chronological run of
   * data-lit labels (PR1 PR2 1ST PR3 PR4 2ND SM1 …). We infer the nesting
   * data-drivenly: finer buckets recur more often across the year, so a column
   * whose label-family appears fewer times is coarser and adopts the run of
   * finer columns just before it (see core/termTree.js#nestByFrequency). That
   * yields arbitrary depth (PR → term → semester → year) with no hard-coded
   * term names, and the coarsest columns become the roots (the top tabs).
   */

  // Extract unique data columns in their exact visual order.
  const columnPattern = /data-bkt=['"]([^'"]+)['"]\s+data-lit=['"]([^'"]+)['"]/g;
  const orderedLabels = [];
  const seen = new Set();
  let match;

  while ((match = columnPattern.exec(htmlContent)) !== null) {
    const lit = match[2].trim();
    if (lit && !seen.has(lit)) {
      seen.add(lit);
      orderedLabels.push(lit);
    }
  }

  const cascade = nestByFrequency(orderedLabels);
  const termTree = groupByFamily(orderedLabels);
  const hasSubterms = forestHasChildren(termTree);

  // termList stays flat: every column, in chronological order. termTree groups
  // the columns by letter type (PR, 1ST/2ND…, SM) for the UI's tabs/subtabs.
  return { orderedLabels, termList: [...orderedLabels], termTree, cascade, hasSubterms };
}

function extractClassInfo(htmlContent, studentId = '272676') {
  /**
   * Extract class names and details from the HTML
   */
  const classMap = {};

  // Pattern: classDesc_STUDENTID_CLASSID_SEQ_SEC
  const pattern = new RegExp(`<table id="classDesc_${studentId}_([^"]+)">`, 'g');
  let match;

  while ((match = pattern.exec(htmlContent)) !== null) {
    const classIdFull = match[1];
    const classId = classIdFull.split('_')[0];

    const tableStart = match.index;
    const tableEnd = htmlContent.indexOf('</table>', tableStart);
    if (tableEnd === -1) continue;

    const tableHtml = htmlContent.substring(tableStart, tableEnd + 8);

    // Extract class name
    let classNameMatch = /<a[^>]*class=['"]bld classDesc['"][^>]*>([^<]+)<\/a>/.exec(tableHtml);
    if (!classNameMatch) {
      classNameMatch = /classDesc[^>]*>\s*<a[^>]*>([^<]+)<\/a>/.exec(tableHtml);
    }

    // Extract period
    const periodMatch = /<label[^>]*>Period<\/label>\s*(\d+)/.exec(tableHtml);

    // Extract teacher - look for aria-haspopup='dialog'
    let teacherMatch = /aria-haspopup=['"]dialog['"]>([^<]+)<\/a>\s*<\/td>\s*<\/tr>\s*<\/table>/.exec(tableHtml);
    if (!teacherMatch) {
      const matches = [...tableHtml.matchAll(/aria-haspopup=['"]dialog['"]>([^<]+)<\/a>/g)];
      if (matches.length > 0) {
        teacherMatch = matches[matches.length - 1];
      }
    }

    if (classNameMatch) {
      const className = classNameMatch[1].trim();
      const period = periodMatch ? periodMatch[1] : "?";
      const teacher = teacherMatch ? teacherMatch[1].trim() : "?";

      classMap[classIdFull] = {
        name: className,
        period: period,
        teacher: teacher,
        full: `${className}\nPeriod ${period}\n${teacher}`
      };
    }
  }

  return classMap;
}

function parseClassDetailsHtml(html) {
  /**
   * Parse individual class details HTML with all assignments and category breakdowns
   * Response is XML-wrapped with HTML in CDATA tags - extract that first
   */
  
  // Extract CDATA content if wrapped in XML. Try several containers and prefer
  // the CDATA block that contains the assignment table id.
  let actualHtml = html || '';
  const cdataBlocks = [];
  const cdataRe = /<!\[CDATA\[([\s\S]*?)\]\]>/g;
  let cm;
  while ((cm = cdataRe.exec(html)) !== null) {
    cdataBlocks.push(cm[1]);
  }

  // Prefer CDATA that contains known table id or keywords
  const preferred = cdataBlocks.find(b => /stuAssignmentSummaryGrid|assignmentSummaryGrid|sf_Section|grid_stuAssignmentSummaryGrid/i.test(b));
  if (preferred) {
    actualHtml = preferred;
  } else if (cdataBlocks.length > 0) {
    // fall back to data or output CDATA order: output, data, sff
    const outputMatch = /<output>\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*<\/output>/.exec(html);
    const dataMatch = /<data>\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*<\/data>/.exec(html);
    const sffMatch = /<sff>\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*<\/sff>/.exec(html);
    if (outputMatch && outputMatch[1] && outputMatch[1].trim().length > 0) actualHtml = outputMatch[1];
    else if (dataMatch && dataMatch[1] && dataMatch[1].trim().length > 0) actualHtml = dataMatch[1];
    else if (sffMatch && sffMatch[1] && sffMatch[1].trim().length > 0) actualHtml = sffMatch[1];
    else actualHtml = cdataBlocks[0];
  }

  console.log('parseClassDetailsHtml: cdataBlocks=', cdataBlocks.length, 'chosenLength=', actualHtml ? actualHtml.length : 0);

  const $ = cheerio.load(actualHtml);
  
  const result = {
    success: true,
    scoresIncluded: true,
    termList: [],
    term: '',
    multipleGroups: false,
    class: {
      averageType: 'categorywise',
      course: '',
      name: '',
      period: '',
      teacher: '',
      room: '',
      average: '',
      scores: [],
      categories: {},
      groups: {}
    }
  };

  // Multi-group tracking (for SM format)
  const groups = {}; // { 'groupName': { weight, grade, single, categories, scores } }
  const groupCategoryOrder = {}; // { 'groupName': ['Cat1', 'Cat2', ...] } - order in which categories appear
  const groupCategoryIndex = {}; // { 'groupName': 0 } - current index in category order
  let currentGroup = null;
  let currentComponent = null;  // Track component name (Application Grade, Major Grade, Minor Grade) for three-level hierarchy
  let currentCategory = null;
  let currentCategoryMaxPoints = 0;
  let currentCategoryEarnedPoints = 0;

  // Helper: detect term-like labels (e.g., '1ST', '2ND', 'SM1', 'PR1', 'CZ1')
  function isTermLabel(name) {
    if (!name) return false;
    const n = String(name).trim().toUpperCase();
    if (/^SM\d+$/.test(n)) return true;
    if (/^(?:\d+(?:ST|ND|RD|TH)|1ST|2ND|3RD|4TH|TERM\s*\d?)$/i.test(n)) return true;
    if (/^PR\d+|CZ\d+|EX\d+/i.test(n)) return true;
    if (n.length <= 3 && /\d/.test(n)) return true;
    return false;
  }

  // Normalize category names by removing leading/trailing term tokens
  function normalizeCategoryLabel(name) {
    if (!name) return '';
    let s = String(name).trim();
    // remove common term tokens at start or end (SM1, SM2, 1ST, 2ND, PR1, EX1, TERM 12, etc.)
    s = s.replace(/^(SM\s*\d+|SM\d+|SEM\s*\d+|TERM\s*\d+|\d+(?:ST|ND|RD|TH)|PR\d+|EX\d+)\s*/i, '');
    s = s.replace(/\s*(SM\s*\d+|SM\d+|SEM\s*\d+|TERM\s*\d+|\d+(?:ST|ND|RD|TH)|PR\d+|EX\d+)$/i, '');
    return s.trim();
  }

  // Helper: advance to next category in group when earned points threshold is exceeded
  function advanceGroupCategory(group, earnedPts) {
    if (!groupCategoryOrder[group] || groupCategoryOrder[group].length === 0) return;
    const idx = groupCategoryIndex[group] || 0;
    if (idx + 1 >= groupCategoryOrder[group].length) return; // already at last category
    
    const catList = groupCategoryOrder[group];
    const nextCat = catList[idx + 1];
    if (nextCat && groups[group].categories[nextCat]) {
      groupCategoryIndex[group] = idx + 1;
      currentCategory = nextCat;
      currentCategoryMaxPoints = parseFloat(groups[group].categories[nextCat].maximumPoints) || 0;
      currentCategoryEarnedPoints = 0;
      console.log('parseClassDetailsHtml: advanced to next category in group=', group, 'nextCat=', nextCat, 'maxPts=', currentCategoryMaxPoints);
    }
  }

  try {
    // Extract class name from header - look for h2 with class name and period
    const classHeader = $('h2.gb_heading').first();
    if (classHeader.length > 0) {
      const headerText = classHeader.text().trim();
      // Extract: CLASS NAME (Period #) Teacher
      const classMatch = /^([^(]+)\s*\(\s*Period\s+(\d+)\s*\)/.exec(headerText);
      if (classMatch) {
        result.class.name = classMatch[1].trim();
        result.class.period = classMatch[2];
      }
      
      // Extract teacher - look for second link in header
      const teacherLink = classHeader.find('a').eq(1);
      if (teacherLink.length > 0) {
        result.class.teacher = teacherLink.text().trim();
      }
    }

    // Extract student info / term from summary section
    const summaryHeader = $('th:contains("Grade")').first();
    if (summaryHeader.length > 0) {
      const termText = summaryHeader.text().trim();
      // Format: "4TH Grade\n(03/16/2026 - 05/22/2026)"
      const termMatch = /^(\d+\w+|[A-Z]+\d*)\s+Grade/i.exec(termText);
      if (termMatch) {
        result.term = termMatch[1];
        result.termList = ['1', '2', '3', '4', '5', '6']; // Default terms
      }
    }

    // If we didn't detect a term from the summary header, try heuristics on the raw HTML
    if (!result.term || result.term.trim().length === 0) {
      // Look for common term tokens near the word 'Grade' or in data-lit/data-bkt attributes
      const termTokenRe = /\b(SM\s*\d|SM\d|SEM\s*\d|TERM\s*\d|\d+(?:ST|ND|RD|TH)|EX\d+|PR\d+)\b/gi;
      const nearGradeMatch = new RegExp('Grade[^<]{0,50}(' + '(SM\\s*\\d|SM\\d|SEM\\s*\\d|TERM\\s*\\d|\\d+(?:ST|ND|RD|TH)|EX\\d+|PR\\d+)' + ')', 'i');
      let m = null;
      // try near 'Grade' first
      const gradeIdx = actualHtml.search(/Grade/i);
      if (gradeIdx >= 0) {
        const snippet = actualHtml.substring(Math.max(0, gradeIdx - 200), gradeIdx + 200);
        m = termTokenRe.exec(snippet);
      }
      // fallback: global search for data-lit tokens or token regex
      if (!m) {
        m = termTokenRe.exec(actualHtml);
      }
      if (m && m[1]) {
        result.term = m[1].replace(/\s+/g, '').toUpperCase();
        console.log('parseClassDetailsHtml: heuristically detected term=', result.term);
      }
    }

    // Extract overall average
    const avgCell = summaryHeader.closest('tr').next('tr').find('span.vAm').first();
    if (avgCell.length > 0) {
      result.class.average = avgCell.text().trim();
    }

    // Parse Grade Breakdown to detect multi-group format and extract group grades
    // Look for rows like: "4TH:93(43% of Sem 2 grade)" OR links with data-lit attributes in Grade Breakdown
    const gradeBreakdownText = $('label:contains("Grade Breakdown"), h2:contains("Grade Breakdown")').closest('table').text() || '';
    const gradeBreakdownRows = $('tr').filter((i, tr) => {
      const t = $(tr).text() || '';
      return /^\s*[A-Z0-9]+:\s*\d+/i.test(t) && /%\s*of\s*(Sem|Term)/i.test(t);
    });
    
    if (gradeBreakdownRows.length > 1) {
      result.multipleGroups = true;
      gradeBreakdownRows.each((i, row) => {
        const $row = $(row);
        const text = $row.text().replace(/\s+/g, ' ').trim();
        const match = /^([A-Z0-9]+)\s*[:\-]\s*(\d+(?:\.\d+)?)\s*\(([^)]*?(\d+(?:\.\d+)?)\s*%[^)]*?)\)/i.exec(text);
        if (match) {
          const groupName = match[1];
          const groupGrade = match[2];
          const weightText = match[3];
          const weightMatch = /(\d+(?:\.\d+)?)\s*%/i.exec(weightText);
          const weight = weightMatch ? weightMatch[1] : '0';
          groups[groupName] = {
            weight: weight,
            grade: groupGrade,
            single: false,
            categories: {},
            scores: []
          };
          console.log('parseClassDetailsHtml: detected group=', groupName, 'grade=', groupGrade, 'weight=', weight);
        }
      });
    }
    
    // Also detect multi-group from Grade Breakdown links with data attributes (Term 3/6 format)
    if (!result.multipleGroups) {
      const gradeBreakdownLinks = $('a[data-lit]').filter((i, link) => {
        return /EX\d+|1ST|2ND|3RD|4TH|SM\d+/i.test($(link).attr('data-lit'));
      });
      if (gradeBreakdownLinks.length > 1) {
        result.multipleGroups = true;
        gradeBreakdownLinks.each((i, link) => {
          const $link = $(link);
          const groupName = $link.attr('data-lit') || '';
          const groupGrade = $link.closest('td').find('font-weight:bold').text() || $link.next().text() || '0';
          const weightText = $link.closest('td').text() || '';
          const weightMatch = /(\d+(?:\.\d+)?)\s*%/i.exec(weightText);
          const weight = weightMatch ? weightMatch[1] : '0';
          if (groupName && !groups[groupName]) {
            groups[groupName] = {
              weight: weight,
              grade: groupGrade.replace(/[^\d.]/g, '') || '0',
              single: false,
              categories: {},
              scores: []
            };
            console.log('parseClassDetailsHtml: detected group from data-lit=', groupName, 'weight=', weight);
          }
        });
      }
    }

    // Parse categories and assignments
    let assignmentTable = $('table[id*="stuAssignmentSummaryGrid"]').first();
    if (!assignmentTable || assignmentTable.length === 0) {
      // Try other common ids/names
      assignmentTable = $('table[id*="assignmentSummaryGrid"]').first();
    }
    if (!assignmentTable || assignmentTable.length === 0) {
      assignmentTable = $('table[id*="grid_stuAssignmentSummaryGrid"]').first();
    }
    // If still not found, find any table that contains an assignment anchor or category rows
    if (!assignmentTable || assignmentTable.length === 0) {
      const anchor = $('a[id^="showAssignmentInfo"], a#showAssignmentInfo, a[href*="showAssignmentInfo"]').first();
      if (anchor && anchor.length) {
        assignmentTable = $(anchor).closest('table');
      }
    }
    if (!assignmentTable || assignmentTable.length === 0) {
      assignmentTable = $('table').filter((i, t) => {
        const $t = $(t);
        return $t.find('tr.cat').length > 0 || /assignment|assignment summary|stuAssignmentSummaryGrid/i.test($t.text());
      }).first();
    }
    console.log('parseClassDetailsHtml: assignmentTable found=', assignmentTable && assignmentTable.length ? assignmentTable.length : 0);
    // If the selected table is empty/placeholder, try to find a better candidate
    if (assignmentTable && assignmentTable.length > 0) {
      const rowsCount = assignmentTable.find('tr').length;
      const text = (assignmentTable.text() || '').toLowerCase();
      if (rowsCount <= 2 || /no assignments|there are no missing assignments|no results/i.test(text)) {
        let best = null;
        $('table').each((i, t) => {
          const $t = $(t);
          const anchors = $t.find('a[id^="showAssignmentInfo"], a#showAssignmentInfo').length;
          const rcount = $t.find('tr').length;
          if (anchors > 0) { best = $t; return false; }
          if (!best || rcount > best.find('tr').length) best = $t;
        });
        if (best && best.length && best.find('tr').length > rowsCount) {
          assignmentTable = best;
          console.log('parseClassDetailsHtml: switched to better assignmentTable rows=', assignmentTable.find('tr').length);
        }
      }
    }
    if (assignmentTable.length > 0) {
      const allRows = assignmentTable.find('tr');
      console.log('parseClassDetailsHtml: assignment rows count=', allRows.length);
      let currentCategory = '';
      let categoryData = {};

      // Determine columns by header row if present, otherwise fallback to sampling
      let dueIdx = 0, nameIdx = 2, gradeIdx = 3, pointsIdx = 4;
      const headerRow = assignmentTable.find('thead tr').first().length ? assignmentTable.find('thead tr').first() : assignmentTable.find('tr').filter((i, r) => /due|assignment|grade|points|category/i.test($(r).text())).first();
      if (headerRow && headerRow.length) {
        $(headerRow).find('th,td').each((i, c) => {
          const txt = ($(c).text() || '').toLowerCase();
          if (/due/.test(txt) && dueIdx === 0) dueIdx = i;
          if (/assign|assignment|activity|title|name/.test(txt)) nameIdx = i;
          if (/grade|percent|%/.test(txt)) gradeIdx = i;
          if (/point|out of|pts|score/.test(txt)) pointsIdx = i;
        });
      } else {
        const sampleRow = assignmentTable.find('tr').filter((i, r) => !$(r).hasClass('cat')).first();
        if (sampleRow && sampleRow.length) {
          const sampleCells = $(sampleRow).find('td');
          sampleCells.each((i, c) => {
            const txt = $(c).text() || '';
            const hasAnchor = $(c).find('a#showAssignmentInfo, a[id^="showAssignmentInfo"]').length > 0;
            if (hasAnchor) { nameIdx = i; return; }
            if (/\d{1,2}\/\d{1,2}\/\d{2,4}/.test(txt) && dueIdx === 0) dueIdx = i;
            if (/out of|\//i.test(txt) || /\d+\s+out of/i.test(txt)) pointsIdx = i;
            if (/[%]|\d+\s*%|^[A-Z]$/.test(txt) || (/^\d{1,3}$/.test(txt.trim()) && txt.trim().length <= 3 && i !== nameIdx)) {
              gradeIdx = i;
            }
          });
        }
      }
      console.log('parseClassDetailsHtml: column indices dueIdx=', dueIdx,'nameIdx=',nameIdx,'gradeIdx=',gradeIdx,'pointsIdx=',pointsIdx);

      $('tr', assignmentTable).each((idx, row) => {
        const $row = $(row);
        const isCategory = $row.hasClass('cat');

        if (isCategory) {
          const categoryCell = $row.find('td').eq(1);
          const cellStyle = categoryCell.attr('style') || '';
          const isBoldRow = /font-weight\s*:\s*bold/i.test(cellStyle);

          const categoryText = categoryCell.text().replace(/\s+/g, ' ').trim();
          const rawName = categoryText;

          // Clean name: remove "weighted at X%", parentheses, and punctuation, but KEEP "Grade"
          const cleanedName = rawName
            .replace(/\s*weighted at.*$/i, '')  // Remove "weighted at X%"
            .replace(/\(.*?\)/g, '')             // Remove content in parentheses
            .replace(/[:;,\-()]/g, '')           // Remove colons, semicolons, commas, dashes, parentheses
            .trim();

          // If this is a bold row, it's a main component name (Application Grade, Major Grade, Minor Grade)
          // Store it but don't create a group - it's only a component marker
          if (isBoldRow && result.multipleGroups) {
            currentComponent = cleanedName;
            console.log('parseClassDetailsHtml: multi-group component marker=', currentComponent);
            return;
          }

          // If normal weight row in multi-group: it's a term-specific category for the current component
          if (result.multipleGroups && currentComponent) {
            // Extract the term name (should be like "2ND", "1ST", "EX1")
            const termMatch = /^([A-Z0-9]+)/.exec(cleanedName);
            const termName = termMatch ? termMatch[1] : cleanedName;

            // Make sure this term group exists
            if (!groups[termName]) {
              groups[termName] = { weight: '0', grade: '', single: false, categories: {}, scores: [] };
            }

            // Extract weight and points...
            let weight = 0;
            const wMatch = /weighted at\s*([\d.]+)\%/i.exec(categoryText) || /\((?:.*?([\d.]+)\%).*?\)/.exec(categoryText);
            if (wMatch && wMatch[1]) weight = parseFloat(wMatch[1]);

            // For category rows with colspan, search all cells for points format
            let studentsPoints = '0';
            let maximumPoints = '0';
            let percentStr = '0%';
            let pointsFound = false;

            $row.find('td').each((idx, cell) => {
              const cellText = $(cell).text().trim();
              // Look for points format "XXX out of YYY"
              if (!pointsFound && /\d+(?:\.\d+)?\s*(?:out of|of)\s*\d+(?:\.\d+)?/.test(cellText)) {
                let pointsMatch = /^(\d+(?:\.\d+)?)\s*(?:out of|of)\s*(\d+(?:\.\d+)?)/i.exec(cellText);
                if (!pointsMatch) pointsMatch = /^(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)/.exec(cellText);

                if (pointsMatch) {
                  const sp = parseFloat(pointsMatch[1]);
                  const mp = parseFloat(pointsMatch[2]);
                  studentsPoints = (!isNaN(sp) ? sp.toFixed(4) : '0');
                  maximumPoints = (!isNaN(mp) ? mp.toFixed(2) : '0');
                  const pctVal = (mp && !isNaN(sp) ? (sp / mp) * 100 : NaN);
                  if (!isNaN(pctVal)) percentStr = pctVal.toFixed(3) + '%';
                  pointsFound = true;
                }
              }
            });

            // Fallback: try extracting percentage
            if (!pointsFound) {
              const pctSearchText = categoryText.replace(/weighted at\s*[\d.]+\%/i, '');
              const pctMatch = /([0-9]+(?:\.[0-9]+)?)\s*%/.exec(pctSearchText);
              if (pctMatch) percentStr = parseFloat(pctMatch[1]).toFixed(3) + '%';
            }

            const percentNum = parseFloat(percentStr.replace('%', '')) || 0;
            const categoryPointsVal = (percentNum / 100) * weight;

            // Category key: use component name without term tokens (e.g., "Application Grade")
            const categoryNameKey = normalizeCategoryLabel(currentComponent) || 'Other';
            const catData = {
              studentsPoints: studentsPoints,
              maximumPoints: maximumPoints,
              percent: percentStr,
              categoryWeight: weight.toFixed(2),
              categoryPoints: categoryPointsVal.toFixed(6)
            };

            groups[termName].categories[categoryNameKey] = catData;
            currentCategory = categoryNameKey;
            currentCategoryMaxPoints = parseFloat(maximumPoints) || 0;
            currentCategoryEarnedPoints = 0;
            currentGroup = termName;

            console.log('parseClassDetailsHtml: term category=', termName, categoryNameKey, 'weight=', weight);
            return;
          }

          // Extract weight for non-component categories
          let weight = 0;
          const wMatch2 = /weighted at\s*([\d.]+)\%/i.exec(categoryText) || /\((?:.*?([\d.]+)\%).*?\)/.exec(categoryText);
          if (wMatch2 && wMatch2[1]) weight = parseFloat(wMatch2[1]);

          // For category rows with colspan, search all cells for points format
          let studentsPoints = '0';
          let maximumPoints = '0';
          let percentStr = '0%';
          let pointsFound = false;

          $row.find('td').each((idx, cell) => {
            const cellText = $(cell).text().trim();
            if (!pointsFound && /\d+(?:\.\d+)?\s*(?:out of|of)\s*\d+(?:\.\d+)?/.test(cellText)) {
              let pointsMatch = /^(\d+(?:\.\d+)?)\s*(?:out of|of)\s*(\d+(?:\.\d+)?)/i.exec(cellText);
              if (!pointsMatch) pointsMatch = /^(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)/.exec(cellText);
              if (pointsMatch) {
                const sp = parseFloat(pointsMatch[1]);
                const mp = parseFloat(pointsMatch[2]);
                studentsPoints = (!isNaN(sp) ? sp.toFixed(4) : '0');
                maximumPoints = (!isNaN(mp) ? mp.toFixed(2) : '0');
                const pctVal = (mp && !isNaN(sp) ? (sp / mp) * 100 : NaN);
                if (!isNaN(pctVal)) percentStr = pctVal.toFixed(3) + '%';
                pointsFound = true;
              }
            }
          });

          // Fallback: try extracting percentage
          if (!pointsFound) {
            const pctSearchText = categoryText.replace(/weighted at\s*[\d.]+\%/i, '');
            const pctMatch = /([0-9]+(?:\.[0-9]+)?)\s*%/.exec(pctSearchText);
            if (pctMatch) percentStr = parseFloat(pctMatch[1]).toFixed(3) + '%';
          }

          // Compute categoryPoints = (percent / 100) * weight
          const percentNum2 = parseFloat(percentStr.replace('%', '')) || 0;
          const categoryPointsVal2 = (percentNum2 / 100) * weight;

          const finalCategoryName = normalizeCategoryLabel(cleanedName) || 'Other';
          const catData2 = {
            studentsPoints: studentsPoints,
            maximumPoints: maximumPoints,
            percent: percentStr,
            categoryWeight: weight.toFixed(2),
            categoryPoints: categoryPointsVal2.toFixed(6)
          };

          if (result.multipleGroups && currentGroup) {
            // Store as subcategory within the current group
            currentCategory = finalCategoryName;
            currentCategoryMaxPoints = parseFloat(maximumPoints) || 0;
            currentCategoryEarnedPoints = 0;
            groups[currentGroup].categories[currentCategory] = catData2;

            // Track category order for sequential assignment
            if (!groupCategoryOrder[currentGroup]) {
              groupCategoryOrder[currentGroup] = [];
              groupCategoryIndex[currentGroup] = 0;
            }
            if (!groupCategoryOrder[currentGroup].includes(currentCategory)) {
              groupCategoryOrder[currentGroup].push(currentCategory);
              groupCategoryIndex[currentGroup] = groupCategoryOrder[currentGroup].length - 1;
            }
            console.log('parseClassDetailsHtml: group subcategory=', currentGroup, finalCategoryName, 'weight=', weight);
          } else {
            categoryData[finalCategoryName] = catData2;
            currentCategory = finalCategoryName;
            result.class.categories[currentCategory] = categoryData[currentCategory];
            console.log('parseClassDetailsHtml: found category=', currentCategory, 'weight=', weight, 'studentsPoints=', categoryData[currentCategory].studentsPoints);
          }
        } else {
          const cells = $row.find('td');
          const dueText = (cells.eq(dueIdx).text() || '').trim();
          const nameText = (cells.eq(nameIdx).find('a').text() || cells.eq(nameIdx).text() || '').trim();
          const gradeText = (cells.eq(gradeIdx).text() || '').trim();
          const pointsText = (cells.eq(pointsIdx).text() || '').trim();
          let pointsMatch = /([\d.]+)\s*(?:out of|of)\s*([\d.]+)/i.exec(pointsText);
          if (!pointsMatch) pointsMatch = /([\d.]+)\s*\/\s*([\d.]+)/.exec(pointsText);
          let score = pointsMatch ? parseFloat(pointsMatch[1]) : NaN;
          let totalPoints = pointsMatch && pointsMatch[2] ? parseFloat(pointsMatch[2]) : NaN;
          const gradeNumeric = parseFloat((gradeText || '').replace(/[^0-9.]/g, ''));
          if (isNaN(score) && !isNaN(gradeNumeric)) { score = gradeNumeric; totalPoints = 100; }
          const percentage = (!isNaN(gradeNumeric) ? gradeNumeric.toFixed(2) : (gradeText || '')).toString();
          if (nameText) {
            const assignCategory = (currentCategory && !isTermLabel(currentCategory)) ? currentCategory : 'Other';
            const assignObj = {
              name: nameText,
              category: assignCategory,
              percentage: percentage,
              score: isNaN(score) ? 0 : score,
              totalPoints: isNaN(totalPoints) ? 100 : totalPoints,
              weight: 1,
              weightedScore: isNaN(score) ? 0 : score,
              weightedTotalPoints: isNaN(totalPoints) ? 0 : totalPoints,
              dateDue: dueText,
              dateAssigned: '',
              badges: []
            };
            try {
              const isNoCount = $row.find('img[alt*="No count"], img[title*="No count"]').length > 0
                || $row.find('.aCt').length > 0
                || /no count/i.test($row.text());
              if (isNoCount) assignObj.badges.push('dropped');
            } catch (e) { /* ignore */ }
            if (result.multipleGroups && currentGroup) {
              groups[currentGroup].scores.push(assignObj);
              currentCategoryEarnedPoints += (isNaN(score) ? 0 : score);
              
              // Check if we should advance to the next category in sequential assignment
              if (currentCategoryMaxPoints > 0 && currentCategoryEarnedPoints >= currentCategoryMaxPoints) {
                advanceGroupCategory(currentGroup, currentCategoryEarnedPoints);
              }
              console.log('parseClassDetailsHtml: group assignment=', currentGroup, nameText, 'pts=', isNaN(score) ? 0 : score, 'cumulative=', currentCategoryEarnedPoints, 'max=', currentCategoryMaxPoints);
            } else {
              result.class.scores.push(assignObj);
              console.log('parseClassDetailsHtml: added assignment=', nameText, 'category=', currentCategory, 'grade=', gradeText, 'points=', pointsText);
            }
          }
        }
      });
    }

    // Fallback: if no assignments were parsed from the primary table, try scanning anchors/rows
    if (result.class.scores.length === 0) {
      try {
        const anchors = $('a[id^="showAssignmentInfo"], a[id*="showAssignmentInfo"], a[aria-haspopup="dialog"], a').filter((i, a) => {
          const t = $(a).text() || '';
          return t.trim().length > 0 && /assignment|quiz|exam|hw|homework|lab|project|presentation|test/i.test(t + ' ' + $(a).closest('tr').text());
        });
        if (anchors && anchors.length > 0) {
          console.log('parseClassDetailsHtml: fallback anchors count=', anchors.length);
          // determine indices by sampling first anchor row
          let fDue = 0, fName = 0, fGrade = 0, fPoints = 0;
          const firstRow = $(anchors[0]).closest('tr');
          const fCells = firstRow.find('td');
          fCells.each((i, c) => {
            const txt = ($(c).text() || '').trim();
            if ($(c).find('a').length > 0) fName = i;
            if (/\d{1,2}\/\d{1,2}\/\d{2,4}/.test(txt) && fDue === 0) fDue = i;
            if (/out of|\//i.test(txt) || /pts|point/i.test(txt)) fPoints = i;
            if (/[%]|\d+\s*%|^[A-Z]$/.test(txt) || (/^\d{1,3}$/.test(txt.trim()) && txt.trim().length <= 3 && i !== fName)) fGrade = i;
          });

          anchors.each((i, a) => {
            const $a = $(a);
            const $r = $a.closest('tr');
            if (!$r || !$r.length) return;
            const $cells = $r.find('td');
            const nameText = ($a.text() || $cells.eq(fName).text() || '').trim();
            if (!nameText) return;
            const dueText = ($cells.eq(fDue).text() || '').trim();
            const gradeText = ($cells.eq(fGrade).text() || '').trim();
            const pointsText = ($cells.eq(fPoints).text() || '').trim();

            let ptsMatch = /([\d.]+)\s*(?:out of|of)\s*([\d.]+)/i.exec(pointsText);
            if (!ptsMatch) ptsMatch = /([\d.]+)\s*\/\s*([\d.]+)/.exec(pointsText);
            let sc = ptsMatch ? parseFloat(ptsMatch[1]) : NaN;
            let tp = ptsMatch && ptsMatch[2] ? parseFloat(ptsMatch[2]) : NaN;
            const gn = parseFloat((gradeText || '').replace(/[^0-9.]/g, ''));
            if (isNaN(sc) && !isNaN(gn)) { sc = gn; tp = 100; }
            const pct = !isNaN(gn) ? gn.toFixed(2) : (gradeText || '').trim();

            result.class.scores.push({
              name: nameText,
              category: currentCategory || 'Other',
              percentage: (!isNaN(gn) ? gn.toFixed(2) : (gradeText || '')).toString(),
              score: isNaN(sc) ? 0 : sc,
              totalPoints: isNaN(tp) ? 100 : tp,
              weight: 1,
              weightedScore: isNaN(sc) ? 0 : sc,
              weightedTotalPoints: isNaN(tp) ? 0 : tp,
              dateDue: dueText,
              dateAssigned: '',
              badges: []
            });
            try {
              const arr = result.class.scores;
              if (arr && arr.length) {
                const last = arr[arr.length-1];
                const isNoCount = $r.find('img[alt*="No count"], img[title*="No count"]').length > 0
                  || $r.find('.aCt').length > 0
                  || /no count/i.test($r.text());
                if (isNoCount) last.badges.push('dropped');
              }
            } catch (e) { /* ignore */ }
            console.log('parseClassDetailsHtml: fallback added assignment=', nameText, 'grade=', gradeText, 'points=', pointsText);
          });
        }
      } catch (e) {
        console.warn('Fallback anchor parsing failed:', e && e.message);
      }
    }

    // Additional fallback: scan any table rows that look like assignments (contain % or 'out of')
    if (result.class.scores.length === 0) {
      try {
        const candidateRows = $('tr').filter((i, r) => {
          const txt = ($(r).text() || '').toLowerCase();
          return (/%|out of|\bpts\b|\d+\s*\/\s*\d+/.test(txt)) && !/category|weighted at|no assignments|missing assignments/i.test(txt);
        });
        console.log('parseClassDetailsHtml: candidateRows for fallback=', candidateRows.length);
        candidateRows.each((i, r) => {
          try {
            const $r = $(r);
            const cells = $r.find('td');
            if (!cells || cells.length === 0) return;
            // pick name cell: first cell with an anchor or non-empty text
            let nameIdx = 0;
            cells.each((ci, c) => {
              if ($(c).find('a').length > 0 || /[A-Za-z]{2,}/.test($(c).text() || '')) { nameIdx = ci; return false; }
            });
            const nameText = ($(cells.eq(nameIdx).find('a').text() || cells.eq(nameIdx).text()) || '').trim();
            if (!nameText) return;
            // find grade and points
            let gradeVal = '';
            let pointsText = '';
            cells.each((ci, c) => {
              const t = ($(c).text() || '').trim();
              if (!gradeVal && /\d+\.?\d*\s*%/.test(t)) gradeVal = t;
              if (!pointsText && /(out of|\d+\s*\/\s*\d+|pts|point)/i.test(t)) pointsText = t;
            });
            const gn = parseFloat((gradeVal || '').replace(/[^0-9.]/g, ''));
            let ptsMatch = /([\d.]+)\s*(?:out of|of)\s*([\d.]+)/i.exec(pointsText);
            if (!ptsMatch) ptsMatch = /([\d.]+)\s*\/\s*([\d.]+)/.exec(pointsText);
            let sc = ptsMatch ? parseFloat(ptsMatch[1]) : NaN;
            let tp = ptsMatch && ptsMatch[2] ? parseFloat(ptsMatch[2]) : NaN;
            if (isNaN(sc) && !isNaN(gn)) { sc = gn; tp = 100; }

            result.class.scores.push({
              name: nameText,
              category: currentCategory || 'Other',
              percentage: !isNaN(gn) ? gn.toFixed(2) : (gradeVal || '').trim(),
              score: isNaN(sc) ? 0 : sc,
              totalPoints: isNaN(tp) ? 100 : tp,
              weight: 1,
              weightedScore: isNaN(sc) ? 0 : sc,
              weightedTotalPoints: isNaN(tp) ? 0 : tp,
              dateDue: '',
              dateAssigned: '',
              badges: [],
            });
            try {
              const $last = $('tr').filter((i, rr) => $(rr).text().includes(nameText)).first();
              const isNoCount = $last.find('img[alt*="No count"], img[title*="No count"]').length > 0
                || $last.find('.aCt').length > 0
                || /no count/i.test($last.text());
              if (isNoCount) {
                const arr = result.class.scores;
                if (arr && arr.length) arr[arr.length-1].badges.push('dropped');
              }
            } catch (e) { /* ignore */ }
            console.log('parseClassDetailsHtml: row-fallback added assignment=', nameText, 'grade=', gradeVal, 'points=', pointsText);
          } catch (e) { /* ignore per-row errors */ }
        });
      } catch (e) {
        console.warn('Row-scan fallback failed:', e && e.message);
      }
    }

    // After parsing assignments, ensure categories are aggregated from scores as a reliable fallback
    try {
      const aggregates = {};
      for (const s of result.class.scores) {
        const cat = s.category || 'Other';
        if (!aggregates[cat]) aggregates[cat] = { studentsPoints: 0, maximumPoints: 0 };
        aggregates[cat].studentsPoints += Number(s.score) || 0;
        aggregates[cat].maximumPoints += Number(s.totalPoints) || 0;
      }

      for (const catName of Object.keys(aggregates)) {
        const sp = aggregates[catName].studentsPoints;
        const mp = aggregates[catName].maximumPoints;
        const pct = mp > 0 ? (sp / mp) * 100 : 0;
        // prefer previously parsed category weight if present
        let weight = 0;
        if (result.class.categories && result.class.categories[catName] && result.class.categories[catName].categoryWeight) {
          weight = parseFloat(String(result.class.categories[catName].categoryWeight).replace(/[^0-9.\-]/g, '')) || 0;
        }
        // format values
        const studentsPointsStr = sp.toFixed(4);
        const maximumPointsStr = mp.toFixed(2);
        const percentStr = pct.toFixed(3) + '%';
        const categoryWeightStr = weight ? weight.toFixed(2) : '0.00';
        const categoryPointsStr = ((pct / 100) * (weight || 0)).toFixed(6);

        result.class.categories = result.class.categories || {};
        result.class.categories[catName] = {
          studentsPoints: studentsPointsStr,
          maximumPoints: maximumPointsStr,
          percent: percentStr,
          categoryWeight: categoryWeightStr,
          categoryPoints: categoryPointsStr
        };
      }
    } catch (e) {
      console.warn('Category aggregation failed:', e && e.message);
    }

    // If we didn't get any scores, try alternative parsing
      // Recompute category aggregates from parsed assignments to avoid reliance on inconsistent
      // category summary cells. Sum studentsPoints and maximumPoints from assignments per category.
      try {
        const agg = {};
        for (const a of result.class.scores) {
          const cat = a.category || 'Other';
          if (!agg[cat]) agg[cat] = { students: 0, max: 0 };
          const s = Number(a.score) || 0;
          const m = Number(a.totalPoints) || 0;
          agg[cat].students += s;
          agg[cat].max += m;
        }

        // Ensure all categories from parsing exist in result.class.categories
        for (const catName of Object.keys(agg)) {
          const sums = agg[catName];
          const studentsPoints = sums.students.toFixed(4);
          const maximumPoints = sums.max.toFixed(2);
          let percentStr = '0.000%';
          const pctVal = (sums.max > 0) ? (sums.students / sums.max) * 100 : 0;
          if (sums.max > 0) percentStr = pctVal.toFixed(3) + '%';

          // Preserve any existing category weight if present; otherwise default to 0.00
          const existing = result.class.categories[catName] || {};
          const weight = parseFloat(existing.categoryWeight) || 0;
          const categoryPoints = (pctVal / 100) * weight;

          result.class.categories[catName] = {
            studentsPoints: studentsPoints,
            maximumPoints: maximumPoints,
            percent: percentStr,
            categoryWeight: weight.toFixed(2),
            categoryPoints: categoryPoints.toFixed(6)
          };
        }

        if (result.class.scores.length === 0) {
          console.warn('No assignments found in detailed view, may need alternative parsing');
        }
      } catch (e) {
        console.warn('Failed to recompute category aggregates:', e && e.message);
      }

    // Finalize multi-group format
    if (result.multipleGroups) {
      // Re-aggregate category stats from assignments within each group
      try {
        for (const groupName in groups) {
          const g = groups[groupName];
          const groupAgg = {};
          
          // Sum assignment points by category within this group
          for (const score of g.scores) {
            const cat = score.category || 'Other';
            if (!groupAgg[cat]) groupAgg[cat] = { students: 0, max: 0 };
            groupAgg[cat].students += Number(score.score) || 0;
            groupAgg[cat].max += Number(score.totalPoints) || 0;
          }
          
          // Update category stats in the group with aggregated values
          for (const catName in groupAgg) {
            const agg = groupAgg[catName];
            const sp = agg.students;
            const mp = agg.max;
            const pctVal = (mp > 0) ? (sp / mp) * 100 : 0;
            
            if (g.categories[catName]) {
              g.categories[catName].studentsPoints = sp.toFixed(4);
              g.categories[catName].maximumPoints = mp.toFixed(2);
              g.categories[catName].percent = pctVal.toFixed(3) + '%';
              
              // Recompute categoryPoints = (percent / 100) * weight
              const weight = parseFloat(g.categories[catName].categoryWeight) || 0;
              g.categories[catName].categoryPoints = ((pctVal / 100) * weight).toFixed(6);
            }
          }
          console.log('parseClassDetailsHtml: re-aggregated group=', groupName, 'categories=', Object.keys(groupAgg));
        }
      } catch (e) {
        console.warn('Failed to re-aggregate multi-group categories:', e && e.message);
      }
      
      // Copy parsed groups to result
      result.class.groups = groups;
      // Mark single-exam groups (only one category with a few assignments)
      for (const groupName in groups) {
        const g = groups[groupName];
        const catCount = Object.keys(g.categories).length;
        const assignCount = g.scores.length;
        if (catCount === 0 || (catCount === 1 && assignCount <= 3)) {
          g.single = true;
        }
        console.log('parseClassDetailsHtml: finalized group=', groupName, 'single=', g.single, 'cats=', catCount, 'scores=', assignCount);
      }
      console.log('parseClassDetailsHtml: multipleGroups enabled, groups=', Object.keys(groups));
    }

    // If multipleGroups is true, ensure top-level scores/categories are empty
    // and migrate any stray top-level scores into a default group so data lives only under groups
    if (result.multipleGroups) {
      try {
        // Move any top-level scores into a fallback group named 'Other' unless a better target exists
        if (result.class.scores && result.class.scores.length > 0) {
          if (!result.class.groups['Other']) {
            result.class.groups['Other'] = { weight: '0', grade: '', single: false, categories: {}, scores: [] };
          }
          for (const s of result.class.scores) {
            result.class.groups['Other'].scores.push(s);
          }
          console.log('parseClassDetailsHtml: migrated', result.class.scores.length, 'top-level scores into groups.Other');
        }

        // Clear top-level scores and categories so only groups contain data
        result.class.scores = [];
        result.class.categories = {};
      } catch (e) { /* ignore */ }
    }

  } catch (e) {
    console.error('Error parsing class details:', e && e.message);
  }

  return result;
}


export {
  fetchGradebookHtml,
  harvestIdentifiers,
  parseGradebook,
  fetchClassDetail,
  parseClassDetailsHtml,
  extractTermHierarchy,
  extractClassInfo,
  findMatchingBrace,
};
