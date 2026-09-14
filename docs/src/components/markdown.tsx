import * as React from "react"

/**
 * Tiny inline-markdown renderer for spec descriptions: paragraphs, `code`,
 * **bold** and [links](url). The spec never needs more than that.
 */
function inline(text: string): React.ReactNode[] {
  const out: React.ReactNode[] = []
  const re = /(`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\([^)]+\))/g
  let last = 0
  let m: RegExpExecArray | null
  let i = 0
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index))
    const tok = m[0]
    if (tok.startsWith("`")) {
      out.push(<code key={i++} className="inline-code">{tok.slice(1, -1)}</code>)
    } else if (tok.startsWith("**")) {
      out.push(<strong key={i++} className="font-medium text-foreground">{tok.slice(2, -2)}</strong>)
    } else {
      const [, label, href] = tok.match(/\[([^\]]+)\]\(([^)]+)\)/)!
      out.push(<a key={i++} href={href} className="font-medium underline underline-offset-4">{label}</a>)
    }
    last = m.index + tok.length
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

export function Md({ text, className }: { text?: string; className?: string }) {
  if (!text) return null
  const paras = text.split(/\n\n+/)
  if (paras.length === 1) return <span className={className}>{inline(text)}</span>
  return (
    <div className={className}>
      {paras.map((p, i) => (
        <p key={i} className="not-first:mt-3">{inline(p)}</p>
      ))}
    </div>
  )
}
