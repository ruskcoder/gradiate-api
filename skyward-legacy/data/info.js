/**
 * Student info — POST sfstudentinfo001.w, parse the profile page.
 * parseStudentInfoHtml is ported from the reverse-engineering WIP.
 */

import { checkSessionValidity, tokenBody, lazyPortalUrl } from '../auth/credentials.js';

function escapeRegExp(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function info(session, link, options, progressTracker) {
  const res = await session.post(lazyPortalUrl(session, link, 'INFO'), tokenBody(session), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
  });
  checkSessionValidity(res);
  progressTracker?.update?.(75, 'Parsing student info');
  return parseStudentInfoHtml(res.data);
}

function parseStudentInfoHtml(html) {
  const result = { success: true };

  // Student name
  const nameMatch = /<div[^>]*id=['"]sf_StudentLabel['"][^>]*>\s*([^<]+?)\s*<\/div>/i.exec(html);
  if (nameMatch) result.name = nameMatch[1].trim();

  // Helper to find <label>Label:</label> followed by a <td>value</td>
  function findLabelValue(label) {
    // Try a few patterns to locate the label and its following cell
    const patterns = [
      // <label ...>Label:</label></td><td>VALUE</td>
      new RegExp('<label[^>]*>\\s*' + escapeRegExp(label) + '\\s*:\\s*<\\/label>\\s*<\\/td>\\s*<td[^>]*>([\\s\\S]*?)<\\/td>', 'i'),
      // <td><label ...>Label:</label></td><td>VALUE</td>
      new RegExp('<td[^>]*>\\s*<label[^>]*>\\s*' + escapeRegExp(label) + '\\s*:\\s*<\\/label>\\s*<\\/td>\\s*<td[^>]*>([\\s\\S]*?)<\\/td>', 'i'),
      // fallback: label text then any nearby cell
      new RegExp(escapeRegExp(label) + '\\s*:\\s*<\\/label>\\s*<\\/td>\\s*<td[^>]*>([\\s\\S]*?)<', 'i')
    ];

    for (const re of patterns) {
      const m = re.exec(html);
      if (m && m[1]) return m[1].replace(/<[^>]+>/g, '').replace(/&nbsp;|\\u00A0/g, '').trim();
    }
    return null;
  }

  // Determine school name from the page header (e.g. STRATFORD H S)
  const schoolHeaderMatch = /<th[^>]*>\s*([^<>\n\r]+?)\s*<br>/i.exec(html);
  if (schoolHeaderMatch) {
    result.school = schoolHeaderMatch[1].trim();
  } else {
    result.school = null;
  }

  // Some pages put an email under the 'School' label (student email). Detect and split.
  const schoolLabelVal = findLabelValue('School');
  if (schoolLabelVal && /@/.test(schoolLabelVal)) {
    result.studentEmail = schoolLabelVal;
  } else if (schoolLabelVal) {
    // if it's not an email and we don't have a header name, use it
    if (!result.school) result.school = schoolLabelVal;
  }

  result.home = findLabelValue('Home') || null; // often parent's email
  result.call = findLabelValue('Call') || null; // phone
  const ageDob = findLabelValue('Age (Birthday)') || '';
  if (ageDob) {
    const dobMatch = /\(([^)]+)\)/.exec(ageDob);
    result.dob = dobMatch ? dobMatch[1].trim() : null;
    const ageMatch = /^(\d+)/.exec(ageDob);
    result.age = ageMatch ? Number(ageMatch[1]) : null;
  }

  result.grade = findLabelValue('Grade') || null;
  result.status = findLabelValue('Status') || null;

  // Additional fields requested
  result.language = findLabelValue('Language') || null;
  // Cohort / Graduation Year
  result.cohortYear = findLabelValue('Graduation Year') || null;

  // Counselor (if present)
  result.counselor = findLabelValue('Counselor') || null;

  // Per request, leave district blank
  result.district = '';

  // Emergency contacts: attempt to parse first row under Emergency Contacts table
  const emergencyTableMatch = /<table[^>]*id=["']grid_studentEC[^"']*[^>]*>[\s\S]*?<tbody>([\s\S]*?)<\/tbody>/i.exec(html);
  if (emergencyTableMatch) {
    const firstRowMatch = /<tr[^>]*>\s*<td[^>]*>([\s\S]*?)<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>/i.exec(emergencyTableMatch[1]);
    if (firstRowMatch) {
      const name = firstRowMatch[1].replace(/<[^>]+>/g, '').trim();
      const primaryPhone = firstRowMatch[2].replace(/<[^>]+>/g, '').trim();
      result.emergencyContacts = [{ name, primaryPhone }];
    }
  }

  // Address: try to find first textarea content in the student family block
  const addrMatch = /<textarea[^>]*>([\s\S]*?)<\/textarea>/i.exec(html);
  if (addrMatch) result.address = addrMatch[1].trim();

  return result;
}

export { info, parseStudentInfoHtml };
