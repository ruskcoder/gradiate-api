/**
 * Generates the Gradiate OpenAPI 3.1 spec.
 *
 * The API mounts the same core route table under every platform prefix, so the
 * spec is built from two tables — PLATFORMS and OPERATIONS — rather than
 * hand-writing ~30 near-identical path items. Keep both in sync with
 * `core/routes.js` (ROUTE_TABLE) and each platform's `index.js` registry.
 *
 * Output: src/generated/openapi.json (imported by the docs UI) and
 * public/openapi.json (served at /openapi.json for other tooling).
 *
 * Custom extensions used by the docs UI:
 *   x-platforms        top-level platform registry (loginTypes, notes, ...)
 *   x-operations       ordered core operations, shared across platforms
 *   x-operation        on each operation: the core operation key
 *   x-platform         on each operation: the platform id
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// ---------------------------------------------------------------------------
// Platforms
// ---------------------------------------------------------------------------

const PLATFORMS = [
  {
    id: 'hac',
    name: 'HAC',
    fullName: 'Home Access Center',
    mount: '/hac',
    loginTypes: ['credentials', 'classlink', 'classlinkCredentials'],
    exampleLink: 'https://homeaccess.example.org',
    helpers: ['districts'],
    operations: ['info', 'classes', 'singleClass', 'schedule', 'attendance', 'teachers', 'reportCard', 'ipr', 'transcript'],
    summary:
      'PowerSchool eSchoolPlus Home Access Center, common across Texas districts. Supports direct portal credentials and ClassLink SSO (with PIN/image 2FA).',
    notes: [
      'A single HAC host can front several districts. Call `/hac/districts` with the portal link and, if `multiple` is true, pass the chosen district name as `loginData.district`.',
      'Classes include full assignment `scores` (`scoresIncluded: true`) — no follow-up `/single-class` call is needed to show assignments.',
      'Terms are flat run numbers (`"1"`–`"6"`); no `termTree` is returned.',
      '`/attendance` accepts `options.date` as `Month-YYYY` (e.g. `March-2026`) to walk the calendar.',
      '`/ipr` (interim progress reports) exists only on HAC.',
    ],
  },
  {
    id: 'powerschool',
    name: 'PowerSchool',
    fullName: 'PowerSchool Student & Parent Portal',
    mount: '/powerschool',
    loginTypes: ['credentials', 'microsoftSession'],
    exampleLink: 'https://ps.example.k12.us',
    helpers: ['authMethods'],
    operations: ['info', 'classes', 'singleClass', 'schedule', 'bellSchedule', 'attendance', 'teachers', 'reportCard'],
    summary:
      'Guardian portal with multi-student parent accounts, date-driven term columns and Microsoft (Azure AD) sign-in via cookie handoff.',
    notes: [
      'Call `/powerschool/authMethods` first — some districts are credentials-only, others Microsoft-only.',
      '`microsoftSession` login: complete Microsoft sign-in in a browser/WebView, then send the resulting portal cookies as `loginData.cookies`.',
      'Parent accounts: every response carries `students` and the active `studentId`. Pass `options.studentId` to switch child.',
      '`/classes` returns averages only (`scoresIncluded: false`); fetch assignments per class with `/single-class`.',
      'Terms are data-driven (P1/C1/S1/Y1…) and grouped by letter family in `termTree`; `currentTerms` lists every term active today.',
    ],
  },
  {
    id: 'skyward-legacy',
    name: 'Skyward Legacy',
    fullName: 'Skyward Family Access (Skyport)',
    mount: '/skyward-legacy',
    loginTypes: ['credentials'],
    exampleLink: 'https://skyward.example.org/scripts/wsisa.dll/WService=wsEAplus/',
    helpers: [],
    operations: ['info', 'classes', 'singleClass', 'schedule', 'bellSchedule', 'attendance', 'teachers', 'reportCard', 'transcript'],
    summary:
      'Classic Skyward Student & Family Access. Credentials only; term/subterm tabs are reconstructed from the gradebook itself.',
    notes: [
      '`link` is the full `WService=…` base URL of the district’s Family Access.',
      '`/classes` returns averages per term (`scoresIncluded: false`); `/single-class` fetches assignments for one term.',
      'Term labels vary by district (PR1/1ST/SM1, T1–T4, Q1–Q4…). Fall/spring sections of the same course are merged.',
      'No SSO login types and no `/ipr`.',
    ],
  },
  {
    id: 'canvas',
    name: 'Canvas',
    fullName: 'Canvas LMS (Instructure)',
    mount: '/canvas',
    loginTypes: ['token'],
    exampleLink: 'https://district.instructure.com',
    helpers: [],
    operations: ['info', 'classes', 'singleClass', 'teachers', 'assignments'],
    summary:
      'Instructure Canvas, via its documented REST API and a user access token. The only LMS here — no attendance, report cards or transcripts, but assignments are first-class objects with real due dates.',
    notes: [
      'Sign in with `loginType: "token"`. The user generates the token in Canvas under **Account → Settings → + New Access Token**; there is no password and no SSO flow to complete.',
      '`link` is the Canvas instance URL (`https://district.instructure.com`). Any path is discarded, so pasting the URL of whatever page the user was on works.',
      'Terms are Canvas **grading periods** — flat and dated, so `termTree` has no nesting (`hasSubterms: false`). A synthetic `Total` column carries the whole-course grade when the account enables all-grading-period totals, or when there are no grading periods at all.',
      '`/classes` returns averages only (`scoresIncluded: false`); fetch assignments per class with `/single-class`, or across every class at once with `/assignments`.',
      '`/assignments` is Canvas-only: every assignment with due / unlock / lock timestamps, submission state, score and class statistics, filterable by term, course, status and due-date window.',
      'No `/attendance`, `/reportCard`, `/transcript`, `/ipr`, `/schedule` or `/bellSchedule` — Canvas is a learning platform, not a student information system, so those routes return 404.',
      'Teacher emails are not exposed by Canvas’s course payload, so `/teachers` returns `email: ""`.',
    ],
  },
];

// ---------------------------------------------------------------------------
// Shared schemas
// ---------------------------------------------------------------------------

const ref = (name) => ({ $ref: `#/components/schemas/${name}` });

const schemas = {
  LoginType: {
    type: 'string',
    enum: ['credentials', 'classlink', 'classlinkCredentials', 'microsoftSession', 'token'],
    description: 'How to authenticate. Each platform accepts a subset — see the platform pages.',
  },
  CredentialsLoginData: {
    type: 'object',
    title: 'credentials',
    required: ['link', 'username', 'password'],
    properties: {
      link: { type: 'string', format: 'uri', description: 'Base URL of the district portal. `https://` and a trailing slash are added if missing.' },
      username: { type: 'string', description: 'Portal username.' },
      password: { type: 'string', format: 'password', description: 'Portal password.' },
      district: { type: 'string', description: '**HAC only.** District name for multi-district HAC hosts (see `/hac/districts`).' },
    },
  },
  ClassLinkLoginData: {
    type: 'object',
    title: 'classlink',
    required: ['clsession'],
    properties: {
      clsession: { type: 'string', description: 'A valid `clsession` cookie from launchpad.classlink.com.' },
    },
  },
  ClassLinkCredentialsLoginData: {
    type: 'object',
    title: 'classlinkCredentials',
    required: ['username', 'password', 'code'],
    properties: {
      username: { type: 'string', description: 'ClassLink username.' },
      password: { type: 'string', format: 'password', description: 'ClassLink password.' },
      code: { type: 'string', description: 'ClassLink district login code (the `/{code}` in launchpad.classlink.com/{code}).' },
      clMFA: { type: 'string', description: 'Answer to a 2FA challenge: the 6-digit PIN, or the chosen icon filename. Send it on the follow-up call after `mfaRequired`.' },
    },
  },
  MicrosoftSessionLoginData: {
    type: 'object',
    title: 'microsoftSession',
    required: ['link', 'cookies'],
    properties: {
      link: { type: 'string', format: 'uri', description: 'PowerSchool portal base URL.' },
      cookies: {
        description: 'Portal cookies captured after Microsoft sign-in. A `Cookie` header string, `[{name,value}]`, or a `{name: value}` map.',
        oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'object' } }, { type: 'object' }],
      },
      username: { type: 'string', description: 'Optional display username.' },
    },
  },
  TokenLoginData: {
    type: 'object',
    title: 'token',
    required: ['link', 'token'],
    description:
      'API-token sign-in. The token is the whole credential — there is no handshake and no cookie — so it is sent on every request and round-trips inside the `session` envelope.',
    properties: {
      link: {
        type: 'string',
        format: 'uri',
        description: 'Canvas instance URL, e.g. `https://district.instructure.com`. Any path is stripped.',
      },
      token: {
        type: 'string',
        format: 'password',
        description: 'A Canvas user access token (Account → Settings → **+ New Access Token**).',
      },
      username: { type: 'string', description: 'Optional display username.' },
    },
  },
  Session: {
    type: 'object',
    description:
      'Opaque session envelope returned by every authenticated route. Send it back unchanged as `session` to skip re-authentication. Sessions validated within the last 5 minutes are reused with no portal round-trip; older ones are probed and transparently re-logged-in.',
    properties: {
      cookies: { type: 'object', description: 'Serialized tough-cookie jar.' },
      cache: {
        type: 'object',
        properties: {
          lastValidationTime: { type: ['integer', 'null'], description: 'Epoch ms of the last successful validation.' },
          link: { type: 'string', description: 'Resolved portal link (discovered during SSO).' },
          username: { type: 'string' },
          mfaToken: { type: 'string', description: 'Present only mid 2FA challenge.' },
        },
        additionalProperties: true,
      },
      loginMetadata: {
        type: 'object',
        properties: { loginType: ref('LoginType'), loginData: { type: 'object' } },
      },
    },
  },
  AuthenticatedRequest: {
    type: 'object',
    required: ['loginType'],
    properties: {
      loginType: ref('LoginType'),
      loginData: {
        description: 'Credentials for `loginType`. May be omitted when a fresh `session` is supplied (except for SSO logins, which also need it to re-login).',
        oneOf: [ref('CredentialsLoginData'), ref('ClassLinkLoginData'), ref('ClassLinkCredentialsLoginData'), ref('MicrosoftSessionLoginData'), ref('TokenLoginData')],
      },
      session: ref('Session'),
      stream: { type: 'boolean', default: false, description: 'Stream progress updates before the final JSON body. See the Streaming guide.' },
    },
  },
  ErrorResponse: {
    type: 'object',
    required: ['success', 'message'],
    properties: {
      success: { type: 'boolean', const: false },
      status: { type: 'integer', description: 'HTTP status (included on auth/data route errors).' },
      message: { type: 'string' },
    },
  },
  MfaChallenge: {
    type: 'object',
    description: 'Returned with HTTP 200 when a ClassLink login stops at a second factor.',
    properties: {
      success: { type: 'boolean', const: false },
      mfaRequired: { type: 'boolean', const: true },
      mfaType: { type: 'string', enum: ['pin', 'image'] },
      icons: { type: "array", items: { type: "object", properties: { name: { type: "string", description: "Send this as clMFA." }, imageUrl: { type: "string" } }, additionalProperties: true } },
      session: ref('Session'),
    },
  },
  Student: {
    type: 'object',
    properties: { id: { type: 'string' }, name: { type: 'string' }, selected: { type: 'boolean' } },
  },
  TermNode: {
    type: 'object',
    properties: {
      label: { type: 'string' },
      group: { type: 'boolean', description: 'True for a synthetic letter-family root (e.g. all `P*` terms).' },
      children: { type: 'array', items: ref('TermNode') },
    },
  },
  Score: {
    type: 'object',
    properties: {
      name: { type: 'string' },
      category: { type: 'string' },
      dateDue: { type: 'string' },
      dateAssigned: { type: 'string' },
      score: { type: 'string' },
      totalPoints: { type: ['string', 'number'] },
      weight: { type: ['string', 'number'] },
      weightedScore: { type: ['string', 'number'] },
      weightedTotalPoints: { type: ['string', 'number'] },
      percentage: { type: 'string' },
      badges: { type: 'array', items: { type: 'string' }, description: 'e.g. `missing`, `late`, `exempt`.' },
    },
  },
  Class: {
    type: 'object',
    properties: {
      course: { type: 'string', description: 'Course code / id. Use with `options.course` on `/single-class`.' },
      name: { type: 'string', description: 'Course name. Use with `options.class` on `/single-class`.' },
      period: { type: 'string' },
      teacher: { type: 'string' },
      email: { type: 'string' },
      room: { type: 'string' },
      average: { type: 'string', description: 'Average for the selected `term`.' },
      averages: { type: 'object', additionalProperties: { type: 'string' }, description: '**PowerSchool / Skyward.** Average per term label.' },
      scores: { type: 'array', items: ref('Score'), description: '**HAC** on `/classes`; all platforms on `/single-class`.' },
      categories: { type: 'object', additionalProperties: true },
      averageType: { type: 'string', description: 'How the portal computes the average: `percentwise`, `scorewise` or `categorywise`.' },
      code: { type: 'string', description: '**Canvas.** The course code (`MTH401`).' },
      termName: { type: 'string', description: '**Canvas.** The enrollment term the course belongs to (`Fall 2026`).' },
      url: { type: 'string', description: '**Canvas.** Link to the course.' },
    },
  },
  TermFields: {
    type: 'object',
    properties: {
      term: { type: 'string', description: 'The term the data is for.' },
      termList: { type: 'array', items: { type: 'string' }, description: 'Every available term, in portal order.' },
      termsIncluded: { type: 'boolean' },
      hasSubterms: { type: 'boolean' },
      termTree: { type: 'array', items: ref('TermNode'), description: '**PowerSchool / Skyward.** Terms grouped by letter family. **Canvas** returns a flat list (grading periods do not nest).' },
      currentTerms: { type: 'array', items: { type: 'string' }, description: '**PowerSchool / Skyward / Canvas.** All terms active today, coarsest first — the last entry is the finest.' },
    },
  },
  StudentContext: {
    type: 'object',
    description: '**PowerSchool only.** Present on every PowerSchool data response.',
    properties: {
      students: { type: 'array', items: ref('Student') },
      studentId: { type: 'string' },
    },
  },
  Assignment: {
    type: 'object',
    description: '**Canvas only.** One assignment from `/assignments`.',
    properties: {
      id: { type: 'string' },
      course: { type: 'string', description: 'Course id — matches `classes[].course`.' },
      courseName: { type: 'string' },
      courseCode: { type: 'string' },
      name: { type: 'string' },
      category: { type: 'string', description: 'Canvas assignment group (the grade category).' },
      url: { type: 'string', description: 'Link to the assignment in Canvas.' },
      description: { type: 'string', description: 'Canvas’s HTML body. Only present with `options.includeDescription`.' },
      dueAt: { type: ['string', 'null'], format: 'date-time', description: 'Raw ISO instant, for sorting and relative times.' },
      dueDate: { type: 'string', description: '`M/D/YYYY` in the user’s own Canvas time zone.' },
      dueTime: { type: 'string', example: '11:59 PM' },
      unlockAt: { type: ['string', 'null'], format: 'date-time' },
      unlockDate: { type: 'string' },
      lockAt: { type: ['string', 'null'], format: 'date-time' },
      lockDate: { type: 'string' },
      daysUntilDue: { type: ['integer', 'null'], description: 'Negative once the due date has passed.' },
      pointsPossible: { type: ['number', 'null'] },
      gradingType: { type: 'string', enum: ['points', 'percent', 'letter_grade', 'gpa_scale', 'pass_fail', 'not_graded'] },
      submissionTypes: { type: 'array', items: { type: 'string' } },
      published: { type: 'boolean' },
      omitFromFinalGrade: { type: 'boolean' },
      status: {
        type: 'string',
        enum: ['graded', 'submitted', 'pending', 'late', 'missing', 'excused', 'overdue', 'upcoming', 'past', 'undated'],
        description: 'Where the assignment stands, resolved in the order a student reads it: excused, then graded, then submitted, then the due date. Filter with `options.status`.',
      },
      submitted: { type: 'boolean' },
      submittedAt: { type: ['string', 'null'], format: 'date-time' },
      graded: { type: 'boolean' },
      gradedAt: { type: ['string', 'null'], format: 'date-time' },
      attempt: { type: ['integer', 'null'] },
      score: { type: ['number', 'null'] },
      grade: { type: ['string', 'null'], description: 'The score in the assignment’s own scheme (a letter, `complete`, or the number).' },
      percentage: { type: ['string', 'null'] },
      pointsDeducted: { type: ['number', 'null'], description: 'Taken off by the course’s late policy.' },
      badges: { type: 'array', items: { type: 'string' }, description: 'e.g. `missing`, `late`, `exempt`.' },
      statistics: {
        type: ['object', 'null'],
        description: 'Class-wide min/max/mean, when the teacher publishes them.',
        properties: { min: { type: ['number', 'null'] }, max: { type: ['number', 'null'] }, mean: { type: ['number', 'null'] } },
      },
    },
  },
  AttendanceEvent: {
    type: 'object',
    properties: {
      event: { type: 'string' },
      periods: { type: 'array', items: { type: 'string' } },
      classes: { type: 'array', items: { type: 'string' } },
      color: { type: 'string' },
    },
  },
};

// ---------------------------------------------------------------------------
// Options (the `options` object on data routes)
// ---------------------------------------------------------------------------

const OPT = {
  term: { type: 'string', description: 'Term label from `termList`. Defaults to the current term.' },
  class: { type: 'string', description: 'Class name, exactly as returned in `classes[].name`.' },
  course: { type: 'string', description: 'Course id from `classes[].course` (preferred over `class` when both exist).' },
  studentId: { type: 'string', description: 'Which student to fetch for on multi-student parent accounts (from `students[].id`).' },
  date: { type: 'string', example: 'March-2026', description: 'Month to show, formatted `Month-YYYY`.' },
  status: {
    description: 'Keep only assignments in these states. One value or a list; `late`, `missing` and `excused` also match the corresponding `badges`, so graded-but-late work still shows up.',
    oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
    example: 'upcoming',
  },
  dueAfter: { type: 'string', format: 'date-time', description: 'Keep only assignments due at or after this date.' },
  dueBefore: { type: 'string', format: 'date-time', description: 'Keep only assignments due at or before this date.' },
  ungraded: { type: 'boolean', description: 'Set `false` to drop assignments that do not count toward the grade.' },
  includeDescription: { type: 'boolean', description: 'Include each assignment’s HTML body. Off by default — it is frequently very large.' },
  limit: { type: 'integer', description: 'Cap how many assignments are returned, after sorting. `counts` still reflects the full match.' },
  order: { type: 'string', enum: ['due', 'recent', 'course'], default: 'due', description: 'Sort order. Undated work always sorts last.' },
  includeConcluded: { type: 'boolean', description: 'Read concluded enrollments instead of active ones.' },
};

function optionsFor(op, platform) {
  const p = {};
  const req = [];
  if (op === 'classes') p.term = OPT.term;
  if (op === 'singleClass') {
    p.class = OPT.class;
    if (platform !== 'hac') p.course = OPT.course;
    p.term = OPT.term;
    if (platform === 'hac') req.push('class');
  }
  if (op === 'assignments') {
    p.term = OPT.term;
    p.course = OPT.course;
    p.class = OPT.class;
    p.status = OPT.status;
    p.dueAfter = OPT.dueAfter;
    p.dueBefore = OPT.dueBefore;
    p.ungraded = OPT.ungraded;
    p.includeDescription = OPT.includeDescription;
    p.limit = OPT.limit;
    p.order = OPT.order;
  }
  if (op === 'attendance' && platform === 'hac') p.date = OPT.date;
  if (platform === 'canvas' && ['classes', 'singleClass', 'teachers', 'assignments', 'info'].includes(op)) {
    p.includeConcluded = OPT.includeConcluded;
  }
  if (platform === 'powerschool') p.studentId = OPT.studentId;
  if (!Object.keys(p).length) return null;
  return { type: 'object', properties: p, ...(req.length ? { required: req } : {}) };
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

const S = (props, extra = {}) => ({ type: 'object', properties: props, ...extra });
const withEnvelope = (data, platform) => ({
  allOf: [
    S({ success: { type: 'boolean', const: true } }),
    data,
    ...(platform === 'powerschool' && data !== EMPTY ? [ref('StudentContext')] : []),
    S({ session: ref('Session') }),
  ],
});
const EMPTY = S({});

const OPERATIONS = [
  {
    key: 'login',
    path: '/login',
    title: 'Log in',
    group: 'Authentication',
    summary: 'Authenticate and receive a session envelope.',
    description:
      'Authenticates only — no data is fetched. A cheap validation probe runs so a bad password or expired session fails here rather than on your next call. Store the returned `session` and send it with every data request.\n\nFor ClassLink logins that hit a second factor, this returns `mfaRequired` (HTTP 200, `success: false`) — re-call with the returned `session` and `loginData.clMFA`.',
    response: () => EMPTY,
    example: () => ({}),
  },
  {
    key: 'info',
    path: '/info',
    title: 'Student info',
    group: 'Student',
    summary: 'Profile details for the logged-in student.',
    description: 'Name, school, grade and other registration details. Fields a portal does not expose are returned as empty strings.',
    response: (p) =>
      S({
        name: { type: 'string' },
        grade: { type: 'string' },
        school: { type: 'string' },
        district: { type: 'string' },
        dob: { type: 'string' },
        counselor: { type: 'string' },
        language: { type: 'string' },
        ...(p === 'hac' ? { cohortYear: { type: 'string' }, username: { type: 'string' }, firstLoggedIn: { type: ['string', 'null'] } } : {}),
        ...(p === 'canvas'
          ? {
              userId: { type: 'string', description: 'Canvas user id.' },
              username: { type: 'string', description: 'Canvas login id.' },
              email: { type: 'string' },
              avatar: { type: 'string' },
              timeZone: { type: 'string', description: 'The user’s Canvas time zone — every date on this platform is rendered in it.' },
              bio: { type: 'string' },
              courseCount: { type: 'integer' },
              enrollmentTerms: { type: 'array', items: { type: 'string' } },
            }
          : {}),
        link: { type: 'string' },
      }),
    example: (p) => {
      const blank = p === 'powerschool' || p === 'canvas';
      return {
        name: 'Jordan Rivera',
        grade: blank ? '' : '10',
        school: 'Cypress Ridge High School',
        district: p === 'canvas' ? '' : 'Example ISD',
        dob: blank ? '' : '04/12/2010',
        counselor: blank ? '' : 'Smith, Dana',
        language: p === 'canvas' ? 'en' : blank ? '' : 'English',
        ...(p === 'hac' ? { cohortYear: '2028', username: 's123456', firstLoggedIn: '2025-08-14T15:02:11Z' } : {}),
        ...(p === 'canvas'
          ? {
              userId: '4821',
              username: 's123456',
              email: 'jordan@example.k12.us',
              avatar: 'https://district.instructure.com/images/thumbnails/1.png',
              timeZone: 'America/Chicago',
              bio: '',
              courseCount: 7,
              enrollmentTerms: ['Fall 2026'],
            }
          : {}),
        link: PLATFORMS.find((x) => x.id === p).exampleLink + '/',
      };
    },
  },
  {
    key: 'classes',
    path: '/classes',
    title: 'Classes & grades',
    group: 'Grades',
    summary: 'Every class with its average for a term.',
    description:
      'Returns all classes for a term plus the term metadata needed to render a term picker. Pass `options.term` to switch terms; omit it for the current term.\n\n`scoresIncluded` tells you whether each class already carries its assignments (HAC) or whether you need `/single-class` (PowerSchool, Skyward).',
    response: (p) =>
      ({
        allOf: [
          ref('TermFields'),
          S({
            scoresIncluded: { type: 'boolean' },
            classes: { type: 'array', items: ref('Class') },
          }),
        ],
      }),
    example: (p) =>
      p === 'canvas'
        ? {
            scoresIncluded: false,
            termsIncluded: true,
            hasSubterms: false,
            termList: ['Quarter 1', 'Quarter 2', 'Total'],
            termTree: [
              { label: 'Quarter 1', children: [] },
              { label: 'Quarter 2', children: [] },
              { label: 'Total', children: [] },
            ],
            term: 'Quarter 2',
            currentTerms: ['Total', 'Quarter 2'],
            classes: [
              {
                course: '101',
                name: 'AP Calculus BC',
                code: 'MTH401',
                period: '',
                teacher: 'Nguyen, Alex',
                email: '',
                room: '',
                termName: 'Fall 2026',
                url: 'https://district.instructure.com/courses/101',
                averages: { 'Quarter 1': 'B+ 89', 'Quarter 2': 'A 93', Total: 'A- 91.5' },
                average: 'A 93',
              },
            ],
          }
        : p === 'hac'
        ? {
            scoresIncluded: true,
            termList: ['1', '2', '3', '4', '5', '6'],
            term: '2',
            classes: [
              {
                course: '0001A - 110',
                name: 'COMPUTER SCIENCE',
                period: '1',
                teacher: 'Smith, John',
                room: '2100',
                average: '94.20',
                scores: [
                  { dateDue: '09/10/2026', dateAssigned: '09/08/2026', name: 'Recursion Lab', category: 'Major', score: '96.00', totalPoints: '100.00', weight: '1.00', weightedScore: '96.00', weightedTotalPoints: '100.0000', percentage: '96.00%', badges: [] },
                ],
              },
            ],
          }
        : {
            scoresIncluded: false,
            termsIncluded: true,
            hasSubterms: true,
            termList: p === 'powerschool' ? ['P1', 'C1', 'P2', 'C2', 'S1', 'Y1'] : ['PR1', 'PR2', '1ST', 'SM1'],
            termTree:
              p === 'powerschool'
                ? [
                    { label: 'P', group: true, children: [{ label: 'P1', children: [] }, { label: 'P2', children: [] }] },
                    { label: 'C', group: true, children: [{ label: 'C1', children: [] }, { label: 'C2', children: [] }] },
                    { label: 'S1', children: [] },
                    { label: 'Y1', children: [] },
                  ]
                : [
                    { label: 'PR', group: true, children: [{ label: 'PR1', children: [] }, { label: 'PR2', children: [] }] },
                    { label: '1ST', children: [] },
                    { label: 'SM1', children: [] },
                  ],
            term: p === 'powerschool' ? 'P2' : 'PR2',
            currentTerms: p === 'powerschool' ? ['Y1', 'S1', 'C1', 'P2'] : ['SM1', '1ST', 'PR2'],
            classes: [
              {
                course: p === 'powerschool' ? 'MTH401' : '1234_0_1',
                name: 'AP Calculus BC',
                period: '3',
                teacher: 'Nguyen, Alex',
                email: 'anguyen@example.k12.us',
                room: 'B214',
                averages: p === 'powerschool' ? { P1: 'A 95', C1: 'A 94', P2: 'A 93' } : { PR1: '95', PR2: '93' },
                average: p === 'powerschool' ? 'A 93' : '93',
              },
            ],
          },
  },
  {
    key: 'singleClass',
    path: '/single-class',
    title: 'Single class',
    group: 'Grades',
    summary: 'One class with its assignments.',
    description:
      'Fetches one class and its assignment scores for a term. Identify the class with `options.class` (name) or, on PowerSchool and Skyward, `options.course` (id — more reliable when two sections share a name).',
    response: () =>
      ({
        allOf: [ref('TermFields'), S({ scoresIncluded: { type: 'boolean' }, class: ref('Class') })],
      }),
    example: (p) => ({
      scoresIncluded: true,
      termList:
        p === 'hac' ? ['1', '2', '3', '4', '5', '6']
          : p === 'canvas' ? ['Quarter 1', 'Quarter 2', 'Total']
          : p === 'powerschool' ? ['P1', 'C1', 'P2']
          : ['PR1', 'PR2'],
      term: p === 'hac' ? '2' : p === 'canvas' ? 'Quarter 2' : p === 'powerschool' ? 'P2' : 'PR2',
      class: {
        course: p === 'hac' ? '0001A - 110' : p === 'canvas' ? '101' : 'MTH401',
        name: p === 'hac' ? 'COMPUTER SCIENCE' : 'AP Calculus BC',
        period: p === 'canvas' ? '' : '3',
        teacher: 'Nguyen, Alex',
        average: p === 'canvas' ? 'A 93' : '93',
        ...(p === 'canvas' ? { averageType: 'categorywise' } : {}),
        scores: [
          { name: 'Unit 2 Test', category: 'Tests', dateDue: '09/11/2026', dateAssigned: '09/11/2026', score: '45', totalPoints: 50, weight: 1, weightedScore: 45, weightedTotalPoints: 50, percentage: '90%', badges: [] },
          { name: 'Homework 2.4', category: 'Homework', dateDue: '09/09/2026', dateAssigned: '09/08/2026', score: '', totalPoints: 10, weight: 1, weightedScore: '', weightedTotalPoints: 10, percentage: '0%', badges: ['missing'] },
        ],
      },
    }),
  },
  {
    key: 'schedule',
    path: '/schedule',
    title: 'Schedule',
    group: 'Student',
    summary: 'Class schedule rows.',
    description: 'The student’s class schedule. On HAC and Skyward each row is keyed by the portal’s own column headers, so keys can vary between districts.',
    response: () => S({ schedule: { type: 'array', items: { type: 'object', additionalProperties: true } } }),
    example: () => ({
      schedule: [
        { Course: '0001A - 110', Description: 'COMPUTER SCIENCE', Periods: '1', Teacher: 'Smith, John', Room: '2100', Days: 'A', 'Marking Periods': 'Q1, Q2, Q3, Q4', Building: 'Cypress Ridge HS', Status: 'Active' },
      ],
    }),
  },
  {
    key: 'bellSchedule',
    path: '/bellSchedule',
    title: 'Bell schedule',
    group: 'Student',
    summary: 'Period start/end times.',
    description: 'Period timings. PowerSchool groups periods by weekday; Skyward returns one flat list. Returns 404 when the portal has no timed schedule.',
    response: (p) =>
      p === 'powerschool'
        ? S({ bellSchedule: { type: 'array', items: S({ day: { type: 'string' }, periods: { type: 'array', items: S({ period: { type: 'string' }, startTime: { type: 'string' }, endTime: { type: 'string' } }) } }) } })
        : S({ bellSchedule: { type: 'array', items: S({ period: { type: 'string' }, startTime: { type: 'string' }, endTime: { type: 'string' } }) } }),
    example: (p) =>
      p === 'powerschool'
        ? { bellSchedule: [{ day: 'Mon', periods: [{ period: '1', startTime: '8:15 AM', endTime: '9:05 AM' }, { period: '2', startTime: '9:12 AM', endTime: '10:02 AM' }] }] }
        : { bellSchedule: [{ period: '1', startTime: '8:15 AM', endTime: '9:05 AM' }, { period: '2', startTime: '9:12 AM', endTime: '10:02 AM' }] },
  },
  {
    key: 'attendance',
    path: '/attendance',
    title: 'Attendance',
    group: 'Student',
    summary: 'Attendance events for a month.',
    description: 'Attendance events keyed by `MM/DD/YYYY`. HAC walks its calendar to `options.date`; PowerSchool and Skyward return the most recent month with data.',
    response: () =>
      S({
        month: { type: 'string' },
        year: { type: 'string' },
        events: { type: 'object', additionalProperties: { type: 'array', items: ref('AttendanceEvent') } },
      }),
    example: () => ({
      month: 'September',
      year: '2026',
      events: {
        '09/04/2026': [{ event: 'Tardy', periods: ['2'], classes: [], color: '#ffff00' }],
        '09/07/2026': [{ event: 'School Closed', periods: [], classes: [], color: '#cccccc' }],
      },
    }),
  },
  {
    key: 'teachers',
    path: '/teachers',
    title: 'Teachers',
    group: 'Student',
    summary: 'Teachers and contact emails.',
    description: 'One entry per class with the teacher’s name and email.',
    response: () => S({ teachers: { type: 'array', items: S({ class: { type: 'string' }, teacher: { type: 'string' }, email: { type: 'string' } }) } }),
    example: (p) =>
      p === 'canvas'
        ? { teachers: [{ class: 'AP Calculus BC', course: '101', teacher: 'Nguyen, Alex', email: '', room: '', teachers: [{ id: '900', name: 'Nguyen, Alex', avatar: '' }] }] }
        : { teachers: [{ class: 'COMPUTER SCIENCE', teacher: 'Smith, John', email: 'john.smith@example.k12.us' }] },
  },
  {
    key: 'reportCard',
    path: '/reportCard',
    title: 'Report cards',
    group: 'Reports',
    summary: 'Report card grades per grading run.',
    description: 'All published report cards, newest first. Row shapes follow each portal’s report card layout.',
    response: () => S({ reportCards: { type: 'array', items: { type: 'object', additionalProperties: true } } }),
    example: (p) => ({
      reportCards: [
        p === 'skyward-legacy'
          ? { year: '2025-2026', courses: [{ course: 'AP Calculus BC', grades: { PR1: '95', '1ST': '94' } }] }
          : { date: 'Run 1', report: [{ course: '0001A - 110', description: 'COMPUTER SCIENCE', grade: '94' }] },
      ],
    }),
  },
  {
    key: 'ipr',
    path: '/ipr',
    title: 'Progress reports',
    group: 'Reports',
    summary: 'Interim progress reports (HAC only).',
    description: 'Every interim progress report with per-course grades and teacher comment codes.',
    response: () => S({ progressReports: { type: 'array', items: S({ date: { type: 'string' }, report: { type: 'array', items: { type: 'object', additionalProperties: true } } }) } }),
    example: () => ({
      progressReports: [
        { date: '09/26/2026', report: [{ course: '0001A - 110', description: 'COMPUTER SCIENCE', period: '1', teacher: 'Smith, John', room: '2100', grade: '94', com1: 'A1', com2: '', com3: '', com4: '', com5: '' }, { comments: [{ comment: 'A1', commentDescription: 'Excellent work' }] }] },
      ],
    }),
  },
  {
    key: 'transcript',
    path: '/transcript',
    title: 'Transcript',
    group: 'Reports',
    summary: 'Academic history and GPA.',
    description: 'Completed coursework by year/semester. The exact structure mirrors the portal’s transcript page.',
    response: () => S({ transcriptData: { type: 'object', additionalProperties: true } }),
    example: () => ({
      transcriptData: {
        '2025 - Semester 1': { year: '2025', semester: '1', grade: '09', school: 'Cypress Ridge HS', data: [['Course', 'Description', 'Sem1', 'Credits'], ['0001A', 'COMPUTER SCIENCE', '96', '0.5']], credits: '3.5' },
      },
    }),
  },
  {
    key: 'assignments',
    path: '/assignments',
    title: 'Assignments',
    group: 'Grades',
    summary: 'Every assignment across every class, with dates (Canvas only).',
    description:
      'The LMS-only route. A gradebook portal only ever shows assignments underneath a class; Canvas has them as first-class objects with real due / unlock / lock timestamps, submission state and class statistics, so this returns one flat list across every course — enough to render “what’s due this week” without a `/single-class` call per class.\n\nScope it with `options.term` (a grading period), narrow it to one course with `options.course`, and filter with `options.status`, `options.dueAfter` / `options.dueBefore` and `options.limit`. Results are sorted by due date, soonest first, with undated work last; `counts` always reflects the full match even when `limit` truncates the list.\n\n`description` (Canvas’s HTML body) is omitted unless you ask for it — it is frequently enormous. If a course cannot be read (locked, or rate-limited), the rest still come back and the course is named in `unavailable`.',
    response: () => ({
      allOf: [
        ref('TermFields'),
        S({
          counts: {
            type: 'object',
            description: '`total` plus a tally per `status`, over every match (not just the returned page).',
            additionalProperties: { type: 'integer' },
          },
          assignments: { type: 'array', items: ref('Assignment') },
          unavailable: {
            type: 'array',
            description: 'Courses whose assignments could not be read. Absent when everything succeeded.',
            items: S({ course: { type: 'string' }, name: { type: 'string' }, reason: { type: 'string' } }),
          },
        }),
      ],
    }),
    example: () => ({
      termsIncluded: true,
      hasSubterms: false,
      termList: ['Quarter 1', 'Quarter 2', 'Total'],
      termTree: [
        { label: 'Quarter 1', children: [] },
        { label: 'Quarter 2', children: [] },
        { label: 'Total', children: [] },
      ],
      term: 'Quarter 2',
      currentTerms: ['Total', 'Quarter 2'],
      counts: { total: 3, graded: 1, missing: 1, upcoming: 1 },
      assignments: [
        {
          id: '1001',
          course: '101',
          courseName: 'AP Calculus BC',
          courseCode: 'MTH401',
          name: 'Unit 2 Test',
          category: 'Tests',
          url: 'https://district.instructure.com/courses/101/assignments/1001',
          dueAt: '2026-09-12T04:59:00Z',
          dueDate: '9/11/2026',
          dueTime: '11:59 PM',
          unlockAt: null,
          unlockDate: '',
          lockAt: null,
          lockDate: '',
          daysUntilDue: -8,
          pointsPossible: 50,
          gradingType: 'points',
          submissionTypes: ['online_upload'],
          published: true,
          omitFromFinalGrade: false,
          status: 'graded',
          submitted: true,
          submittedAt: '2026-09-11T22:14:00Z',
          graded: true,
          gradedAt: '2026-09-13T15:02:00Z',
          attempt: 1,
          score: 45,
          grade: '45',
          percentage: '90%',
          pointsDeducted: null,
          badges: [],
          statistics: { min: 50, max: 100, mean: 84 },
        },
        {
          id: '1003',
          course: '101',
          courseName: 'AP Calculus BC',
          courseCode: 'MTH401',
          name: 'Homework 2.4',
          category: 'Homework',
          url: 'https://district.instructure.com/courses/101/assignments/1003',
          dueAt: '2026-09-17T04:59:00Z',
          dueDate: '9/16/2026',
          dueTime: '11:59 PM',
          daysUntilDue: -3,
          pointsPossible: 10,
          gradingType: 'points',
          submissionTypes: ['online_text_entry'],
          published: true,
          omitFromFinalGrade: false,
          status: 'missing',
          submitted: false,
          submittedAt: null,
          graded: false,
          gradedAt: null,
          attempt: null,
          score: null,
          grade: null,
          percentage: null,
          pointsDeducted: null,
          badges: ['missing'],
          statistics: null,
        },
      ],
    }),
  },
];

const HELPERS = {
  districts: {
    key: 'districts',
    path: '/districts',
    title: 'List districts',
    group: 'Authentication',
    summary: 'Detect multi-district HAC hosts (no auth).',
    description: 'Given a HAC portal link, reports whether the host fronts several districts. Show a district picker only when `multiple` is true, then send the chosen `name` as `loginData.district`.',
  },
  authMethods: {
    key: 'authMethods',
    path: '/authMethods',
    title: 'Auth methods',
    group: 'Authentication',
    summary: 'Which sign-in methods a district offers (no auth).',
    description: 'Given a PowerSchool portal link, reports whether it accepts username/password, Microsoft SSO, or both — so you only render the buttons that will work.',
  },
};

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

const ERRORS = {
  400: { description: 'Validation error (bad `loginType`, missing params, unsafe link).', content: { 'application/json': { schema: ref('ErrorResponse'), example: { success: false, status: 400, message: 'loginType must be one of: credentials, classlink, classlinkCredentials' } } } },
  401: { description: 'Invalid credentials or expired session that could not be renewed.', content: { 'application/json': { schema: ref('ErrorResponse'), example: { success: false, status: 401, message: 'Invalid session or password' } } } },
  429: { description: 'Rate limit exceeded (120 requests/minute per IP by default).', content: { 'application/json': { schema: ref('ErrorResponse'), example: { success: false, message: 'Too many requests, please slow down.' } } } },
  500: { description: 'Portal changed or unexpected failure.', content: { 'application/json': { schema: ref('ErrorResponse') } } },
};

const SAMPLE_SESSION = {
  cookies: { version: 'tough-cookie@5.0.0', storeType: 'MemoryCookieStore', cookies: [{ key: 'ASP.NET_SessionId', value: '…', domain: 'homeaccess.example.org' }] },
  cache: { lastValidationTime: 1789300000000, link: 'https://homeaccess.example.org/', username: 's123456' },
  loginMetadata: { loginType: 'credentials', loginData: { link: 'https://homeaccess.example.org', username: 's123456' } },
};

const paths = {};

for (const platform of PLATFORMS) {
  for (const h of platform.helpers) {
    const helper = HELPERS[h];
    const response =
      h === 'districts'
        ? S({ success: { type: 'boolean' }, multiple: { type: 'boolean' }, districts: { type: 'array', items: S({ name: { type: 'string' }, value: { type: 'string' } }) } })
        : S({ success: { type: 'boolean' }, credentials: { type: 'boolean' }, microsoft: { type: 'boolean' }, ssoUrl: { type: ['string', 'null'] } });
    const example =
      h === 'districts'
        ? { success: true, multiple: true, districts: [{ name: 'Example ISD', value: 'EX' }, { name: 'Sample CISD', value: 'SC' }] }
        : { success: true, credentials: true, microsoft: true, ssoUrl: 'https://ps.example.k12.us/oauth/login' };
    paths[platform.mount + helper.path] = {
      post: {
        operationId: `${platform.id}-${helper.key}`,
        tags: [platform.name],
        summary: helper.summary,
        description: helper.description,
        'x-operation': helper.key,
        'x-platform': platform.id,
        security: [],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: S({ link: { type: 'string', format: 'uri', description: 'Portal base URL.' } }, { required: ['link'] }),
              example: { link: platform.exampleLink },
            },
          },
        },
        responses: {
          200: { description: 'OK', content: { 'application/json': { schema: response, example } } },
          400: ERRORS[400],
        },
      },
    };
  }

  for (const op of OPERATIONS) {
    if (op.key !== 'login' && !platform.operations.includes(op.key)) continue;
    const options = optionsFor(op.key, platform.id);
    const body = {
      allOf: [
        ref('AuthenticatedRequest'),
        S({ loginType: { type: 'string', enum: platform.loginTypes }, ...(options && op.key !== 'login' ? { options } : {}) }),
      ],
    };
    const primaryLoginType = platform.loginTypes[0];
    const loginData =
      primaryLoginType === 'token'
        ? { link: platform.exampleLink, token: '1234~••••••••' }
        : { link: platform.exampleLink, username: 's123456', password: '••••••••' };
    const responses = {
      200: {
        description: op.key === 'login' ? 'Authenticated (or `MfaChallenge` for ClassLink 2FA).' : 'OK',
        content: {
          'application/json': {
            schema: op.key === 'login' && platform.loginTypes.includes('classlinkCredentials')
              ? { oneOf: [withEnvelope(EMPTY, platform.id), ref('MfaChallenge')] }
              : withEnvelope(op.response(platform.id), platform.id),
            example: {
              success: true,
              ...op.example(platform.id),
              ...(platform.id === 'powerschool' && op.key !== 'login' ? { students: [{ id: '4821', name: 'Jordan Rivera', selected: true }], studentId: '4821' } : {}),
              session: SAMPLE_SESSION,
            },
          },
          'text/event-stream': {
            description: 'When `stream: true`: newline-delimited progress objects separated by blank lines, followed by the final JSON body.',
            schema: { type: 'string' },
            example: '{"percent":4,"message":"Authenticating"}\n\n{"percent":50,"message":"Fetching classes"}\n\n{"success":true,…}',
          },
        },
      },
      ...ERRORS,
    };
    if (op.key !== 'login') {
      responses[404] = { description: 'Resource not found (e.g. no bell schedule) or class not found.', content: { 'application/json': { schema: ref('ErrorResponse') } } };
    }
    paths[platform.mount + op.path] = {
      post: {
        operationId: `${platform.id}-${op.key}`,
        tags: [platform.name],
        summary: op.summary,
        description: op.description,
        'x-operation': op.key,
        'x-platform': platform.id,
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: body,
              example: {
                loginType: primaryLoginType,
                loginData,
                ...(options && op.key !== 'login' ? { options: Object.fromEntries(Object.entries(options.properties).map(([k, v]) => [k, v.example || (k === 'class' ? 'AP Calculus BC' : k === 'term' ? '' : k === 'studentId' ? '4821' : '')])) } : {}),
              },
            },
          },
        },
        responses,
      },
    };
  }
}

const allOperations = [
  ...OPERATIONS.slice(0, 1),
  HELPERS.districts,
  HELPERS.authMethods,
  ...OPERATIONS.slice(1),
].map(({ key, path: p, title, group, summary, description }) => ({
  key,
  path: p,
  title,
  group,
  summary,
  description,
  platforms: PLATFORMS.filter((pl) => (key === 'login' ? true : pl.operations.includes(key) || pl.helpers.includes(key))).map((pl) => pl.id),
}));

const spec = {
  openapi: '3.1.0',
  info: {
    title: 'Gradiate API',
    version: '1.0.0',
    summary: 'One API for student grades across Home Access Center, PowerSchool and Skyward.',
    description:
      'Gradiate logs into school district portals on a student’s behalf and returns clean JSON. Every platform shares the same route table, request shape, session envelope, streaming protocol and error format.',
    license: { name: 'See LICENSE' },
  },
  servers: [{ url: 'https://api.gradiate.app', description: 'Production' }],
  tags: PLATFORMS.map((p) => ({ name: p.name, description: p.summary })),
  paths,
  components: { schemas },
  'x-platforms': PLATFORMS.map(({ id, name, fullName, mount, loginTypes, exampleLink, helpers, operations, summary, notes }) => ({
    id, name, fullName, mount, loginTypes, exampleLink, helpers, operations, summary, notes,
  })),
  'x-operations': allOperations,
};

const out = JSON.stringify(spec, null, 2);
for (const target of ['src/generated/openapi.json', 'public/openapi.json']) {
  const file = path.join(root, target);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, out + '\n');
}
console.log(`openapi.json: ${Object.keys(paths).length} paths`);
