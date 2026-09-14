import * as React from "react"
import { Link, useLocation } from "react-router-dom"
import { ArrowLeftIcon, ArrowRightIcon, InfoIcon, LinkIcon, TriangleAlertIcon } from "lucide-react"
import { FLAT_NAV } from "@/lib/nav"
import { cn } from "@/lib/utils"

export function slugify(text: string) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "")
}

function childrenText(children: React.ReactNode): string {
  if (typeof children === "string" || typeof children === "number") return String(children)
  if (Array.isArray(children)) return children.map(childrenText).join("")
  if (React.isValidElement(children)) return childrenText((children.props as { children?: React.ReactNode }).children)
  return ""
}

export function H2({ children, id }: { children: React.ReactNode; id?: string }) {
  const anchor = id ?? slugify(childrenText(children))
  return (
    <h2 id={anchor} className="group mt-12 mb-4 flex scroll-mt-20 items-center gap-2 text-xl font-semibold tracking-tight first:mt-0">
      {children}
      <a href={`#${anchor}`} aria-label="Link to section" className="text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100">
        <LinkIcon className="size-4" />
      </a>
    </h2>
  )
}

export function H3({ children, id }: { children: React.ReactNode; id?: string }) {
  const anchor = id ?? slugify(childrenText(children))
  return (
    <h3 id={anchor} className="mt-8 mb-3 scroll-mt-20 text-base font-semibold tracking-tight">
      {children}
    </h3>
  )
}

export function P({ children, className }: { children: React.ReactNode; className?: string }) {
  return <p className={cn("leading-7 text-muted-foreground not-first:mt-4 [&_strong]:text-foreground", className)}>{children}</p>
}

export function C({ children }: { children: React.ReactNode }) {
  return <code className="inline-code">{children}</code>
}

export function UL({ children }: { children: React.ReactNode }) {
  return <ul className="my-4 ml-5 list-disc space-y-2 text-muted-foreground marker:text-muted-foreground/50 [&_strong]:text-foreground">{children}</ul>
}

export function Callout({
  children,
  title,
  variant = "info",
}: {
  children: React.ReactNode
  title?: string
  variant?: "info" | "warning"
}) {
  const Icon = variant === "warning" ? TriangleAlertIcon : InfoIcon
  return (
    <div
      className={cn(
        "my-6 flex gap-3 rounded-lg border p-4 text-sm",
        variant === "warning" ? "border-amber-500/30 bg-amber-500/5" : "bg-muted/40"
      )}
    >
      <Icon className={cn("mt-0.5 size-4 shrink-0", variant === "warning" ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground")} />
      <div className="min-w-0 leading-6 text-muted-foreground [&_strong]:text-foreground">
        {title && <div className="mb-1 font-medium text-foreground">{title}</div>}
        {children}
      </div>
    </div>
  )
}

export function PageHeader({ eyebrow, title, description, children }: { eyebrow?: string; title: React.ReactNode; description?: React.ReactNode; children?: React.ReactNode }) {
  return (
    <div className="mb-10">
      {eyebrow && <div className="mb-2 text-sm font-medium text-muted-foreground">{eyebrow}</div>}
      <h1 className="text-2xl font-semibold tracking-tight text-balance sm:text-3xl">{title}</h1>
      {description && <p className="mt-3 text-base leading-7 text-muted-foreground text-pretty sm:text-lg">{description}</p>}
      {children}
    </div>
  )
}

/** "On this page" — tracks h2/h3 headings inside the article. */
function TableOfContents({ articleRef }: { articleRef: React.RefObject<HTMLElement | null> }) {
  const { pathname } = useLocation()
  const [headings, setHeadings] = React.useState<{ id: string; text: string; level: number }[]>([])
  const [active, setActive] = React.useState<string>("")

  React.useEffect(() => {
    const el = articleRef.current
    if (!el) return
    const nodes = Array.from(el.querySelectorAll<HTMLElement>("h2[id], h3[id]"))
    setHeadings(nodes.map((n) => ({ id: n.id, text: n.textContent || "", level: n.tagName === "H3" ? 3 : 2 })))
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)
        if (visible[0]) setActive(visible[0].target.id)
      },
      { rootMargin: "-80px 0px -70% 0px" }
    )
    nodes.forEach((n) => observer.observe(n))
    return () => observer.disconnect()
  }, [articleRef, pathname])

  if (headings.length < 2) return null
  return (
    <nav className="sticky top-20 hidden max-h-[calc(100vh-6rem)] overflow-auto text-sm xl:block">
      <div className="mb-3 font-medium">On this page</div>
      <ul className="space-y-2">
        {headings.map((h) => (
          <li key={h.id} className={cn(h.level === 3 && "pl-3")}>
            <a
              href={`#${h.id}`}
              className={cn("block text-muted-foreground transition-colors hover:text-foreground", active === h.id && "font-medium text-foreground")}
            >
              {h.text}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  )
}

export function PrevNext() {
  const { pathname } = useLocation()
  const i = FLAT_NAV.findIndex((n) => n.href === pathname)
  if (i === -1) return null
  const prev = FLAT_NAV[i - 1]
  const next = FLAT_NAV[i + 1]
  return (
    <div className="mt-16 grid gap-4 border-t pt-8 sm:grid-cols-2">
      {prev ? (
        <Link to={prev.href} className="group rounded-lg border p-4 transition-colors hover:bg-muted/50">
          <div className="flex items-center gap-1 text-xs text-muted-foreground">
            <ArrowLeftIcon className="size-3" /> Previous
          </div>
          <div className="mt-1 font-medium">{prev.title}</div>
        </Link>
      ) : (
        <span />
      )}
      {next && (
        <Link to={next.href} className="group rounded-lg border p-4 text-right transition-colors hover:bg-muted/50">
          <div className="flex items-center justify-end gap-1 text-xs text-muted-foreground">
            Next <ArrowRightIcon className="size-3" />
          </div>
          <div className="mt-1 font-medium">{next.title}</div>
        </Link>
      )}
    </div>
  )
}

/** Standard prose page: article + "On this page" rail. */
export function DocsPage({ children }: { children: React.ReactNode }) {
  const ref = React.useRef<HTMLElement>(null)
  return (
    <div className="mx-auto grid w-full max-w-6xl gap-12 px-4 py-6 sm:px-8 sm:py-10 xl:grid-cols-[minmax(0,1fr)_14rem]">
      <article ref={ref} className="min-w-0 max-w-3xl">
        {children}
        <PrevNext />
      </article>
      <TableOfContents articleRef={ref} />
    </div>
  )
}
