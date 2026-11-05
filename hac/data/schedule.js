/**
 * Schedule — the Classes page rendered as a list of period rows keyed by the
 * table's own column headers.
 */

import * as cheerio from '../../core/html.js';
import { HAC_ENDPOINTS } from '../config/constants.js';
import { checkSessionValidity } from '../auth/credentials.js';

async function schedule(session, link) {
  const response = await session.get(link + HAC_ENDPOINTS.CLASSES);
  checkSessionValidity(response);

  const $ = cheerio.load(response.data);

  const columns = [];
  $('.sg-asp-table-header-row').children().each(function () {
    columns.push($(this).text().trim());
  });

  const rows = [];
  $('.sg-asp-table-data-row').each(function () {
    const row = {};
    $(this).children().each(function (i) {
      row[columns[i]] = $(this).text().trim();
    });
    rows.push(row);
  });

  return { schedule: rows };
}

export { schedule };
