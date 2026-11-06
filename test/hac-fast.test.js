import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fullCheerio from 'cheerio';
import { load } from '../core/html.js';
import { scanClasses, scanTermInfo, scanViewState, scanInputValue } from '../hac/data/fastScan.js';
import { extractClasses, extractTermInfo, extractViewStateData } from '../hac/data/classes.js';
import { buildAssignmentsPage } from './fixtures/hacAssignments.js';

// The reference is the original code path: cheerio's default (parse5) parser.
const reference = (html) => fullCheerio.load(html);

function assertSameAsReference(html) {
  const $ = reference(html);
  assert.deepEqual(scanClasses(html), extractClasses($));
  assert.deepEqual(scanTermInfo(html), extractTermInfo($));
  assert.deepEqual(scanViewState(html), extractViewStateData($));
}

test('htmlparser2 loader reads HAC pages exactly like parse5', () => {
  for (const opts of [{}, { explicitTbody: true }, { omitRowClose: true }, { duplicateClass: true }, { noSelect: true }]) {
    const html = buildAssignmentsPage(opts);
    const $ = load(html);
    const $ref = reference(html);
    assert.deepEqual(extractClasses($), extractClasses($ref), JSON.stringify(opts));
    assert.deepEqual(extractTermInfo($), extractTermInfo($ref));
    assert.deepEqual(extractViewStateData($), extractViewStateData($ref));
  }
});

test('fast reader matches the cheerio reader on the standard page', () => {
  const html = buildAssignmentsPage();
  assertSameAsReference(html);
  const classes = scanClasses(html);
  assert.equal(classes.length, 6);
  assert.equal(classes[0].scores.length, 14);
  assert.deepEqual(classes[0].scores[0].badges, ['missing', 'dropped']);
  assert.equal(Object.keys(classes[0].categories).length, 3);
});

test('fast reader matches on markup variations it supports', () => {
  for (const opts of [{ explicitTbody: true }, { omitRowClose: true }, { duplicateClass: true }, { noSelect: true }, { firstChildSpan: true }, { classes: 0 }]) {
    assertSameAsReference(buildAssignmentsPage(opts));
  }
});

test('fast reader refuses pages it cannot vouch for', () => {
  assert.equal(scanClasses(buildAssignmentsPage({ commentInCard: true })), null);
  // A second dropdown claiming the same id is ambiguous.
  const html = buildAssignmentsPage().replace('<div class="sg-content">', '<select id="plnMain_ddlReportCardRuns"></select><div class="sg-content">');
  assert.equal(scanTermInfo(html), null);
});

test('hidden inputs ignore decoys inside scripts and decode entities', () => {
  const html = buildAssignmentsPage();
  assert.equal(scanInputValue(html, '__VIEWSTATE'), 'dGhpcyBpcyBhIHZpZXdzdGF0ZQ==/+AB&C');
  assert.equal(scanInputValue(html, '__MISSING'), undefined);
});

test('a refused page reports why, without page text', async () => {
  const { takeFallbackReason } = await import('../hac/data/fastScan.js');
  assert.equal(scanClasses(buildAssignmentsPage({ commentInCard: true })), null);
  assert.equal(takeFallbackReason(), 'class card contains <!--');
  assert.equal(takeFallbackReason(), 'unknown'); // cleared once read
});
