import * as React from "react"
import { useLocation, useNavigate } from "react-router-dom"
import { useTheme } from "next-themes"
import { BookIcon, CodeIcon, LayersIcon, MoonIcon, SearchIcon, SunIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command"
import { Command } from "@/components/ui/command"
import { Kbd } from "@/components/ui/kbd"
import { Separator } from "@/components/ui/separator"
import { SidebarTrigger } from "@/components/ui/sidebar"
import { NAV } from "@/lib/nav"
import { operations } from "@/lib/spec"

function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme()
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      aria-label="Toggle theme"
      onClick={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")}
    >
      <SunIcon className="dark:hidden" />
      <MoonIcon className="hidden dark:block" />
    </Button>
  )
}

function SearchCommand() {
  const [open, setOpen] = React.useState(false)
  const navigate = useNavigate()

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.key === "k" && (e.metaKey || e.ctrlKey)) || (e.key === "/" && !(e.target as HTMLElement).closest("input,textarea"))) {
        e.preventDefault()
        setOpen((o) => !o)
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [])

  const go = (href: string) => {
    setOpen(false)
    navigate(href)
  }

  return (
    <>
      <Button
        variant="outline"
        className="h-8 w-full justify-start gap-2 bg-muted/40 px-2.5 text-muted-foreground shadow-none sm:w-56"
        onClick={() => setOpen(true)}
      >
        <SearchIcon />
        <span className="text-sm font-normal">Search docs…</span>
        <Kbd className="ml-auto hidden sm:inline-flex">Ctrl K</Kbd>
      </Button>
      <CommandDialog open={open} onOpenChange={setOpen} title="Search documentation">
        <Command>
          <CommandInput placeholder="Search guides, endpoints, platforms…" />
          <CommandList>
            <CommandEmpty>No results.</CommandEmpty>
            {NAV.filter((g) => !g.title.startsWith("API")).map((group) => (
              <CommandGroup key={group.title} heading={group.title}>
                {group.items.map((item) => (
                  <CommandItem key={item.href} value={`${group.title} ${item.title}`} onSelect={() => go(item.href)}>
                    {group.title === "Platforms" ? <LayersIcon /> : <BookIcon />}
                    {item.title}
                  </CommandItem>
                ))}
              </CommandGroup>
            ))}
            <CommandGroup heading="Endpoints">
              {operations.map((op) => (
                <CommandItem key={op.key} value={`${op.title} ${op.path} ${op.summary}`} onSelect={() => go(`/api/${op.key}`)}>
                  <CodeIcon />
                  <span>{op.title}</span>
                  <span className="ml-auto font-mono text-xs text-muted-foreground">{op.path}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </CommandDialog>
    </>
  )
}

/** Pings a platform's root route to show whether this API server is reachable. */
function ApiStatus() {
  const [state, setState] = React.useState<{ ok: boolean | null; ms?: number }>({ ok: null })

  React.useEffect(() => {
    let cancelled = false
    const check = async () => {
      const started = performance.now()
      try {
        const res = await fetch("/hac/", { method: "POST" })
        if (!cancelled) setState({ ok: res.ok, ms: Math.round(performance.now() - started) })
      } catch {
        if (!cancelled) setState({ ok: false })
      }
    }
    check()
    const id = setInterval(check, 60_000)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [])

  const label = state.ok === null ? "Checking…" : state.ok ? `Operational · ${state.ms} ms` : "Unreachable"
  return (
    <div className="hidden items-center gap-2 rounded-md border px-2 py-1 text-xs text-muted-foreground lg:flex" title="API server status">
      <span className="relative flex size-2">
        {state.ok && <span className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-400 opacity-60" />}
        <span
          className={`relative inline-flex size-2 rounded-full ${state.ok === null ? "bg-muted-foreground/40" : state.ok ? "bg-emerald-500" : "bg-red-500"}`}
        />
      </span>
      {label}
    </div>
  )
}

export function SiteHeader() {
  const { pathname } = useLocation()
  const group = NAV.find((g) => g.items.some((i) => i.href === pathname))
  const item = group?.items.find((i) => i.href === pathname)

  return (
    <header className="sticky top-0 z-30 flex h-14 shrink-0 items-center gap-2 border-b bg-background/80 px-3 sm:px-4 backdrop-blur supports-[backdrop-filter]:bg-background/60">
      <SidebarTrigger className="-ml-1" />
      <Separator orientation="vertical" className="mr-1 data-[orientation=vertical]:h-4" />
      <div className="hidden min-w-0 items-center gap-1.5 text-sm md:flex">
        <span className="text-muted-foreground">{group?.title ?? "Docs"}</span>
        {item && (
          <>
            <span className="text-muted-foreground">/</span>
            <span className="truncate font-medium">{item.title}</span>
          </>
        )}
      </div>
      <div className="ml-auto flex flex-1 items-center justify-end gap-1.5 md:flex-none">
        <ApiStatus />
        <SearchCommand />
        <ThemeToggle />
      </div>
    </header>
  )
}
