/**
 * Synthetic HAC Assignments.aspx pages, shaped like eSchoolPLUS markup: ASP.NET
 * GridView tables with no <tbody>, whitespace-heavy cells, entity-encoded
 * titles, a viewstate, scripts and a report-card-run dropdown. No real student
 * data. Options switch on the markup variations the fast reader must either
 * handle identically or refuse.
 */

const CATEGORIES = ['Major Grades', 'Minor Grades', 'Daily Work'];

function assignmentRow(c, a, opts) {
  const cat = CATEGORIES[a % 3];
  const score = a % 11 === 0 ? 'Missing' : a % 13 === 5 ? 'Exempt' : (80 + (a % 20)).toFixed(2);
  const name = `Assignment ${a} &amp; Review ${a % 9 === 0 ? '*' : ''}`;
  const link = opts.firstChildSpan
    ? `<span class="x">${name}</span>`
    : `<a href="#" onclick="return false;" title="Title: Essay ${a} > draft&#13;Category: ${cat}">\n            ${name}\n        </a>`;
  const close = opts.omitRowClose ? '' : '</tr>';
  return `
    <tr class="sg-asp-table-data-row${a % 2 ? ' sg-asp-table-data-row-alt' : ''}">
      <td>
        10/${(a % 28) + 1}/2026
      </td><td>
        10/${(a % 27) + 1}/2026
      </td><td>
        ${link}
      </td><td>
        ${cat}
      </td><td>
        ${score}
      </td><td>100.00</td><td>1.00</td><td>${(80 + (a % 20)).toFixed(2)}</td><td>100.00</td><td>
        ${(80 + (a % 20)).toFixed(2)}%
      </td>
    ${close}`;
}

function card(c, opts) {
  let rows = '';
  for (let a = 0; a < (opts.rows ?? 14); a++) rows += assignmentRow(c, a, opts);
  let catRows = '';
  for (const cat of CATEGORIES) {
    catRows += `
        <tr class="sg-asp-table-data-row">
          <td>${cat}</td><td>850.00</td><td>1000.00</td><td>85.000%</td><td>50.0000</td><td>42.50</td>
        </tr>`;
  }
  const tableOpen = `<table class="sg-asp-table" cellspacing="0" border="0" id="plnMain_rptAssigmnetsByCourse_dgCourseAssignments_${c}" style="border-width:0px;border-collapse:collapse;">`;
  const header = `<tr class="sg-asp-table-header-row"><th scope="col">Date Due</th><th scope="col">Date Assigned</th><th scope="col">Assignment</th><th scope="col">Category</th><th scope="col">Score</th><th scope="col">Total Points</th><th scope="col">Weight</th><th scope="col">Weighted Score</th><th scope="col">Weighted Total Points</th><th scope="col">Percentage</th></tr>`;
  const body = opts.explicitTbody ? `<tbody>${header}${rows}</tbody>` : `${header}${rows}`;
  return `
<div class="AssignmentClass">
  <div class="sg-header sg-header-square">
    <a class="sg-header-heading" href="#" onclick="ClassPopUp(this); return false;">
      ${4400 + c} - 1    Course &quot;${c}&quot; Name
    </a>
    <span class="sg-header-sub-heading">(Last Updated: 10/30/2026)</span>
    <span class="sg-header-heading sg-right">Cycle Average 9${c}.37%</span>
  </div>
  <div class="sg-content-grid">
    ${opts.commentInCard ? '<!-- grid -->' : ''}
    ${tableOpen}${body}
    </table>
    <br />
    <div class="sg-asp-table-group">
      <table class="sg-asp-table" cellspacing="0" border="0" id="plnMain_rptAssigmnetsByCourse_dgCourseCategories_${c}">
        <tr class="sg-asp-table-header-row"><td>Category</td><td>Student's Points</td><td>Maximum Points</td><td>Percent</td><td>Category Weight</td><td>Category Points</td></tr>${catRows}
      </table>
    </div>
  </div>
</div>`;
}

function buildAssignmentsPage(opts = {}) {
  const classes = opts.classes ?? 6;
  let cards = '';
  for (let c = 0; c < classes; c++) cards += card(c, opts);
  if (opts.duplicateClass) cards += card(0, { ...opts, rows: 3 });
  const runs = ['ALL', '1-2027', '2-2027', '3-2027', '4-2027'];
  const options = runs.map((v, i) => `<option ${i === 2 ? 'selected="selected" ' : ''}value="${v}">${i === 0 ? '(All Runs)' : `Run ${i}`}</option>`).join('\n      ');
  const select = opts.noSelect ? '' : `
    <select name="ctl00$plnMain$ddlReportCardRuns" id="plnMain_ddlReportCardRuns" class="sg-combo-box">
      ${options}
    </select>`;
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>Home Access Center</title>
<style>.AssignmentClass { margin: 0 }</style>
<script>var html = '<div class="AssignmentClass"><input name="__VIEWSTATE" value="decoy">';</script>
</head>
<body>
<form method="post" action="./Assignments.aspx" id="aspnetForm">
<div class="aspNetHidden">
<input type="hidden" name="__EVENTTARGET" id="__EVENTTARGET" value="" />
<input type="hidden" name="__VIEWSTATE" id="__VIEWSTATE" value="dGhpcyBpcyBhIHZpZXdzdGF0ZQ==/+AB&amp;C" />
<input type="hidden" name="__VIEWSTATEGENERATOR" id="__VIEWSTATEGENERATOR" value="B0093F3C" />
<input type="hidden" name="__EVENTVALIDATION" id="__EVENTVALIDATION" value="ZXZlbnR2YWxpZGF0aW9u" />
</div>
<span class="sg-banner-text">Example ISD</span>
<div id="MainContent">
  <label for="plnMain_ddlReportCardRuns">Report Card Run:</label>${select}
  <div class="sg-content">${cards}
  </div>
</div>
</form>
</body></html>`;
}

export { buildAssignmentsPage };
