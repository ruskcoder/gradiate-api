/**
 * Student info — scrapes the Registration page for profile fields, pulls the
 * district name from the login splash banner. Login bookkeeping (the `users`
 * table) is done by core's /info route for every platform.
 */

import * as cheerio from '../../core/html.js';
import { env } from '../../core/env.js';
import { HAC_ENDPOINTS } from '../config/constants.js';
import { checkSessionValidity } from '../auth/credentials.js';
import { scanSpanTexts, scanSpanClassText, takeFallbackReason } from './fastScan.js';

const FIELD_IDS = {
  name: 'plnMain_lblRegStudentName',
  grade: 'plnMain_lblGrade',
  school: 'plnMain_lblBuildingName',
  dob: 'plnMain_lblBirthDate',
  counselor: 'plnMain_lblCounselor',
  language: 'plnMain_lblLanguage',
  cohortYear: 'plnMain_lblCohortYear',
};

// Same switch as the classes reader (hac/data/classes.js): "off" always builds
// the DOM, and so does "verify", which exists to compare readers on classes.
const fastPathOn = () => (env.HAC_FAST_PATH || 'on').toLowerCase() === 'on';

/** Registration fields as { key: text | undefined }, scanned if the page allows, else read from the DOM. */
function readFields(html) {
  if (fastPathOn() && typeof html === 'string') {
    const texts = scanSpanTexts(html, Object.values(FIELD_IDS));
    if (texts) {
      return Object.fromEntries(Object.entries(FIELD_IDS).map(([key, id]) => [key, texts[id]?.trim()]));
    }
    console.warn(`hac fast path: info fell back to cheerio (${takeFallbackReason()})`);
  }
  const $ = cheerio.load(html);
  return Object.fromEntries(Object.entries(FIELD_IDS).map(([key, id]) => {
    const span = $(`span#${id}`);
    return [key, span.length ? span.text().trim() : undefined];
  }));
}

/** The district name in the login page's banner. */
function readDistrict(html) {
  if (fastPathOn() && typeof html === 'string') {
    const text = scanSpanClassText(html, 'sg-banner-text');
    if (text !== null) return text.trim();
    console.warn(`hac fast path: banner fell back to cheerio (${takeFallbackReason()})`);
  }
  return cheerio.load(html)('span.sg-banner-text').text().trim();
}

async function info(session, link) {
  const registration = await session.get(link + HAC_ENDPOINTS.REGISTRATION);
  checkSessionValidity(registration);

  const fields = readFields(registration.data);

  let studentInfo = {};
  let district = '';

  if (session.hacData) {
    try {
      district = readDistrict(session.hacData);
    } catch {
      // hacData wasn't HTML; leave district blank.
    }
  }

  // The student name span is what says this is a registration page at all.
  if (fields.name !== undefined) {
    studentInfo = {
      name: fields.name,
      grade: fields.grade ?? '',
      school: fields.school ?? '',
      dob: fields.dob ?? '',
      counselor: fields.counselor ?? '',
      language: fields.language ?? '',
      cohortYear: fields.cohortYear ?? '',
      district,
    };
    if (studentInfo.name === env.MYNAME) {
      studentInfo.name = 'Test User';
    }
  }

  return {
    username: session.username,
    link,
    ...studentInfo,
  };
}

export { info };
