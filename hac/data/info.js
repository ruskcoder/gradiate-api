/**
 * Student info — scrapes the Registration page for profile fields, pulls the
 * district name from the login splash banner. Login bookkeeping (the `users`
 * table) is done by core's /info route for every platform.
 */

import process from 'process';
import * as cheerio from 'cheerio';
import { HAC_ENDPOINTS } from '../config/constants.js';
import { checkSessionValidity } from '../auth/credentials.js';

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

  return {
    username: session.username,
    link,
    ...studentInfo,
  };
}

export { info };
