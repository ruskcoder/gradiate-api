import * as React from "react"
import { KeyRoundIcon, Loader2Icon, PlayIcon, ServerIcon, Trash2Icon } from "lucide-react"
import { toast } from "sonner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Textarea } from "@/components/ui/textarea"
import { CodeBlock } from "@/components/code-block"
import { generateSnippet, LANGUAGES, type Body } from "@/lib/codegen"
import {
  flatten,
  getOperation,
  getPlatform,
  HELPER_KEYS,
  LOGIN_TYPE_LABEL,
  loginDataSchema,
  methodPath,
} from "@/lib/spec"
import { usePlayground } from "@/lib/store"
import { cn } from "@/lib/utils"

interface RunResult {
  status: number
  ok: boolean
  ms: number
  body: string
  error?: string
}

function SectionLabel({ children, icon }: { children: React.ReactNode; icon?: React.ReactNode }) {
  return (
    <div className="flex items-center gap-1.5 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
      {icon}
      {children}
    </div>
  )
}

function FieldRow({ label, required, children, hint }: { label: string; required?: boolean; children: React.ReactNode; hint?: string }) {
  return (
    <div className="grid gap-1.5">
      <Label className="font-mono text-xs">
        {label}
        {required && <span className="text-red-600 dark:text-red-400">*</span>}
        {hint && <span className="ml-auto font-sans font-normal text-muted-foreground">{hint}</span>}
      </Label>
      {children}
    </div>
  )
}

function sessionAge(session: string) {
  try {
    const t = JSON.parse(session)?.cache?.lastValidationTime
    if (!t) return "saved"
    const mins = Math.round((Date.now() - t) / 60000)
    return mins < 1 ? "validated just now" : `validated ${mins}m ago`
  } catch {
    return "invalid JSON"
  }
}

export function Runner({ opKey, platformId }: { opKey: string; platformId: string }) {
  const { state, set, setLoginField, setOption, loginDataKey } = usePlayground()
  const platform = getPlatform(platformId)
  const isHelper = HELPER_KEYS.has(opKey)
  const loginType = state.loginType[platformId] || platform.loginTypes[0]
  const loginFields = flatten(loginDataSchema(loginType))
  const loginValues = state.loginData[loginDataKey] || {}
  const optionsKey = `${platformId}:${opKey}`
  const optionValues = state.options[optionsKey] || {}
  const optionsSchema = flatten(getOperation(platformId, opKey)?.requestBody?.content["application/json"].schema)?.properties?.options

  const [result, setResult] = React.useState<RunResult | null>(null)
  const [running, setRunning] = React.useState(false)
  const [progress, setProgress] = React.useState<{ percent: number; message: string } | null>(null)
  const abortRef = React.useRef<AbortController | null>(null)

  // Reset the result panel when switching endpoint or platform.
  React.useEffect(() => {
    setResult(null)
    setProgress(null)
  }, [opKey, platformId])

  const url = `${state.baseUrl.replace(/\/$/, "")}${methodPath(platformId, opKey)}`

  const body = React.useMemo<Body>(() => {
    if (isHelper) return { link: state.helperLink || platform.exampleLink }
    const loginData: Record<string, unknown> = {}
    for (const field of Object.keys(loginFields.properties || {})) {
      if (field === "district" && platformId !== "hac") continue
      const v = loginValues[field]
      if (v === undefined || v === "") continue
      if (field === "cookies") {
        try {
          loginData[field] = JSON.parse(v)
        } catch {
          loginData[field] = v
        }
      } else loginData[field] = v
    }
    const b: Body = { loginType, loginData }
    if (state.useSession && state.session) {
      try {
        b.session = JSON.parse(state.session)
      } catch {
        /* ignore malformed session */
      }
    }
    const opts = Object.fromEntries(Object.entries(optionValues).filter(([, v]) => v !== ""))
    if (Object.keys(opts).length) b.options = opts
    if (state.stream) b.stream = true
    return b
  }, [isHelper, state, platform, loginFields, loginValues, loginType, optionValues, platformId])

  const snippet = generateSnippet(state.language, url, body)
  const langMeta = LANGUAGES.find((l) => l.id === state.language) ?? LANGUAGES[0]

  async function run() {
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller
    setRunning(true)
    setResult(null)
    setProgress(null)
    const started = performance.now()
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      })

      let text = ""
      if (body.stream && res.body) {
        const reader = res.body.getReader()
        const decoder = new TextDecoder()
        for (;;) {
          const { value, done } = await reader.read()
          if (done) break
          text += decoder.decode(value, { stream: true })
          const parts = text.split("\n\n")
          for (const part of parts.slice(0, -1).reverse()) {
            try {
              const p = JSON.parse(part)
              if (typeof p.percent === "number") {
                setProgress(p)
                break
              }
            } catch {
              /* partial chunk */
            }
          }
        }
        text = text.split("\n\n").pop() || ""
      } else {
        text = await res.text()
      }

      let pretty = text
      let parsed: any = null
      try {
        parsed = JSON.parse(text)
        pretty = JSON.stringify(parsed, null, 2)
      } catch {
        /* non-JSON body */
      }

      const ok = res.ok && parsed?.success !== false
      setResult({ status: res.status, ok, ms: Math.round(performance.now() - started), body: pretty })

      if (parsed?.session && !isHelper) {
        set({ session: JSON.stringify(parsed.session), useSession: true })
        if (parsed.mfaRequired) {
          toast.info(`ClassLink ${parsed.mfaType === "pin" ? "PIN" : "image"} required`, {
            description: "Enter the answer in clMFA and run again — the challenge session was saved.",
          })
        } else if (opKey === "login") {
          toast.success("Logged in", { description: "Session saved. Every other endpoint will reuse it." })
        }
      }
    } catch (err) {
      if ((err as Error).name === "AbortError") return
      setResult({
        status: 0,
        ok: false,
        ms: Math.round(performance.now() - started),
        body: "",
        error: `Request failed: ${(err as Error).message}. Check the server URL and that the API is running.`,
      })
    } finally {
      setRunning(false)
      setProgress(null)
    }
  }

  return (
    <div id="try-it" className="flex scroll-mt-20 flex-col gap-4">
      {/* ---------- Parameters ---------- */}
      <div className="rounded-xl border bg-card">
        <div className="flex items-center justify-between border-b px-4 py-2.5">
          <div className="text-sm font-medium">Try it</div>
          <Badge variant="secondary" className="font-mono text-[11px]">{platform.name}</Badge>
        </div>
        <div className="grid gap-4 p-4">
          <FieldRow label="server">
            <div className="relative">
              <ServerIcon className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={state.baseUrl}
                onChange={(e) => set({ baseUrl: e.target.value })}
                className="pl-8 font-mono text-base sm:text-xs"
                spellCheck={false}
              />
            </div>
          </FieldRow>

          {isHelper ? (
            <FieldRow label="link" required>
              <Input
                value={state.helperLink}
                placeholder={platform.exampleLink}
                onChange={(e) => set({ helperLink: e.target.value })}
                className="font-mono text-base sm:text-xs"
                spellCheck={false}
              />
            </FieldRow>
          ) : (
            <>
              <div className="grid gap-3">
                <SectionLabel icon={<KeyRoundIcon className="size-3" />}>Authentication</SectionLabel>
                <FieldRow label="loginType" required>
                  <Select
                    value={loginType}
                    onValueChange={(v) => set({ loginType: { ...state.loginType, [platformId]: String(v) } })}
                  >
                    <SelectTrigger className="w-full font-mono text-base sm:text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {platform.loginTypes.map((t) => (
                        <SelectItem key={t} value={t} className="font-mono text-xs">
                          {t}
                          <span className="ml-auto font-sans text-muted-foreground">{LOGIN_TYPE_LABEL[t]}</span>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </FieldRow>
                <div className="grid gap-3 sm:grid-cols-2">
                  {Object.entries<any>(loginFields.properties || {})
                    .filter(([field]) => field !== "district" || platformId === "hac")
                    .map(([field, schema]) => {
                      const wide = field === "link" || field === "cookies" || field === "clsession"
                      return (
                        <div key={field} className={cn(wide && "sm:col-span-2")}>
                          <FieldRow label={`loginData.${field}`} required={loginFields.required?.includes(field)}>
                            {field === "cookies" ? (
                              <Textarea
                                value={loginValues[field] || ""}
                                onChange={(e) => setLoginField(field, e.target.value)}
                                placeholder="JSESSIONID=…; other=…"
                                className="min-h-16 font-mono text-base sm:text-xs"
                                spellCheck={false}
                              />
                            ) : (
                              <Input
                                type={schema.format === "password" ? "password" : "text"}
                                autoComplete="off"
                                value={loginValues[field] || ""}
                                placeholder={field === "link" ? platform.exampleLink : ""}
                                onChange={(e) => setLoginField(field, e.target.value)}
                                className="font-mono text-base sm:text-xs"
                                spellCheck={false}
                              />
                            )}
                          </FieldRow>
                        </div>
                      )
                    })}
                </div>
              </div>

              {optionsSchema && opKey !== "login" && (
                <div className="grid gap-3">
                  <SectionLabel>Options</SectionLabel>
                  <div className="grid gap-3 sm:grid-cols-2">
                    {Object.entries<any>(optionsSchema.properties).map(([field, schema]) => (
                      <FieldRow key={field} label={`options.${field}`} required={optionsSchema.required?.includes(field)}>
                        <Input
                          value={optionValues[field] || ""}
                          placeholder={schema.example || ""}
                          onChange={(e) => setOption(opKey, field, e.target.value)}
                          className="font-mono text-base sm:text-xs"
                          spellCheck={false}
                        />
                      </FieldRow>
                    ))}
                  </div>
                </div>
              )}

              <div className="grid gap-2.5 rounded-lg border bg-muted/30 p-3">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="font-mono text-xs font-medium">session</div>
                    <div className="truncate text-xs text-muted-foreground">
                      {state.session ? sessionAge(state.session) : "None yet — run Log in to save one"}
                    </div>
                  </div>
                  <div className="flex items-center gap-1">
                    {state.session && (
                      <Button variant="ghost" size="icon-sm" aria-label="Clear session" onClick={() => set({ session: "" })}>
                        <Trash2Icon />
                      </Button>
                    )}
                    <Switch
                      checked={state.useSession && !!state.session}
                      disabled={!state.session}
                      onCheckedChange={(v) => set({ useSession: v })}
                    />
                  </div>
                </div>
                <div className="flex items-center justify-between gap-3 border-t pt-2.5">
                  <div>
                    <div className="font-mono text-xs font-medium">stream</div>
                    <div className="text-xs text-muted-foreground">Receive progress updates</div>
                  </div>
                  <Switch checked={state.stream} onCheckedChange={(v) => set({ stream: v })} />
                </div>
              </div>
            </>
          )}
        </div>
      </div>

      {/* ---------- Request snippet ---------- */}
      <div>
        <Tabs value={state.language} onValueChange={(v) => set({ language: String(v) })}>
          <CodeBlock
            code={snippet}
            lang={langMeta.shiki}
            maxHeight="340px"
            title={
              <TabsList variant="line" className="h-8">
                {LANGUAGES.map((l) => (
                  <TabsTrigger key={l.id} value={l.id} className="px-2 text-xs">
                    {l.label}
                  </TabsTrigger>
                ))}
              </TabsList>
            }
          />
        </Tabs>
        <Button className="mt-3 w-full" onClick={run} disabled={running}>
          {running ? <Loader2Icon className="animate-spin" /> : <PlayIcon />}
          {running ? "Sending…" : "Send request"}
        </Button>
      </div>

      {/* ---------- Result ---------- */}
      <div className="overflow-hidden rounded-xl border bg-card">
        <div className="flex h-10 items-center gap-2 border-b px-4 text-xs">
          <span className="font-medium text-foreground">Response</span>
          {result && (
            <>
              <Badge
                variant="outline"
                className={cn(
                  "font-mono",
                  result.ok
                    ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
                    : "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-400"
                )}
              >
                {result.status || "ERR"}
              </Badge>
              <span className="text-muted-foreground">{result.ms} ms</span>
              {result.body && <span className="text-muted-foreground">{(new Blob([result.body]).size / 1024).toFixed(1)} KB</span>}
            </>
          )}
        </div>
        {running && (
          <div className="grid gap-2 p-4">
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span>{progress?.message || "Waiting for response…"}</span>
              {progress && <span className="font-mono">{progress.percent}%</span>}
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-muted">
              <div
                className={cn("h-full rounded-full bg-primary transition-all duration-500", !progress && "w-1/3 animate-pulse")}
                style={progress ? { width: `${progress.percent}%` } : undefined}
              />
            </div>
          </div>
        )}
        {!running && !result && (
          <div className="px-4 py-8 text-center text-sm text-muted-foreground">
            Send a request to see the live response here.
          </div>
        )}
        {result?.error && <div className="p-4 text-sm text-red-600 dark:text-red-400">{result.error}</div>}
        {result?.body && <CodeBlock code={result.body} lang="json" maxHeight="520px" className="rounded-none border-0 bg-transparent" />}
      </div>
    </div>
  )
}
