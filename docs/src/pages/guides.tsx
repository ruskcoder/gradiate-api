import { Link, Navigate, useParams } from "react-router-dom"
import { ArrowRightIcon, BlocksIcon, KeyRoundIcon, LayersIcon, RadioIcon, RefreshCwIcon, ZapIcon } from "lucide-react"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { CodeBlock } from "@/components/code-block"
import { C, Callout, DocsPage, H2, H3, P, PageHeader, UL } from "@/components/docs"
import { operations, platforms } from "@/lib/spec"

/* -------------------------------------------------------------------------- */
/*                                Introduction                                */
/* -------------------------------------------------------------------------- */

export function OverviewPage() {
  const cards = [
    { title: "Quickstart", body: "Log in and fetch grades in two requests.", href: "/guides/quickstart", icon: ZapIcon },
    { title: "Authentication", body: "Credentials, ClassLink, 2FA and Microsoft.", href: "/guides/authentication", icon: KeyRoundIcon },
    { title: "Platforms", body: "What differs between HAC, PowerSchool and Skyward.", href: "/platforms", icon: LayersIcon },
  ]
  const core = [
    ["One route table", "Same paths and request body on every platform"],
    ["Session envelope", "Reusable sessions with transparent re-login"],
    ["Login types", "ClassLink SSO, 2FA and Microsoft cookie handoff"],
    ["Streaming", "Progress updates while portals load"],
    ["Errors & limits", "One error shape, one rate limiter"],
  ]
  return (
    <DocsPage>
      <PageHeader
        eyebrow="Gradexis API"
        title="One API for every student portal"
        description="Gradexis logs into school district portals on a student’s behalf and returns clean, consistent JSON — grades, assignments, schedules, attendance and reports."
      />

      <div className="grid gap-4 sm:grid-cols-3">
        {cards.map((c) => (
          <Link key={c.href} to={c.href} className="group rounded-xl border p-4 transition-colors hover:bg-muted/50">
            <c.icon className="size-5 text-muted-foreground" />
            <div className="mt-3 flex items-center gap-1 font-medium">
              {c.title}
              <ArrowRightIcon className="size-3.5 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
            </div>
            <p className="mt-1 text-sm text-muted-foreground">{c.body}</p>
          </Link>
        ))}
      </div>

      <H2>How it’s built</H2>
      <P>
        The API is split into a shared <strong>core</strong> and thin <strong>platform</strong> adapters. Core owns every public route and all the
        plumbing; a platform only knows how to log into its portal and parse its pages. That’s why learning one platform teaches you all of them.
      </P>

      <div className="mt-6 grid gap-3 rounded-xl border bg-muted/20 p-4 md:grid-cols-[1.1fr_auto_1fr] md:items-stretch">
        <div className="rounded-lg border bg-background p-4">
          <div className="flex items-center gap-2 text-sm font-medium">
            <BlocksIcon className="size-4" /> Core · shared by all
          </div>
          <ul className="mt-3 space-y-2.5">
            {core.map(([t, d]) => (
              <li key={t} className="text-sm">
                <div className="font-medium">{t}</div>
                <div className="text-muted-foreground">{d}</div>
              </li>
            ))}
          </ul>
        </div>
        <div className="hidden items-center text-muted-foreground md:flex">
          <ArrowRightIcon className="size-4" />
        </div>
        <div className="grid gap-3">
          {platforms.map((p) => (
            <Link key={p.id} to={`/platforms/${p.id}`} className="rounded-lg border bg-background p-3 transition-colors hover:bg-muted/50">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium">{p.name}</span>
                <code className="font-mono text-xs text-muted-foreground">{p.mount}</code>
              </div>
              <div className="mt-1 text-xs text-muted-foreground">
                {p.operations.length} data routes · {p.loginTypes.join(", ")}
              </div>
            </Link>
          ))}
        </div>
      </div>

      <H2>Base URL & conventions</H2>
      <UL>
        <li>
          Every platform lives under its own prefix: <C>/hac</C>, <C>/powerschool</C>, <C>/skyward-legacy</C>.
        </li>
        <li>
          All data routes are <C>POST</C> with a JSON body — credentials never go in the URL.
        </li>
        <li>
          Successful responses include <C>success: true</C> and a <C>session</C> you should send back on the next call.
        </li>
        <li>
          The full machine-readable spec is at{" "}
          <a href="/openapi.json" className="font-medium text-foreground underline underline-offset-4">/openapi.json</a> (OpenAPI 3.1).
        </li>
      </UL>

      <H2>Endpoints</H2>
      <div className="overflow-hidden rounded-lg border">
        <Table>
          <TableBody>
            {operations.map((o) => (
              <TableRow key={o.key}>
                <TableCell className="w-40">
                  <Link to={`/api/${o.key}`} className="font-mono text-[13px] hover:underline">{o.path}</Link>
                </TableCell>
                <TableCell className="whitespace-normal text-muted-foreground">{o.summary}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </DocsPage>
  )
}

/* -------------------------------------------------------------------------- */
/*                                   Guides                                   */
/* -------------------------------------------------------------------------- */

function Quickstart() {
  return (
    <>
      <PageHeader eyebrow="Getting started" title="Quickstart" description="Log in once, then fetch data with the session you get back." />

      <H2>1. Log in</H2>
      <P>
        Pick your platform and send the portal credentials to <C>/login</C>. You’ll get back a <C>session</C> object — store it.
      </P>
      <CodeBlock
        lang="bash"
        title="Terminal"
        code={`curl -X POST https://your-api-host/hac/login \\
  -H 'Content-Type: application/json' \\
  -d '{
    "loginType": "credentials",
    "loginData": {
      "link": "https://homeaccess.example.org",
      "username": "s123456",
      "password": "••••••••"
    }
  }'`}
      />
      <CodeBlock
        lang="json"
        title="Response"
        className="mt-3"
        code={`{
  "success": true,
  "session": {
    "cookies": { "…": "…" },
    "cache": { "lastValidationTime": 1789300000000, "link": "https://homeaccess.example.org/" },
    "loginMetadata": { "loginType": "credentials", "loginData": { "…": "…" } }
  }
}`}
      />

      <H2>2. Fetch grades</H2>
      <P>
        Send the same <C>loginType</C> and <C>loginData</C> plus the <C>session</C>. A session validated in the last five minutes is used directly
        — no portal login happens.
      </P>
      <CodeBlock
        lang="python"
        title="Python"
        code={`import requests

API = "https://your-api-host/hac"
auth = {
    "loginType": "credentials",
    "loginData": {"link": "https://homeaccess.example.org", "username": "s123456", "password": "••••••••"},
}

session = requests.post(f"{API}/login", json=auth).json()["session"]

res = requests.post(f"{API}/classes", json={**auth, "session": session}).json()
session = res["session"]  # always keep the newest session

for c in res["classes"]:
    print(c["name"], c["average"])`}
      />

      <Callout title="Always send loginData too">
        If the saved session has expired, the API transparently logs in again using <C>loginData</C> and returns the new session — your request
        still succeeds. Without <C>loginData</C> that re-login can’t happen.
      </Callout>

      <H2>3. Try it here</H2>
      <P>
        Every endpoint page has a live playground. Log in on <Link to="/api/login" className="font-medium text-foreground underline underline-offset-4">Log in</Link>{" "}
        and the session is saved in your browser and reused on every other endpoint automatically.
      </P>
    </>
  )
}

function Authentication() {
  return (
    <>
      <PageHeader eyebrow="Getting started" title="Authentication" description="Four login types, one request shape." />
      <P>
        Every authenticated route takes a <C>loginType</C> and matching <C>loginData</C>. Core validates the type against the platform, then
        dispatches to the right flow.
      </P>

      <div className="mt-6 overflow-x-auto rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>loginType</TableHead>
              <TableHead>loginData</TableHead>
              <TableHead>Platforms</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {[
              ["credentials", "link, username, password (+ district on HAC)"],
              ["classlink", "clsession"],
              ["classlinkCredentials", "username, password, code, clMFA?"],
              ["microsoftSession", "link, cookies"],
            ].map(([t, d]) => (
              <TableRow key={t}>
                <TableCell className="font-mono text-[13px]">{t}</TableCell>
                <TableCell className="whitespace-normal text-muted-foreground">{d}</TableCell>
                <TableCell className="text-muted-foreground">
                  {platforms.filter((p) => p.loginTypes.includes(t)).map((p) => p.name).join(", ")}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <H2>Portal credentials</H2>
      <P>
        The student’s own portal username and password, plus the portal <C>link</C>. The link is normalised — <C>https://</C> and a trailing slash
        are added — and private/loopback hosts are rejected.
      </P>
      <Callout title="HAC hosts with several districts">
        Some HAC hosts serve multiple districts. Call <Link to="/api/districts" className="font-medium text-foreground underline underline-offset-4">/hac/districts</Link>{" "}
        with the link; if <C>multiple</C> is true, show a picker and send the chosen name as <C>loginData.district</C>.
      </Callout>

      <H2>ClassLink</H2>
      <P>
        HAC supports signing in through ClassLink. Core logs into ClassLink, opens the district’s app catalog and follows the tile for the platform —
        the student never enters a portal password.
      </P>
      <UL>
        <li>
          <C>classlink</C> — you already have a <C>clsession</C> cookie.
        </li>
        <li>
          <C>classlinkCredentials</C> — ClassLink username, password and district <C>code</C>.
        </li>
      </UL>

      <H3 id="two-factor">Two-factor challenges</H3>
      <P>
        If ClassLink asks for a second factor, the response is <strong>HTTP 200</strong> with <C>success: false</C>:
      </P>
      <CodeBlock
        lang="json"
        code={`{
  "success": false,
  "mfaRequired": true,
  "mfaType": "image",
  "icons": [{ "name": "apple.png", "imageUrl": "https://filescdn.classlink.com/…/apple.png" }, { "name": "rocket.png", "imageUrl": "…" }],
  "session": { "cache": { "mfaToken": "…" }, "…": "…" }
}`}
      />
      <P>
        Show the PIN input or the icon grid, then repeat the same request with the returned <C>session</C> and{" "}
        <C>loginData.clMFA</C> set to the PIN or the chosen icon’s <C>name</C>. Keep <C>clMFA</C> in your stored loginData so silent re-logins can
        clear the factor again.
      </P>

      <H2>Microsoft (PowerSchool)</H2>
      <P>
        Districts that federate PowerSchool to Microsoft use a cookie handoff. Call{" "}
        <Link to="/api/authMethods" className="font-medium text-foreground underline underline-offset-4">/powerschool/authMethods</Link> to see
        whether a district offers it, complete Microsoft sign-in in a browser or WebView at <C>ssoUrl</C>, then send the resulting portal cookies as{" "}
        <C>loginData.cookies</C> with <C>loginType: "microsoftSession"</C>.
      </P>
    </>
  )
}

function Sessions() {
  return (
    <>
      <PageHeader eyebrow="Getting started" title="Sessions" description="Skip re-authentication by sending back the session envelope." />
      <P>
        Every authenticated response ends with a <C>session</C> object: the portal cookie jar, a small cache and the login recipe. Treat it as
        opaque and send the whole thing back unchanged.
      </P>
      <CodeBlock
        lang="json"
        code={`"session": {
  "cookies": { "version": "tough-cookie@5.0.0", "cookies": [ … ] },
  "cache": {
    "lastValidationTime": 1789300000000,
    "link": "https://homeaccess.example.org/",
    "username": "s123456"
  },
  "loginMetadata": { "loginType": "credentials", "loginData": { … } }
}`}
      />

      <H2>How reuse works</H2>
      <div className="mt-4 grid gap-3">
        {[
          { icon: ZapIcon, t: "Fresh (under 5 minutes)", d: "Used immediately. No request to the portal just to check the login." },
          { icon: RefreshCwIcon, t: "Older", d: "One cheap probe of the portal home page. If still logged in, it’s reused and re-stamped." },
          { icon: KeyRoundIcon, t: "Expired", d: "A full login runs with loginData — even mid-request — and the new session is returned." },
        ].map((s) => (
          <div key={s.t} className="flex gap-3 rounded-lg border p-4">
            <s.icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            <div>
              <div className="text-sm font-medium">{s.t}</div>
              <div className="text-sm text-muted-foreground">{s.d}</div>
            </div>
          </div>
        ))}
      </div>

      <H2>Rules</H2>
      <UL>
        <li>
          <strong>Replace, don’t merge.</strong> Store the session from the latest response; it may be a brand-new one after a re-login.
        </li>
        <li>
          <strong>Send loginData alongside it</strong> so an expired session can be renewed transparently.
        </li>
        <li>
          For ClassLink logins the portal link is discovered during SSO and kept in <C>cache.link</C> — this is what lets a reused session skip the
          whole SSO flow.
        </li>
        <li>
          Client-supplied <C>cache.link</C> is re-validated server-side; an unsafe host is ignored and a fresh login runs.
        </li>
      </UL>
    </>
  )
}

function Streaming() {
  return (
    <>
      <PageHeader eyebrow="Getting started" title="Streaming progress" description="Show a progress bar while slow portals load." />
      <P>
        Portal scraping can take several seconds. Add <C>"stream": true</C> to any authenticated request and the response body becomes a sequence of
        progress objects separated by blank lines, ending with the normal JSON response.
      </P>
      <CodeBlock
        lang="bash"
        title="Response body"
        code={`{"percent":4,"message":"Authenticating"}

{"percent":50,"message":"Fetching classes"}

{"percent":75,"message":"Parsing grades"}

{"success":true,"term":"P2","classes":[…],"session":{…}}`}
      />
      <Callout variant="warning" title="Status codes while streaming">
        Headers are sent as soon as the stream starts, so the HTTP status is usually 200 even when the request fails. Always check{" "}
        <C>success</C> in the final object.
      </Callout>

      <H2>Reading the stream</H2>
      <CodeBlock
        lang="javascript"
        title="JavaScript"
        code={`const res = await fetch(url, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ ...auth, session, stream: true }),
});

const reader = res.body.getReader();
const decoder = new TextDecoder();
let buffer = "";

for (;;) {
  const { value, done } = await reader.read();
  if (done) break;
  buffer += decoder.decode(value, { stream: true });
  const parts = buffer.split("\\n\\n");
  buffer = parts.pop();                       // last part may be incomplete
  for (const p of parts) {
    const { percent, message } = JSON.parse(p);
    updateProgress(percent, message);
  }
}

const result = JSON.parse(buffer);            // the final response`}
      />
      <CodeBlock
        lang="python"
        title="Python"
        className="mt-3"
        code={`import json, requests

with requests.post(url, json={**auth, "session": session, "stream": True}, stream=True) as r:
    buffer = ""
    for chunk in r.iter_content(chunk_size=None, decode_unicode=True):
        buffer += chunk
        *parts, buffer = buffer.split("\\n\\n")
        for p in parts:
            print(json.loads(p)["message"])

result = json.loads(buffer)`}
      />
    </>
  )
}

function Terms() {
  return (
    <>
      <PageHeader eyebrow="Getting started" title="Terms" description="Grading periods, their grouping, and which ones are active now." />
      <P>
        <C>/classes</C> and <C>/single-class</C> return term metadata so you can build a term picker without hard-coding district calendars.
      </P>
      <div className="mt-6 overflow-x-auto rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Field</TableHead>
              <TableHead>Meaning</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {[
              ["term", "The term this response is for. Pass any termList entry as options.term to switch."],
              ["termList", "Every term column in portal order, e.g. P1 C1 P2 C2 S1 Y1."],
              ["termTree", "Terms grouped by letter family. Families with several entries get a synthetic root with group: true."],
              ["hasSubterms", "True when termTree has any children — render a second tab row."],
              ["currentTerms", "All terms active today, coarsest first. The last entry is the most specific current term."],
            ].map(([f, m]) => (
              <TableRow key={f}>
                <TableCell className="font-mono text-[13px]">{f}</TableCell>
                <TableCell className="whitespace-normal text-muted-foreground">{m}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <H2>Example</H2>
      <CodeBlock
        lang="json"
        code={`{
  "termList": ["P1", "C1", "P2", "C2", "S1", "Y1"],
  "termTree": [
    { "label": "P", "group": true, "children": [{ "label": "P1", "children": [] }, { "label": "P2", "children": [] }] },
    { "label": "C", "group": true, "children": [{ "label": "C1", "children": [] }, { "label": "C2", "children": [] }] },
    { "label": "S1", "children": [] },
    { "label": "Y1", "children": [] }
  ],
  "term": "P2",
  "currentTerms": ["Y1", "S1", "C1", "P2"]
}`}
      />

      <H2>Recommended UI</H2>
      <UL>
        <li>Default the selected tab to the last entry of <C>currentTerms</C> (fall back to <C>term</C>).</li>
        <li>Render <C>termTree</C> roots as tabs; when a root has <C>group: true</C>, render its children as sub-tabs.</li>
        <li>For grade-change notifications, compare averages for every term in <C>currentTerms</C>, not only the finest one.</li>
      </UL>
      <Callout title="Platform support">
        <C>termTree</C> and <C>currentTerms</C> are returned by PowerSchool and Skyward Legacy. HAC returns a flat <C>termList</C> of run numbers.
      </Callout>
    </>
  )
}

function Errors() {
  return (
    <>
      <PageHeader eyebrow="Getting started" title="Errors & limits" description="One error format across every route and platform." />
      <CodeBlock
        lang="json"
        code={`{
  "success": false,
  "status": 401,
  "message": "Invalid session or password"
}`}
      />
      <H2>Status codes</H2>
      <div className="overflow-x-auto rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-20">Status</TableHead>
              <TableHead>When</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {[
              ["200", "Success — or a ClassLink 2FA challenge (success: false, mfaRequired: true)."],
              ["400", "Invalid JSON, unsupported loginType, missing parameters, or an unsafe portal link."],
              ["401", "Wrong credentials, wrong 2FA answer, or an expired session that could not be renewed."],
              ["404", "The platform doesn’t support this route, the class wasn’t found, or the portal has no such data."],
              ["429", "Rate limit exceeded."],
              ["500", "Unexpected failure — usually the portal changed its markup. Internal details are never exposed."],
            ].map(([s, m]) => (
              <TableRow key={s}>
                <TableCell className="font-mono">{s}</TableCell>
                <TableCell className="whitespace-normal text-muted-foreground">{m}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <H2>Rate limits</H2>
      <P>
        Requests are limited per client IP to <strong>120 per minute</strong> by default (configurable by the operator with{" "}
        <C>RATE_LIMIT_PER_MIN</C>). Limit state is exposed through standard <C>RateLimit</C> headers (IETF draft 7).
      </P>
      <Callout title="Be kind to portals">
        Every data request makes real requests to a school district’s portal. Reuse sessions, avoid polling faster than you need, and prefer one{" "}
        <C>/classes</C> call over many <C>/single-class</C> calls where the platform includes scores.
      </Callout>

      <H2>Request limits</H2>
      <UL>
        <li>JSON bodies are capped at 256 KB.</li>
        <li>
          Portal links must be public <C>http(s)</C> hosts — loopback, link-local and private ranges are rejected with <C>400</C>.
        </li>
      </UL>

      <H2 id="streaming-errors">
        <RadioIcon className="size-5 text-muted-foreground" /> Errors while streaming
      </H2>
      <P>
        With <C>stream: true</C> the error object is the final chunk of the body. Check <C>success</C> rather than the HTTP status.
      </P>
    </>
  )
}

const GUIDE_PAGES: Record<string, () => React.ReactNode> = {
  quickstart: Quickstart,
  authentication: Authentication,
  sessions: Sessions,
  streaming: Streaming,
  terms: Terms,
  errors: Errors,
}

export function GuidePage() {
  const { slug = "" } = useParams()
  const Page = GUIDE_PAGES[slug]
  if (!Page) return <Navigate to="/" replace />
  return (
    <DocsPage key={slug}>
      <Page />
    </DocsPage>
  )
}
