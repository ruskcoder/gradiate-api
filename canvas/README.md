# Canvas — Instructure LMS

The first platform here that talks to a **documented REST API** instead of
scraping HTML. That changes surprisingly little: it is still a plain registry
object, core still owns routes/sessions/streaming/errors, and the response shapes
are the ones every other platform publishes.

```
POST /canvas/login            { loginType: "token", loginData: { link, token } }
POST /canvas/info
POST /canvas/classes
POST /canvas/single-class     options: { course | class, term }
POST /canvas/teachers
POST /canvas/assignments      LMS-only — see below
```

Everything else in the route table (`/attendance`, `/reportCard`, `/transcript`,
`/ipr`, `/schedule`, `/bellSchedule`) returns core's standard 404: Canvas is a
learning platform, not a student information system, and none of that data
exists in its API. Returning empty shells instead would be worse than a 404,
because a client could not tell "no data" from "not supported".

## Authentication

`loginType: "token"`, implemented once in [`core/auth/token.js`](../core/auth/token.js):

```json
{
  "loginType": "token",
  "loginData": {
    "link": "https://district.instructure.com",
    "token": "1234~abcdef..."
  }
}
```

The user generates the token themselves in Canvas under **Account → Settings →
+ New Access Token**. There is no password, no cookie jar and no SSO flow to
reproduce — the token is the entire credential and is sent as
`Authorization: Bearer <token>` on every request.

Two consequences core handles for this login type:

- The token is **not** in the cookie jar, so a session the client sends back
  deserializes without the header. Core re-stamps it on every reused session,
  reading from `loginData` or from the session's own round-tripped
  `loginMetadata` — so a client can send `{ loginType, session }` with no
  `loginData` at all and it still works.
- A token API answers a rejected credential with an HTTP status and a JSON error
  body, which axios would throw on before the platform ever sees it. The token
  session therefore relaxes `validateStatus`, and [`data/_api.js`](data/_api.js)
  maps the status itself — which is also what lets `isSessionExpired` (a
  body-only hook) recognise a revoked token.

`link` is reduced to the instance origin, so pasting the URL of whatever Canvas
page the user was on works.

## Terms

Canvas's answer to terms is **grading periods**: a flat, dated, non-overlapping
set on the account, inherited by each course. That is genuinely flatter than
PowerSchool's cascading `P1 → C1 → S1 → Y1`, so this platform returns a flat
`termTree` with `hasSubterms: false` rather than inventing a hierarchy the data
does not have.

Alongside them sits a synthetic **`Total`** column carrying the whole-course
grade — the role PowerSchool's `Y1` plays. It appears only when Canvas says it is
meaningful (`totals_for_all_grading_periods_option`, the setting behind the "All
Grading Periods" option in the gradebook), or when there are no grading periods
at all, in which case it is the only grade there is.

`currentTerms` is coarsest-first as always, so the last entry is the finest:
`["Total", "Quarter 2"]`.

## Request budget

`/classes` is one request plus one per grading period that isn't already covered:

| Call | What it gets |
|---|---|
| `GET courses?include[]=total_scores&…` | courses, teachers, school, grading periods, **and** the average in the period in progress |
| `GET users/self/enrollments?grading_period_id=N` | averages for one *other* period (parallel, best-effort) |
| `GET courses/:id/assignment_groups?include[]=assignments&include[]=submission` | categories + weights + assignments + this student's submissions, for one course |

The course call does most of the work through `include[]`; see
[`config/constants.js`](config/constants.js) for the exact list and why each one
is there. A grading period whose lookup fails is left out of `averages` rather
than failing the route — a blank cell beats no gradebook.

## Dates

Canvas timestamps are UTC. An 11:59 PM local due date is stored in the *next* UTC
day across most of the Americas, so formatting in UTC shows every assignment as
due a day late. Dates are rendered in the user's own Canvas time zone, read once
from their profile and cached in `session.cache` — which round-trips to the
client, so it costs one request per login rather than one per call.

Every date is published twice: the raw ISO instant (`dueAt`) for sorting and
relative times on the client, and a preformatted local rendering (`dueDate`,
`dueTime`).

## `/assignments`

The LMS-only route. A gradebook portal only ever shows assignments underneath a
class; Canvas has them as first-class objects, so this returns one flat list
across every course — enough to render "what's due this week" without a
`/single-class` call per class. It shares its fetch with `/single-class` and
differs only in shape and filtering.

| Option | |
|---|---|
| `term` | grading period from `termList` |
| `course` / `class` | limit to one course |
| `status` | one or a list of `upcoming`, `overdue`, `missing`, `late`, `submitted`, `pending`, `graded`, `excused`, `past`, `undated` |
| `dueAfter` / `dueBefore` | ISO date window |
| `ungraded` | `false` drops work that doesn't count toward the grade |
| `includeDescription` | include Canvas's HTML body (off by default — it is frequently enormous) |
| `limit` | cap the returned rows; `counts` still reflects the full match |
| `order` | `due` (default), `recent`, `course` |

`status` is one word for where an assignment stands, resolved in the order a
student reads it — excused, then graded, then submitted, then the due date. Since
"graded" wins once a score exists, filtering by `late`, `missing` or `excused`
also matches the corresponding `badges`, so graded-but-late work still appears.

If a course can't be read (locked, or rate-limited), the rest still come back and
the course is named in `unavailable`, so a client can say "3 of 9 courses
couldn't be read" instead of silently showing a short list.

## Known gaps

- **Teacher emails.** Canvas's course payload returns `UserDisplay` objects,
  which carry no email. Reading one means a course-roster request per course, and
  students frequently aren't permitted to make it — so `/teachers` returns
  `email: ""` rather than costing N requests that usually 403.
- **Observer/parent accounts.** Only the token owner's own enrollments are read.
  Canvas models observed students through `users/self/observees`, which would need
  its own `students` / `studentId` handling like PowerSchool's.
- **`period` and `room`** are always empty. An LMS has no master schedule.

## Files

| File | |
|---|---|
| `index.js` | the registry object |
| `auth/token.js` | link normalization + expired-token detection |
| `config/constants.js` | endpoints, `include[]` lists, pagination and concurrency limits |
| `data/_api.js` | query building, `Link` pagination, error mapping, concurrency pool |
| `data/_courses.js` | the course fetch, the term model, averages, date formatting |
| `data/_gradebook.js` | assignment-group fetching and the two shapes built from it |
| `data/classes.js` `data/info.js` `data/teachers.js` `data/assignments.js` | the routes |
