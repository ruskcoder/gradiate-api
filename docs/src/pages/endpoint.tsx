import * as React from "react"
import { Link, Navigate, useParams } from "react-router-dom"
import { CheckIcon, MinusIcon, PlayIcon } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { CodeBlock, CopyButton } from "@/components/code-block"
import { Callout, H2, H3, PrevNext } from "@/components/docs"
import { Md } from "@/components/markdown"
import { Runner } from "@/components/runner"
import { SchemaFields } from "@/components/schema-view"
import {
  flatten,
  getOperation,
  getOperationMeta,
  HELPER_KEYS,
  LOGIN_TYPE_LABEL,
  loginDataSchema,
  methodPath,
  platforms,
} from "@/lib/spec"
import { usePlayground } from "@/lib/store"
import { generateTypes } from "@/lib/typegen"
import { cn } from "@/lib/utils"

/** Platform-specific behaviour worth calling out on an endpoint page. */
const OP_NOTES: Record<string, Record<string, string>> = {
  login: {
    hac: "For multi-district HAC hosts, first call `/hac/districts` and pass the chosen district as `loginData.district`. ClassLink logins may return `mfaRequired`.",
    powerschool: "Call `/powerschool/authMethods` first. For Microsoft districts use `microsoftSession` with the portal cookies captured after sign-in.",
    "skyward-legacy": "Credentials only. `link` is the district’s full `…/WService=…/` Family Access URL.",
  },
  classes: {
    hac: "Assignments are included (`scoresIncluded: true`). Terms are plain run numbers; no `termTree` or `currentTerms`.",
    powerschool: "Averages only — fetch assignments with `/single-class`. Each class has `averages` for every term, and `studentId` switches child on parent accounts.",
    "skyward-legacy": "Averages only — fetch assignments with `/single-class`. Fall/spring sections of one course are merged into a single class.",
  },
  singleClass: {
    hac: "`options.class` (name) is required. HAC has no `course` filter.",
    powerschool: "Prefer `options.course`. `scoresIncluded` is false if the portal’s assignment lookup fails; averages are still returned.",
    "skyward-legacy": "Prefer `options.course`. `options.term` accepts a term or subterm label.",
  },
  attendance: {
    hac: "Pass `options.date` as `Month-YYYY` to page through months.",
    powerschool: "Returns the current month if it has data, otherwise the most recent month.",
    "skyward-legacy": "Returns the most recent month in the attendance history.",
  },
  bellSchedule: {
    powerschool: "Grouped by weekday: `bellSchedule[].day` with its `periods`.",
    "skyward-legacy": "One flat list of periods.",
  },
  schedule: {
    hac: "Row keys come straight from the portal’s column headers.",
    "skyward-legacy": "Each row includes a `Marking Periods` column listing the terms it meets.",
  },
}

function ResponseExample({ example, typeName, schema }: { example: unknown; typeName: string; schema: unknown }) {
  const [tab, setTab] = React.useState("json")
  const types = React.useMemo(() => generateTypes(typeName, schema), [typeName, schema])
  const code = tab === "json" ? JSON.stringify(example, null, 2) : types
  return (
    <Tabs value={tab} onValueChange={(v) => setTab(String(v))}>
      <CodeBlock
        code={code}
        lang={tab === "json" ? "json" : "typescript"}
        maxHeight="480px"
        title={
          <TabsList variant="line" className="h-8">
            <TabsTrigger value="json" className="px-2 text-xs">JSON</TabsTrigger>
            <TabsTrigger value="ts" className="px-2 text-xs">TypeScript</TabsTrigger>
          </TabsList>
        }
      />
    </Tabs>
  )
}

function SupportMatrix({ opKey }: { opKey: string }) {
  const meta = getOperationMeta(opKey)!
  return (
    <div className="grid grid-cols-3 overflow-hidden rounded-lg border text-sm">
      {platforms.map((p) => {
        const ok = meta.platforms.includes(p.id)
        return (
          <Link
            key={p.id}
            to={`/platforms/${p.id}`}
            className={cn("flex min-w-0 items-center gap-1.5 border-r px-2 py-2.5 text-xs last:border-r-0 hover:bg-muted/50 sm:gap-2 sm:px-3 sm:text-sm", !ok && "text-muted-foreground")}
          >
            {ok ? <CheckIcon className="size-4 text-emerald-600 dark:text-emerald-400" /> : <MinusIcon className="size-4" />}
            <span className="truncate">{p.name}</span>
          </Link>
        )
      })}
    </div>
  )
}

export function EndpointPage() {
  const { op: opKey = "" } = useParams()
  const meta = getOperationMeta(opKey)
  const { state, set } = usePlayground()

  const supported = meta?.platforms ?? []
  const platformId = supported.includes(state.platform) ? state.platform : supported[0]

  React.useEffect(() => {
    window.scrollTo({ top: 0 })
  }, [opKey])

  if (!meta) return <Navigate to="/" replace />

  const operation = getOperation(platformId, opKey)
  const isHelper = HELPER_KEYS.has(opKey)
  const requestSchema = flatten(operation.requestBody.content["application/json"].schema)
  const requestExample = operation.requestBody.content["application/json"].example
  const response = operation.responses["200"].content["application/json"]
  const responseSchema = response.schema.oneOf ? response.schema.oneOf[0] : response.schema
  const loginType = state.loginType[platformId] || requestSchema.properties?.loginType?.enum?.[0]
  const note = OP_NOTES[opKey]?.[platformId]
  const path = methodPath(platformId, opKey)

  const errorRows = Object.entries<any>(operation.responses).filter(([code]) => code !== "200")

  return (
    <div className="mx-auto grid w-full max-w-[1400px] gap-10 px-4 py-6 sm:px-8 sm:py-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,30rem)] 2xl:grid-cols-[minmax(0,1fr)_minmax(0,34rem)]">
      {/* ---------------- Middle: description + parameters ---------------- */}
      <article className="min-w-0">
        <div className="mb-2 text-sm font-medium text-muted-foreground">{meta.group}</div>
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">{meta.title}</h1>
        <p className="mt-2 text-base text-muted-foreground sm:text-lg">{meta.summary}</p>

        <div className="mt-6 flex items-center gap-2 rounded-lg border bg-muted/30 py-1 pr-1 pl-2">
          <Badge className="bg-emerald-600 font-mono text-[11px] text-white hover:bg-emerald-600">POST</Badge>
          <code className="min-w-0 flex-1 truncate font-mono text-sm">{path}</code>
          <CopyButton value={path} />
        </div>

        {/* The playground sits below the docs on small screens — offer a shortcut. */}
        <a
          href="#try-it"
          className="mt-3 flex h-9 items-center justify-center gap-2 rounded-lg bg-primary text-sm font-medium text-primary-foreground lg:hidden"
        >
          <PlayIcon className="size-4" /> Try it live
        </a>

        {supported.length > 1 && (
          <div className="mt-6 flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-3">
            <span className="text-sm text-muted-foreground">Platform</span>
            <Tabs value={platformId} onValueChange={(v) => set({ platform: String(v) })} className="no-scrollbar -mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
              <TabsList className="w-max">
                {platforms.map((p) => (
                  <TabsTrigger key={p.id} value={p.id} disabled={!supported.includes(p.id)}>
                    {p.name}
                  </TabsTrigger>
                ))}
              </TabsList>
            </Tabs>
          </div>
        )}

        <Md text={meta.description} className="mt-8 block leading-7 text-muted-foreground" />

        {note && (
          <Callout title={`On ${platforms.find((p) => p.id === platformId)?.name}`}>
            <Md text={note} />
          </Callout>
        )}

        <H2 id="availability">Availability</H2>
        <SupportMatrix opKey={opKey} />

        <H2 id="request-body">Request body</H2>
        {isHelper ? (
          <div className="rounded-lg border px-4">
            <SchemaFields schema={requestSchema} />
          </div>
        ) : (
          <>
            <div className="rounded-lg border px-4">
              <SchemaFields schema={requestSchema} omit={["loginData", "options"]} />
            </div>

            <H3 id="login-data">loginData</H3>
            <p className="mb-3 text-sm text-muted-foreground">
              Fields depend on <code className="inline-code">loginType</code>. Showing{" "}
              <code className="inline-code">{loginType}</code> ({LOGIN_TYPE_LABEL[loginType]}) — change it in the playground.
            </p>
            <div className="rounded-lg border px-4">
              <SchemaFields schema={loginDataSchema(loginType)} omit={platformId === "hac" ? [] : ["district"]} />
            </div>

            {requestSchema.properties.options && opKey !== "login" && (
              <>
                <H3 id="options">options</H3>
                <div className="rounded-lg border px-4">
                  <SchemaFields schema={requestSchema.properties.options} />
                </div>
              </>
            )}
          </>
        )}

        <H3 id="request-example">Example</H3>
        <CodeBlock code={JSON.stringify(requestExample, null, 2)} lang="json" />

        <H2 id="response">Response</H2>
        <div className="rounded-lg border px-4">
          <SchemaFields schema={responseSchema} />
        </div>
        {response.schema.oneOf && (
          <Callout title="Two-factor challenge">
            ClassLink logins that stop at a second factor return <code className="inline-code">mfaRequired: true</code> with{" "}
            <code className="inline-code">mfaType</code> (<code className="inline-code">pin</code> or <code className="inline-code">image</code>) and a
            session. See <Link to="/guides/authentication#two-factor" className="font-medium text-foreground underline underline-offset-4">Authentication</Link>.
          </Callout>
        )}
        <H3 id="response-example">Example</H3>
        <ResponseExample
          example={response.example}
          typeName={`${opKey[0].toUpperCase()}${opKey.slice(1)}Response`}
          schema={response.schema}
        />

        <H2 id="errors">Errors</H2>
        <div className="overflow-hidden rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-20">Status</TableHead>
                <TableHead>Meaning</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {errorRows.map(([code, r]) => (
                <TableRow key={code}>
                  <TableCell className="font-mono">{code}</TableCell>
                  <TableCell className="whitespace-normal text-muted-foreground">
                    <Md text={r.description} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>

        <PrevNext />
      </article>

      {/* ---------------- Right: playground ---------------- */}
      <aside className="min-w-0">
        <div className="lg:sticky lg:top-20 lg:max-h-[calc(100vh-6rem)] lg:overflow-y-auto lg:pb-6 no-scrollbar">
          <Runner opKey={opKey} platformId={platformId} />
        </div>
      </aside>
    </div>
  )
}
