import { Link, Navigate, useNavigate, useParams } from "react-router-dom"
import { ArrowRightIcon, CheckIcon, MinusIcon } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Callout, DocsPage, H2, PageHeader, P } from "@/components/docs"
import { Md } from "@/components/markdown"
import { LOGIN_TYPE_LABEL, operations, platforms } from "@/lib/spec"
import { usePlayground } from "@/lib/store"

function Yes() {
  return <CheckIcon className="mx-auto size-4 text-emerald-600 dark:text-emerald-400" />
}
function No() {
  return <MinusIcon className="mx-auto size-4 text-muted-foreground/60" />
}

const FEATURES: { label: string; values: Record<string, boolean | string> }[] = [
  { label: "Assignments in /classes", values: { hac: true, powerschool: false, "skyward-legacy": false } },
  { label: "termTree / currentTerms", values: { hac: false, powerschool: true, "skyward-legacy": true } },
  { label: "Multi-student accounts", values: { hac: false, powerschool: true, "skyward-legacy": false } },
  { label: "ClassLink SSO + 2FA", values: { hac: true, powerschool: false, "skyward-legacy": false } },
  { label: "Microsoft sign-in", values: { hac: false, powerschool: true, "skyward-legacy": false } },
  { label: "Multi-district hosts", values: { hac: true, powerschool: false, "skyward-legacy": false } },
]

export function ComparisonPage() {
  const allLoginTypes = Object.keys(LOGIN_TYPE_LABEL)
  return (
    <DocsPage>
      <PageHeader
        eyebrow="Platforms"
        title="Platform comparison"
        description="Every platform speaks the same API. This is where they differ."
      />

      <div className="grid gap-4 sm:grid-cols-3">
        {platforms.map((p) => (
          <Link key={p.id} to={`/platforms/${p.id}`} className="group rounded-xl border p-4 transition-colors hover:bg-muted/50">
            <div className="flex items-center justify-between">
              <div className="font-medium">{p.name}</div>
              <ArrowRightIcon className="size-4 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
            </div>
            <code className="mt-1 block font-mono text-xs text-muted-foreground">{p.mount}</code>
            <p className="mt-3 text-sm text-muted-foreground">{p.fullName}</p>
          </Link>
        ))}
      </div>

      <H2>Endpoints</H2>
      <P>
        A platform that doesn’t implement a route still mounts it and answers <code className="inline-code">404</code> with{" "}
        <code className="inline-code">"&lt;Platform&gt; does not support &lt;route&gt;"</code>, so clients can feature-detect.
      </P>
      <MatrixTable
        rows={operations.map((o) => ({
          label: (
            <Link to={`/api/${o.key}`} className="font-mono text-[13px] hover:underline">
              {o.path}
            </Link>
          ),
          values: Object.fromEntries(platforms.map((p) => [p.id, o.platforms.includes(p.id)])),
        }))}
      />

      <H2>Login types</H2>
      <MatrixTable
        rows={allLoginTypes.map((t) => ({
          label: (
            <span>
              <code className="font-mono text-[13px]">{t}</code>
              <span className="ml-2 text-muted-foreground">{LOGIN_TYPE_LABEL[t]}</span>
            </span>
          ),
          values: Object.fromEntries(platforms.map((p) => [p.id, p.loginTypes.includes(t)])),
        }))}
      />

      <H2>Behaviour</H2>
      <MatrixTable rows={FEATURES.map((f) => ({ label: f.label, values: f.values }))} />

      <Callout title="Everything else is shared">
        Request shape, the session envelope and reuse rules, transparent re-login, streaming progress, the error format and rate limits are
        implemented once in core and behave identically on every platform.
      </Callout>
    </DocsPage>
  )
}

function MatrixTable({ rows }: { rows: { label: React.ReactNode; values: Record<string, boolean | string> }[] }) {
  return (
    <div className="overflow-x-auto rounded-lg border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead />
            {platforms.map((p) => (
              <TableHead key={p.id} className="w-20 text-center text-xs sm:w-32 sm:text-sm">{p.name}</TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r, i) => (
            <TableRow key={i}>
              <TableCell>{r.label}</TableCell>
              {platforms.map((p) => (
                <TableCell key={p.id} className="text-center">{r.values[p.id] ? <Yes /> : <No />}</TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}

export function PlatformPage() {
  const { id } = useParams()
  const platform = platforms.find((p) => p.id === id)
  const { set } = usePlayground()
  const navigate = useNavigate()
  if (!platform) return <Navigate to="/platforms" replace />

  const openEndpoint = (key: string) => {
    set({ platform: platform.id })
    navigate(`/api/${key}`)
  }

  const endpoints = operations.filter((o) => o.platforms.includes(platform.id))

  return (
    <DocsPage>
      <PageHeader eyebrow="Platforms" title={platform.name} description={platform.summary}>
        <div className="mt-5 flex flex-wrap gap-2">
          <Badge variant="outline" className="font-mono">{platform.mount}</Badge>
          {platform.loginTypes.map((t) => (
            <Badge key={t} variant="secondary" className="font-mono">{t}</Badge>
          ))}
        </div>
      </PageHeader>

      <H2>Things to know</H2>
      <ul className="space-y-3">
        {platform.notes.map((n, i) => (
          <li key={i} className="flex gap-3 text-muted-foreground">
            <span className="mt-2.5 size-1.5 shrink-0 rounded-full bg-muted-foreground/40" />
            <Md text={n} className="leading-7" />
          </li>
        ))}
      </ul>

      <H2>Endpoints</H2>
      <div className="overflow-hidden rounded-lg border">
        <Table>
          <TableBody>
            {endpoints.map((o) => (
              <TableRow key={o.key} className="cursor-pointer" onClick={() => openEndpoint(o.key)}>
                <TableCell className="w-16">
                  <span className="rounded bg-emerald-500/10 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-emerald-700 dark:text-emerald-400">POST</span>
                </TableCell>
                <TableCell className="font-mono text-[13px]">{platform.mount + o.path}</TableCell>
                <TableCell className="hidden text-muted-foreground sm:table-cell">{o.summary}</TableCell>
                <TableCell className="w-8">
                  <ArrowRightIcon className="size-4 text-muted-foreground" />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <H2>Login data</H2>
      <P>
        Every login type this platform accepts, and what goes in <code className="inline-code">loginData</code>:
      </P>
      <ul className="mt-4 space-y-2 text-sm">
        {platform.loginTypes.map((t) => (
          <li key={t} className="rounded-lg border p-3">
            <code className="font-mono font-medium">{t}</code>
            <span className="ml-2 text-muted-foreground">
              {t === "credentials" && `link, username, password${platform.id === "hac" ? ", district?" : ""}`}
              {t === "classlink" && "clsession"}
              {t === "classlinkCredentials" && "username, password, code, clMFA?"}
              {t === "microsoftSession" && "link, cookies, username?"}
            </span>
          </li>
        ))}
      </ul>
    </DocsPage>
  )
}
