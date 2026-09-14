/**
 * Report-style pages: interim progress reports (ipr), report cards, and the
 * transcript. Progress reports and report cards iterate a run-date dropdown via
 * ASP.NET postbacks, collecting each run; the transcript is a single page of
 * per-semester group tables plus cumulative GPA rows.
 */

import * as cheerio from 'cheerio';
import { HAC_ENDPOINTS } from '../config/constants.js';
import { checkSessionValidity } from '../auth/credentials.js';

async function extractProgressReports(session, url, $) {
  const options = $('#plnMain_ddlIPRDates option').toArray().reverse();
  const reports = [];

  for (const option of options) {
    const value = $(option).attr('value');
    const selectedText = $(option).text().trim();

    const formData = {
      __EVENTTARGET: 'ctl00$plnMain$ddlIPRDates',
      __EVENTARGUMENT: '',
      __VIEWSTATE: $('input[name="__VIEWSTATE"]').val(),
      __EVENTVALIDATION: $('input[name="__EVENTVALIDATION"]').val(),
      'ctl00$plnMain$ddlIPRDates': value,
    };

    const { data: updatedPage } = await session.post(url, formData);
    const $$ = cheerio.load(updatedPage);

    const report = [];
    $$('#plnMain_dgIPR .sg-asp-table-data-row').each(function () {
      report.push({
        course: $$(this).children().eq(0).text().trim(),
        description: $$(this).children().eq(1).text().trim(),
        period: $$(this).children().eq(2).text().trim(),
        teacher: $$(this).children().eq(3).text().trim(),
        room: $$(this).children().eq(4).text().trim(),
        grade: $$(this).children().eq(5).text().trim(),
        com1: $$(this).children().eq(6).text().trim(),
        com2: $$(this).children().eq(7).text().trim(),
        com3: $$(this).children().eq(8).text().trim(),
        com4: $$(this).children().eq(9).text().trim(),
        com5: $$(this).children().eq(10).text().trim(),
      });
    });

    const comments = [];
    $$('.sg-asp-table[id*="CommentLegend"] tr.sg-asp-table-data-row').each(function () {
      comments.push({
        comment: $$(this).children().eq(0).text().trim(),
        commentDescription: $$(this).children().eq(1).text().trim(),
      });
    });

    report.push({ comments });
    reports.push({ date: selectedText, report });
  }

  return reports;
}

async function extractReportCards(session, url, $) {
  const options = $('#plnMain_ddlRCRuns option').toArray().reverse();
  const reload = options.length > 0;
  if (!reload) options.push('');

  const reports = [];

  for (const option of options) {
    let selectedText, $$;

    if (reload) {
      const value = $(option).attr('value');
      selectedText = $(option).text().trim();

      const formData = {
        __EVENTTARGET: 'ctl00$plnMain$ddlRCRuns',
        __EVENTARGUMENT: '',
        __VIEWSTATE: $('input[name="__VIEWSTATE"]').val(),
        __EVENTVALIDATION: $('input[name="__EVENTVALIDATION"]').val(),
        'ctl00$plnMain$ddlRCRuns': value,
      };

      const { data: updatedPage } = await session.post(url, formData);
      $$ = cheerio.load(updatedPage);
    } else {
      selectedText = '1';
      $$ = $;
    }

    const report = [];
    $$('.sg-asp-table-data-row').each(function () {
      const cols = {};
      const keys = [
        'course', 'description', 'period', 'teacher', 'room', 'att_credit', 'ern_credit',
        'first', 'second', 'third', 'exam1', 'sem1', 'fourth', 'fifth', 'sixth', 'exam2',
        'sem2', 'eoy', 'cnd1', 'cnd2', 'cnd3', 'cnd4', 'cnd5', 'cnd6', 'c1', 'c2', 'c3',
        'c4', 'c5', 'exda', 'uexa', 'exdt', 'uext',
      ];
      keys.forEach((key, i) => {
        cols[key] = $$(this).children().eq(i).text().trim();
      });
      report.push(cols);
    });

    report.push({ totalEarnedCredit: $$("[id='plnMain_lblTotalEarnedCredit']").text().trim() });

    const comments = [];
    $$('.sg-asp-table[id="plnMain_dgCommentLegend"] tr:not(.sg-asp-table-header-row)').each(function () {
      comments.push({
        comment: $$(this).children().eq(0).text().trim(),
        commentDescription: $$(this).children().eq(1).text().trim(),
      });
    });

    report.push({ comments });
    reports.push({ reportCardRun: selectedText, report });
  }

  return reports;
}

function extractTranscriptData($) {
  const transcript = {};

  $('td.sg-transcript-group').each((index, element) => {
    const semester = {};

    $(element).find('table > tbody > tr > td > span').each((i, el) => {
      const id = $(el).attr('id') || '';
      if (id.includes('YearValue')) semester.year = $(el).text().trim();
      else if (id.includes('GroupValue')) semester.semester = $(el).text().trim();
      else if (id.includes('GradeValue')) semester.grade = $(el).text().trim();
      else if (id.includes('BuildingValue')) semester.school = $(el).text().trim();
    });

    const courseData = [];
    $(element).find('table:nth-child(2) > tbody > tr').each((i, el) => {
      if ($(el).hasClass('sg-asp-table-header-row') || $(el).hasClass('sg-asp-table-data-row')) {
        const rowData = [];
        $(el).find('td').each((j, cell) => rowData.push($(cell).text().trim()));
        courseData.push(rowData);
      }
    });
    semester.data = courseData;

    $(element).find('table:nth-child(3) > tbody > tr > td > label').each((i, el) => {
      if (($(el).attr('id') || '').includes('CreditValue')) semester.credits = $(el).text().trim();
    });

    transcript[`${semester.year} - Semester ${semester.semester}`] = semester;
  });

  $('#plnMain_rpTranscriptGroup_tblCumGPAInfo tbody > tr.sg-asp-table-data-row').each((index, element) => {
    let text = '';
    let value = '';
    $(element).find('td > span').each((i, el) => {
      const id = $(el).attr('id') || '';
      if (id.includes('GPADescr')) text = $(el).text().trim();
      if (id.includes('GPACum')) value = $(el).text().trim();
      if (id.includes('GPARank')) transcript.rank = $(el).text().trim();
      if (id.includes('GPAQuartile')) transcript.quartile = $(el).text().trim();
    });
    if (text) transcript[text] = value;
  });

  return transcript;
}

async function ipr(session, link) {
  const url = link + HAC_ENDPOINTS.INTERIM_PROGRESS;
  const { data } = await session.get(url);
  checkSessionValidity({ data });
  const progressReports = await extractProgressReports(session, url, cheerio.load(data));
  return { progressReports };
}

async function reportCard(session, link) {
  const url = link + HAC_ENDPOINTS.REPORT_CARDS;
  const { data } = await session.get(url);
  checkSessionValidity({ data });
  const reportCards = await extractReportCards(session, url, cheerio.load(data));
  return { reportCards };
}

async function transcript(session, link) {
  const url = link + HAC_ENDPOINTS.TRANSCRIPT;
  const { data } = await session.get(url);
  checkSessionValidity({ data });
  return { transcriptData: extractTranscriptData(cheerio.load(data)) };
}

export { ipr, reportCard, transcript };
