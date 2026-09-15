import * as React from "react"

/** Playground request history, per browser. Secrets are stripped before saving. */

export interface HistoryEntry {
  id: string
  at: number
  opKey: string
  platformId: string
  url: string
  status: number
  ok: boolean
  ms: number
  body: Record<string, unknown>
}

const KEY = "gradexis-docs-history"
const MAX = 20
const SECRETS = ["password", "clMFA", "cookies", "clsession"]

function read(): HistoryEntry[] {
  try {
    return JSON.parse(localStorage.getItem(KEY) || "[]")
  } catch {
    return []
  }
}

const listeners = new Set<() => void>()
let cache: HistoryEntry[] = read()

function write(next: HistoryEntry[]) {
  cache = next
  try {
    localStorage.setItem(KEY, JSON.stringify(next))
  } catch {
    /* storage unavailable */
  }
  listeners.forEach((l) => l())
}

export function addHistory(entry: Omit<HistoryEntry, "id" | "at">) {
  const body = { ...entry.body }
  delete body.session
  if (body.loginData && typeof body.loginData === "object") {
    body.loginData = Object.fromEntries(Object.entries(body.loginData).filter(([k]) => !SECRETS.includes(k)))
  }
  write([{ ...entry, body, id: crypto.randomUUID(), at: Date.now() }, ...cache].slice(0, MAX))
}

export function clearHistory() {
  write([])
}

export function useHistory() {
  return React.useSyncExternalStore(
    (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    () => cache
  )
}

export function timeAgo(at: number) {
  const s = Math.round((Date.now() - at) / 1000)
  if (s < 60) return "just now"
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}
