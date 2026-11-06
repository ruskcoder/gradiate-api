import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fullCheerio from 'cheerio';
import { scanSpanTexts, scanSpanClassText, takeFallbackReason } from '../hac/data/fastScan.js';

const IDS = ['plnMain_lblRegStudentName', 'plnMain_lblGrade', 'plnMain_lblBuildingName', 'plnMain_lblBirthDate'];

const page = (body) => `<!DOCTYPE html><html><head><script>var s = '<span id="plnMain_lblGrade">decoy</span>';</script></head><body>${body}</body></html>`;

// What info.js did before the scanner: parse5 cheerio, concatenated span text.
const viaCheerio = (html) => {
  const $ = fullCheerio.load(html);
  return Object.fromEntries(IDS.map((id) => [id, $(`span#${id}`).length ? $(`span#${id}`).text() : undefined]));
};

test('info scanner reads registration spans like cheerio', () => {
  const variants = [
    `<span id="plnMain_lblRegStudentName">Doe, Sam &amp; Co</span><span id="plnMain_lblGrade"> 10 </span><span id="plnMain_lblBuildingName">Example <b>High</b> School</span><span id="plnMain_lblBirthDate">01/02/2010</span>`,
    `<table><tr><td><span id='plnMain_lblRegStudentName'>Doe, Sam</span></td></tr></table><span id="plnMain_lblGrade">09</span>`,
    `<div>no registration here</div>`,
    `<span id="plnMain_lblRegStudentName"></span><span class="x" id="plnMain_lblGrade"><span>11</span></span>`,
    `<!-- <span id="plnMain_lblGrade">commented</span> --><span id="plnMain_lblGrade">12</span><span id="plnMain_lblRegStudentName">A</span>`,
    `<div id="plnMain_lblGrade">wrong tag</div><span id="plnMain_lblRegStudentName">A</span>`,
  ];
  for (const body of variants) {
    const html = page(body);
    const scanned = scanSpanTexts(html, IDS);
    assert.deepEqual(Object.fromEntries(IDS.map((id) => [id, scanned[id]])), viaCheerio(html), body);
  }
});

test('info scanner refuses ambiguous spans and says why', () => {
  const html = page('<span id="plnMain_lblGrade">9</span><span id="plnMain_lblGrade">10</span>');
  assert.equal(scanSpanTexts(html, IDS), null);
  assert.equal(takeFallbackReason(), 'several spans share an id');
  assert.equal(scanSpanTexts(page('<span id="plnMain_lblGrade">unclosed'), IDS), null);
});

test('banner scanner reads the district name like cheerio', () => {
  for (const body of [
    '<span class="sg-banner-text">Example ISD</span>',
    '<div><span class="a sg-banner-text">Example &amp; Sons</span></div>',
    '<span class="other">nope</span>',
    '<span class="sg-banner-text">One</span><span class="sg-banner-text">Two</span>',
    '<div class="sg-banner-text">not a span</div>',
  ]) {
    const html = page(body);
    assert.equal(scanSpanClassText(html, 'sg-banner-text'), fullCheerio.load(html)('span.sg-banner-text').text(), body);
  }
  assert.equal(scanSpanClassText(page('<span class="sg-banner-text">a<span class="sg-banner-text">b</span></span>'), 'sg-banner-text'), null);
});
