/**
 * Fast, DOM-free readers for HAC's Assignments page — the page behind /classes,
 * the API's hottest route (nearly every district in districts.json is HAC).
 *
 * Building a DOM for a ~300 KB Assignments page costs ~25 ms on a cold Worker
 * isolate and ~6 ms warm; scanning the markup directly costs ~4 ms cold and
 * ~1 ms warm. Each reader returns exactly what the cheerio code in classes.js
 * would, or `null` the moment the page deviates from the shape it understands
 * (nested tables, scripts or comments inside a class card, unusual tags,
 * ambiguous ids...). On `null` the caller falls back to the DOM path, so
 * an unexpected page costs time, never correctness.
 */

import { decodeHTML, decodeHTMLAttribute } from 'entities';

const ATTR_RE = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
// Tags whose end we find by matching open/close tags. Elements HTML lets you
// leave unclosed (p, li, td, option...) are deliberately absent.
const BALANCED_TAGS = new Set(['a', 'span', 'label', 'div', 'strong', 'b', 'em', 'i', 'u', 'small', 'font', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'table', 'section', 'header', 'strike', 's', 'del']);

const tagRegex = (name) => new RegExp(`<(${name})\\b(?:[^>"']|"[^"]*"|'[^']*')*>`, 'gi');
const INPUT_RE = tagRegex('input');
const SELECT_RE = tagRegex('select');
const OPTION_RE = tagRegex('option');
const anyOpenTag = () => /<([a-z][a-z0-9]*)\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi;
const TAG_AT = /<([a-z][a-z0-9]*)\b(?:[^>"']|"[^"]*"|'[^']*')*>/iy;
const MARKUP_RE = /<[a-z/!?](?:[^>"']|"[^"]*"|'[^']*')*>/gi;
const SKIP_RE = /<script\b[\s\S]*?<\/script\s*>|<style\b[\s\S]*?<\/style\s*>|<!--[\s\S]*?-->/gi;

// Why the last reader call returned null, for the fallback log line. Readers are
// synchronous, so the caller reads it right after the call. Reasons describe
// markup structure only, never page text.
let fallbackReason = null;
function bail(reason) {
  fallbackReason = reason;
  return null;
}

/** The reason the most recent reader returned null (and clear it). */
function takeFallbackReason() {
  const reason = fallbackReason || 'unknown';
  fallbackReason = null;
  return reason;
}

/** Attributes of one start tag, first occurrence wins, values entity-decoded. */
function attrsOf(tag) {
  const attrs = {};
  const nameEnd = tag.search(/[\s/>]/);
  ATTR_RE.lastIndex = nameEnd === -1 ? tag.length : nameEnd;
  let m;
  while ((m = ATTR_RE.exec(tag))) {
    const name = m[1].toLowerCase();
    if (!(name in attrs)) attrs[name] = decodeHTMLAttribute(m[2] ?? m[3] ?? m[4] ?? '');
  }
  return attrs;
}

const hasClass = (attrs, name) => typeof attrs.class === 'string' && attrs.class.split(/\s+/).includes(name);

/** Text content of a markup fragment, as cheerio's .text() would read it. */
const textOf = (markup) => decodeHTML(markup.indexOf('<') === -1 ? markup : markup.replace(MARKUP_RE, ''));

/** Ranges of script/style/comment text, which the DOM never matches inside. */
function hiddenRanges(html) {
  const ranges = [];
  SKIP_RE.lastIndex = 0;
  let m;
  while ((m = SKIP_RE.exec(html))) ranges.push([m.index, m.index + m[0].length]);
  return ranges;
}

function isHidden(ranges, index) {
  let lo = 0;
  let hi = ranges.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (index < ranges[mid][0]) hi = mid - 1;
    else if (index >= ranges[mid][1]) lo = mid + 1;
    else return true;
  }
  return false;
}

/** Every start tag matched by `re` in html[from, to), skipping hidden text. */
function startTags(html, re, ranges, from = 0, to = html.length) {
  const tags = [];
  re.lastIndex = from;
  let m;
  while ((m = re.exec(html)) && m.index < to) {
    if (ranges && isHidden(ranges, m.index)) continue;
    tags.push({ index: m.index, end: m.index + m[0].length, name: (m[1] || '').toLowerCase(), attrs: attrsOf(m[0]) });
  }
  return tags;
}

/**
 * Start tags in html[from, to) whose class list contains `name`. Found by
 * searching for the class name itself, so a 300 KB page isn't tag-scanned in
 * full. Returns null when an occurrence sits in markup that can't be read.
 */
function tagsWithClass(html, name, ranges, from = 0, to = html.length) {
  const tags = [];
  let lastTag = -1;
  for (let at = html.indexOf(name, from); at !== -1 && at < to; at = html.indexOf(name, at + name.length)) {
    const lt = html.lastIndexOf('<', at);
    if (lt < from || lt === lastTag) continue;
    const gt = html.indexOf('>', lt);
    if (gt !== -1 && gt < at && !/["']/.test(html.slice(lt, at))) continue; // plain text, not a tag
    if (ranges && isHidden(ranges, lt)) continue;
    TAG_AT.lastIndex = lt;
    const m = TAG_AT.exec(html);
    if (!m) {
      if (html[lt + 1] === '/' || gt < at) continue; // a close tag or text
      return bail(`unreadable tag around class ${name}`);
    }
    if (lt + m[0].length <= at) continue; // the name is in text after this tag
    lastTag = lt;
    const attrs = attrsOf(m[0]);
    if (hasClass(attrs, name)) tags.push({ index: lt, end: lt + m[0].length, name: m[1].toLowerCase(), attrs });
  }
  return tags;
}

/**
 * Index just past the close tag matching the `name` element whose start tag
 * ends at `openEnd`, counting nested elements of the same name. -1 if unclosed.
 */
function elementEnd(html, name, openEnd, limit = html.length) {
  const re = new RegExp(`<(/?)${name}\\b(?:[^>"']|"[^"]*"|'[^']*')*>`, 'gi');
  re.lastIndex = openEnd;
  let depth = 1;
  let m;
  while ((m = re.exec(html)) && m.index < limit) {
    depth += m[1] ? -1 : 1;
    if (depth === 0) return m.index + m[0].length;
  }
  return -1;
}

/** Inner markup of an element given its start tag record, or null if it can't be bounded. */
function innerOf(html, tag, limit) {
  if (!BALANCED_TAGS.has(tag.name)) return bail(`can't find the end of <${tag.name}>`);
  const end = elementEnd(html, tag.name, tag.end, limit);
  if (end === -1) return bail(`unclosed <${tag.name}>`);
  return { start: tag.end, end: html.lastIndexOf('<', end - 1), outerEnd: end };
}

/** `$('input[name="…"]').val()` */
function inputValue(html, ranges, name) {
  for (const tag of startTags(html, INPUT_RE, ranges)) {
    if (tag.attrs.name === name) return tag.attrs.value;
  }
  return undefined;
}

/**
 * The report-card-run dropdown. Returns { options: [{ value, text, selected }] },
 * { options: [] } when absent, or null when it isn't one unambiguous <select>.
 */
function reportCardRuns(html, ranges) {
  const selects = startTags(html, SELECT_RE, ranges)
    .filter((t) => t.attrs.name === 'ctl00$plnMain$ddlReportCardRuns' || t.attrs.id === 'plnMain_ddlReportCardRuns');
  if (selects.length === 0) return { options: [] };
  const [select] = selects;
  if (selects.length > 1 || select.attrs.name !== 'ctl00$plnMain$ddlReportCardRuns' || select.attrs.id !== 'plnMain_ddlReportCardRuns') {
    return bail(`${selects.length} report-card-run dropdowns, or a mismatched name/id`);
  }
  const close = html.slice(select.end).search(/<\/select\s*>/i);
  if (close === -1) return bail('report-card-run dropdown has no </select>');
  const body = html.slice(select.end, select.end + close);
  if (/<(?!\/?(?:option|optgroup)\b)[a-z!/]/i.test(body)) return bail('unexpected tag inside the report-card-run dropdown');

  const options = [];
  OPTION_RE.lastIndex = 0;
  let m;
  while ((m = OPTION_RE.exec(body))) {
    const textEnd = body.indexOf('<', OPTION_RE.lastIndex);
    const attrs = attrsOf(m[0]);
    options.push({
      value: attrs.value,
      text: decodeHTML(body.slice(OPTION_RE.lastIndex, textEnd === -1 ? body.length : textEnd)),
      selected: attrs.selected === 'selected',
    });
  }
  return { options };
}

/** `extractViewStateData($)` from classes.js, or null to fall back. */
function scanViewState(html, ranges = hiddenRanges(html)) {
  const runs = reportCardRuns(html, ranges);
  if (!runs) return null;
  return {
    viewstate: inputValue(html, ranges, '__VIEWSTATE'),
    eventvalidation: inputValue(html, ranges, '__EVENTVALIDATION'),
    year: (runs.options[1]?.value || '').substring(2),
    term: runs.options.filter((o) => o.selected).map((o) => o.text).join('').trim(),
  };
}

/** `extractTermInfo($)` from classes.js, or null to fall back. */
function scanTermInfo(html, ranges = hiddenRanges(html)) {
  const runs = reportCardRuns(html, ranges);
  if (!runs) return null;
  return {
    term: runs.options.filter((o) => o.selected).map((o) => o.text).join('').trim(),
    termList: runs.options.map((o) => o.text.trim()).slice(1),
  };
}

/**
 * Split a <table>/<tr> body into the children the DOM would give it: each part
 * runs from one `<tr`/`<td`/`<th` to the next, since HTML lets those end tags be
 * omitted. Returns null if anything other than whitespace precedes the first.
 */
function splitAt(markup, re) {
  const starts = [];
  re.lastIndex = 0;
  let m;
  while ((m = re.exec(markup))) starts.push({ index: m.index, end: m.index + m[0].length, attrs: attrsOf(m[0]) });
  if (starts.length && /\S/.test(markup.slice(0, starts[0].index).replace(/<\/?(?:tbody|tr|td|th)\b[^>]*>/gi, ''))) {
    return bail('markup before the first table row or cell');
  }
  return starts.map((s, i) => ({ attrs: s.attrs, inner: markup.slice(s.end, i + 1 < starts.length ? starts[i + 1].index : markup.length) }));
}

const ROW_START = /<tr\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi;
const CELL_START = /<t[dh]\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi;

/** Data rows (class sg-asp-table-data-row) of one table body, each as an array of cell markup. */
function dataRows(tableInner) {
  const rows = splitAt(tableInner, ROW_START);
  if (!rows) return null;
  const out = [];
  for (const row of rows) {
    if (!hasClass(row.attrs, 'sg-asp-table-data-row')) continue;
    const cells = splitAt(row.inner, CELL_START);
    if (!cells) return null;
    out.push(cells.map((c) => c.inner));
  }
  return out;
}

/**
 * Bodies of the sibling <table>s in a category group, in document order (the DOM
 * path reads every data row under the group, however many tables hold them). A
 * group without tables is read as one body. Null if a table is nested in another,
 * unclosed, or if rows sit outside any table.
 */
function tableBodies(groupInner) {
  const re = new RegExp('<table\\b(?:[^>"\']|"[^"]*"|\'[^\']*\')*>', 'gi');
  const bodies = [];
  let outside = '';
  let cursor = 0;
  let m;
  while ((m = re.exec(groupInner))) {
    const openEnd = m.index + m[0].length;
    const end = elementEnd(groupInner, 'table', openEnd);
    if (end === -1) return bail('unclosed <table> in the category group');
    const body = groupInner.slice(openEnd, groupInner.lastIndexOf('<', end - 1));
    if (/<table\b/i.test(body)) return bail('table nested in a category table');
    bodies.push(body);
    outside += groupInner.slice(cursor, m.index);
    cursor = end;
    re.lastIndex = end;
  }
  if (bodies.length === 0) return [groupInner];
  outside += groupInner.slice(cursor);
  if (/<tr\b/i.test(outside)) return bail('table rows outside a table in the category group');
  return bodies;
}

/** `.children().first().text()` of a cell: its first element's text. */
function firstChildText(cell) {
  const m = anyOpenTag().exec(cell);
  if (!m) return '';
  const name = m[1].toLowerCase();
  if (VOID_TAGS.has(name)) return '';
  if (!BALANCED_TAGS.has(name)) return bail(`assignment cell starts with <${name}>`);
  const end = elementEnd(cell, name, m.index + m[0].length);
  const inner = cell.slice(m.index + m[0].length, end === -1 ? cell.length : cell.lastIndexOf('<', end - 1));
  return textOf(inner);
}

function splitClassHeaderAndCourseName(classText) {
  const parts = classText.split(' ');
  return {
    classHeader: parts.slice(0, 3).join(' '),
    courseName: parts.slice(3).join(' '),
  };
}

/** Every element with class `name` in html[from, to) that can be bounded, else null. */
function elementsWithClass(html, name, from, to) {
  const tags = tagsWithClass(html, name, null, from, to);
  if (!tags) return null;
  const found = [];
  for (const tag of tags) {
    const inner = innerOf(html, tag, to);
    if (!inner) return null;
    found.push({ ...tag, inner });
  }
  return found;
}

const UNSAFE_IN_CARD = /<(?:script|style|textarea|thead|tfoot|template|select)\b|<!--|<!\[CDATA\[/i;

/** One AssignmentClass card → the same object extractClasses builds, or null. */
function readCard(html, card) {
  const { start, end } = card.inner;
  const unsafe = UNSAFE_IN_CARD.exec(html.slice(start, end));
  if (unsafe) return bail(`class card contains ${unsafe[0].toLowerCase()}`);

  const headers = elementsWithClass(html, 'sg-header', start, end);
  if (!headers) return null;
  const headings = [];
  for (const header of headers) {
    const found = elementsWithClass(html, 'sg-header-heading', header.inner.start, header.inner.end);
    if (!found) return null;
    for (const h of found) headings.push({ right: hasClass(h.attrs, 'sg-right'), text: textOf(html.slice(h.inner.start, h.inner.end)) });
  }
  if (headers.length > 1) return bail(`class card has ${headers.length} .sg-header elements`);

  const allText = headings.map((h) => h.text).join('').trim();
  const classHeader = splitClassHeaderAndCourseName(allText).classHeader.trim();
  const name = splitClassHeaderAndCourseName(headings[0] ? headings[0].text.trim() : '').courseName.trim();
  const averageText = headings.filter((h) => h.right).map((h) => h.text).join('').trim().split(' ').pop();
  const result = {
    classHeader,
    name,
    average: averageText.endsWith('%') ? averageText.slice(0, -1) : averageText,
    scores: [],
    categories: {},
  };

  const grids = elementsWithClass(html, 'sg-content-grid', start, end);
  if (!grids) return null;
  if (grids.length > 1) return bail(`class card has ${grids.length} .sg-content-grid elements`);
  if (grids.length === 0) return result;
  const grid = grids[0].inner;

  // Top-level children of the grid: assignment tables, optional <br>s and the
  // category group. Anything else and the DOM path decides.
  const groups = [];
  const tables = [];
  const openTag = anyOpenTag();
  openTag.lastIndex = grid.start;
  let cursor = grid.start;
  let m;
  while ((m = openTag.exec(html)) && m.index < grid.end) {
    if (/\S/.test(html.slice(cursor, m.index).replace(/<\/(?:br|p)\s*>/gi, ''))) {
      return bail(`text or a close tag before <${m[1].toLowerCase()}> in the grid`);
    }
    const tag = { index: m.index, end: m.index + m[0].length, name: m[1].toLowerCase(), attrs: attrsOf(m[0]) };
    if (VOID_TAGS.has(tag.name)) {
      if (hasClass(tag.attrs, 'sg-asp-table') || hasClass(tag.attrs, 'sg-asp-table-group')) return bail(`table class on <${tag.name}>`);
      cursor = tag.end;
      openTag.lastIndex = cursor;
      continue;
    }
    const inner = innerOf(html, tag, grid.end);
    if (!inner) return null;
    if (hasClass(tag.attrs, 'sg-asp-table')) {
      if (tag.name !== 'table') return bail(`.sg-asp-table on <${tag.name}>`);
      tables.push(inner);
    }
    if (hasClass(tag.attrs, 'sg-asp-table-group')) {
      groups.push(inner);
    } else if (!hasClass(tag.attrs, 'sg-asp-table')) {
      // A wrapper the DOM selectors could see into; only a group is understood.
      if (/sg-asp-table|<tr\b/i.test(html.slice(inner.start, inner.end))) return bail(`table rows inside a <${tag.name}> in the grid`);
    }
    cursor = inner.outerEnd;
    openTag.lastIndex = cursor;
  }
  if (/\S/.test(html.slice(cursor, grid.end).replace(/<\/(?:br|p)\s*>/gi, ''))) return bail('text after the last grid child');

  for (const table of tables) {
    const inner = html.slice(table.start, table.end);
    if (/<table\b|sg-asp-table-group/i.test(inner)) return bail('table nested inside the assignments table');
    const rows = dataRows(inner);
    if (!rows) return null;
    for (const cells of rows) {
      const cell = (i) => (cells[i] === undefined ? '' : textOf(cells[i]).trim());
      const assignmentName = cells[2] === undefined ? '' : firstChildText(cells[2]);
      if (assignmentName === null) return null;
      const assignment = {
        name: assignmentName.trim(),
        category: cell(3),
        percentage: cell(9).slice(0, -1),
        score: cell(4),
        totalPoints: parseFloat(cell(5)) || '',
        weight: parseFloat(cell(6)) || '',
        weightedScore: parseFloat(cell(7)) || '',
        weightedTotalPoints: parseFloat(cell(8)) || '',
        dateDue: cell(0),
        dateAssigned: cell(1),
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
      result.scores.push(assignment);
    }
  }

  for (const group of groups) {
    const inner = html.slice(group.start, group.end);
    if (/sg-asp-table-group|sg-content-grid/i.test(inner)) return bail('category group holds a nested group or grid');
    const bodies = tableBodies(inner);
    if (!bodies) return null;
    const groupRows = [];
    for (const body of bodies) {
      const rows = dataRows(body);
      if (!rows) return null;
      groupRows.push(...rows);
    }
    for (const cells of groupRows) {
      const cell = (i) => (cells[i] === undefined ? '' : textOf(cells[i]).trim());
      result.categories[cell(0)] = {
        studentsPoints: cell(1),
        maximumPoints: cell(2),
        percent: cell(3),
        categoryWeight: cell(4),
        categoryPoints: cell(5),
      };
    }
  }
  return result;
}

/** `extractClasses($)` from classes.js, or null to fall back. */
function scanClasses(html, ranges = hiddenRanges(html)) {
  const cardTags = tagsWithClass(html, 'AssignmentClass', ranges);
  if (!cardTags) return null;
  const cards = [];
  for (const tag of cardTags) {
    if (tag.name !== 'div') return bail(`AssignmentClass on <${tag.name}>`);
    const inner = innerOf(html, tag);
    if (!inner) return null;
    if (cards.length && tag.index < cards[cards.length - 1].inner.outerEnd) return bail('nested AssignmentClass cards');
    cards.push({ ...tag, inner });
  }

  const scheduleData = {};
  for (const card of cards) {
    const read = readCard(html, card);
    if (!read) return null;
    if (!scheduleData[read.classHeader]) {
      scheduleData[read.classHeader] = { course: read.classHeader, name: read.name };
    }
    const entry = scheduleData[read.classHeader];
    entry.average = read.average;
    entry.scores = read.scores;
    entry.categories = read.categories;
  }
  return Object.values(scheduleData);
}

const SPAN_RE = tagRegex('span');

/**
 * `$('span#id').text()` for each id, as { id: text | undefined } (undefined: no
 * such span). Null if an id appears on several spans or a span can't be bounded.
 */
function scanSpanTexts(html, ids, ranges = hiddenRanges(html)) {
  const wanted = new Set(ids);
  const found = {};
  for (const tag of startTags(html, SPAN_RE, ranges)) {
    const id = tag.attrs.id;
    if (id === undefined || !wanted.has(id)) continue;
    if (id in found) return bail('several spans share an id');
    const inner = innerOf(html, tag);
    if (!inner) return null;
    found[id] = textOf(html.slice(inner.start, inner.end));
  }
  return found;
}

/**
 * `$('span.<name>').text()`: every matching span's text, joined. Null if one
 * can't be bounded or they nest (the DOM would count the inner text twice).
 */
function scanSpanClassText(html, name, ranges = hiddenRanges(html)) {
  const tags = tagsWithClass(html, name, ranges);
  if (!tags) return null;
  let text = '';
  let lastEnd = -1;
  for (const tag of tags) {
    if (tag.name !== 'span') continue;
    if (tag.index < lastEnd) return bail('nested spans with the same class');
    const inner = innerOf(html, tag);
    if (!inner) return null;
    lastEnd = inner.outerEnd;
    text += textOf(html.slice(inner.start, inner.end));
  }
  return text;
}

/** `$('input[name="…"]').val()` for a whole page. */
function scanInputValue(html, name) {
  return inputValue(html, hiddenRanges(html), name);
}

export { scanViewState, scanTermInfo, scanClasses, scanInputValue, scanSpanTexts, scanSpanClassText, hiddenRanges, takeFallbackReason };
