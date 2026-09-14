import * as React from "react"
import { CheckIcon, CopyIcon } from "lucide-react"
import { createHighlighterCore, type HighlighterCore } from "shiki/core"
import { createJavaScriptRegexEngine } from "shiki/engine/javascript"
import { toast } from "sonner"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"

let highlighterPromise: Promise<HighlighterCore> | null = null

function getHighlighter() {
  highlighterPromise ??= createHighlighterCore({
    themes: [import("shiki/themes/github-light-default.mjs"), import("shiki/themes/github-dark-default.mjs")],
    langs: [
      import("shiki/langs/bash.mjs"),
      import("shiki/langs/python.mjs"),
      import("shiki/langs/javascript.mjs"),
      import("shiki/langs/json.mjs"),
    ],
    engine: createJavaScriptRegexEngine(),
  })
  return highlighterPromise
}

// Highlighting very large payloads freezes the tab; show those as plain text.
const MAX_HIGHLIGHT = 150_000

function escapeHtml(s: string) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

export function useHighlighted(code: string, lang: string) {
  const [html, setHtml] = React.useState<string | null>(null)
  React.useEffect(() => {
    let cancelled = false
    if (code.length > MAX_HIGHLIGHT) {
      setHtml(`<pre class="shiki"><code>${escapeHtml(code)}</code></pre>`)
      return
    }
    getHighlighter().then((h) => {
      if (cancelled) return
      setHtml(
        h.codeToHtml(code, {
          lang,
          themes: { light: "github-light-default", dark: "github-dark-default" },
          defaultColor: false,
        })
      )
    })
    return () => {
      cancelled = true
    }
  }, [code, lang])
  return html
}

export function CopyButton({ value, className }: { value: string; className?: string }) {
  const [copied, setCopied] = React.useState(false)
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      className={cn("text-muted-foreground", className)}
      aria-label="Copy"
      onClick={() => {
        navigator.clipboard.writeText(value).then(
          () => {
            setCopied(true)
            setTimeout(() => setCopied(false), 1500)
          },
          () => toast.error("Couldn’t copy to clipboard")
        )
      }}
    >
      {copied ? <CheckIcon /> : <CopyIcon />}
    </Button>
  )
}

export function CodeBlock({
  code,
  lang,
  title,
  className,
  maxHeight,
  actions,
}: {
  code: string
  lang: string
  title?: React.ReactNode
  className?: string
  maxHeight?: string
  actions?: React.ReactNode
}) {
  const html = useHighlighted(code, lang)
  return (
    <div className={cn("group/code relative overflow-hidden rounded-lg border bg-muted/40", className)}>
      {title !== undefined && (
        <div className="flex h-10 items-center justify-between gap-2 border-b bg-muted/40 pr-1.5 pl-3 text-xs text-muted-foreground">
          <div className="flex min-w-0 items-center gap-2">{title}</div>
          <div className="flex items-center gap-1">
            {actions}
            <CopyButton value={code} />
          </div>
        </div>
      )}
      {title === undefined && (
        <CopyButton value={code} className="absolute top-1.5 right-1.5 z-10 opacity-0 group-hover/code:opacity-100 focus-visible:opacity-100" />
      )}
      <div className="code-scroll overflow-auto text-[13px] leading-relaxed" style={{ maxHeight }}>
        {html ? (
          <div dangerouslySetInnerHTML={{ __html: html }} />
        ) : (
          <pre className="shiki">
            <code>{code}</code>
          </pre>
        )}
      </div>
    </div>
  )
}
