/**
 * Student info — scrapes the Registration page for profile fields, pulls the
 * district name from the login splash banner, and records the user's login.
 *
 * The user bookkeeping (recordLogin) and district extraction used to live in the
 * HAC route; under the registry model that business logic belongs to the data
 * function, not core.
 */

import process from 'process';
import * as cheerio from 'cheerio';
import { HAC_ENDPOINTS } from '../config/constants.js';
import { checkSessionValidity } from '../auth/credentials.js';
import { recordLogin } from '../../users.js';

async function info(session, link) {
  const registration = await session.get(link + HAC_ENDPOINTS.REGISTRATION);
  checkSessionValidity(registration);

  const $ = cheerio.load(registration.data);

  let studentInfo = {};
  let district = '';

  if (session.hacData) {
    try {
      district = cheerio.load(session.hacData)('span.sg-banner-text').text().trim();
    } catch {
      // hacData wasn't HTML; leave district blank.
    }
  }

  if ($('span#plnMain_lblRegStudentName').length) {
    studentInfo = {
      name: $('span#plnMain_lblRegStudentName').text().trim(),
      grade: $('span#plnMain_lblGrade').text().trim(),
      school: $('span#plnMain_lblBuildingName').text().trim(),
      dob: $('span#plnMain_lblBirthDate').text().trim(),
      counselor: $('span#plnMain_lblCounselor').text().trim(),
      language: $('span#plnMain_lblLanguage').text().trim(),
      cohortYear: $('span#plnMain_lblCohortYear').text().trim(),
      district,
    };
    if (studentInfo.name === process.env.MYNAME) {
      studentInfo.name = 'Test User';
    }
  }

  const username = (session.username || '').toLowerCase();
  // Bookkeeping only — a Supabase hiccup must not cost the user their info.
  let firstLoggedIn = null;
  try {
    ({ firstLoggedIn } = await recordLogin(username, studentInfo.school, studentInfo.name));
  } catch (error) {
    console.error('recordLogin failed:', error);
  }

  return {
    username: session.username,
    link,
    firstLoggedIn,
    ...studentInfo,
  };
}

export { info };
