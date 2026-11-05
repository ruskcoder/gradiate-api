/**
 * Teachers — the Classes page reduced to class → teacher name + mailto email.
 */

import * as cheerio from '../../core/html.js';
import { HAC_ENDPOINTS } from '../config/constants.js';
import { checkSessionValidity } from '../auth/credentials.js';

async function teachers(session, link) {
  const response = await session.get(link + HAC_ENDPOINTS.CLASSES);
  checkSessionValidity(response);

  const $ = cheerio.load(response.data);

  const list = [];
  $('.sg-asp-table-data-row').each(function () {
    const teacherInfo = $(this).children().eq(3).find('a');
    list.push({
      class: $(this).children().eq(1).text().trim(),
      teacher: teacherInfo.text().trim(),
      email: String(teacherInfo.attr('href')).replace('mailto:', '').trim(),
    });
  });

  return { teachers: list };
}

export { teachers };
