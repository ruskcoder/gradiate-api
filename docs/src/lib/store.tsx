import * as React from "react"
import { getPlatform, platforms } from "@/lib/spec"

/**
 * Playground state shared by every endpoint page: log in once on `/login`,
 * and the session + credentials carry over to every other endpoint.
 *
 * Persisted to localStorage except secrets (password, clMFA, cookies), which
 * live only in memory for the tab.
 */

const SECRET_FIELDS = new Set(["password", "clMFA", "cookies"])
const STORAGE_KEY = "gradiate-docs-playground"

export interface PlaygroundState {
  platform: string
  baseUrl: string
  loginType: Record<string, string>
  loginData: Record<string, Record<string, string>>
  options: Record<string, Record<string, string>>
  helperLink: string
  session: string
  useSession: boolean
  stream: boolean
  language: string
}

function defaults(): PlaygroundState {
  return {
    platform: platforms[0].id,
    baseUrl: typeof window !== "undefined" ? window.location.origin : "",
    loginType: Object.fromEntries(platforms.map((p) => [p.id, p.loginTypes[0]])),
    loginData: {},
    options: {},
    helperLink: "",
    session: "",
    useSession: true,
    stream: false,
    language: "curl",
  }
}

function load(): PlaygroundState {
  const base = defaults()
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null")
    if (saved) return { ...base, ...saved }
  } catch {
    /* storage unavailable */
  }
  return base
}

function persist(state: PlaygroundState) {
  const loginData: PlaygroundState["loginData"] = {}
  for (const [k, v] of Object.entries(state.loginData)) {
    loginData[k] = Object.fromEntries(Object.entries(v).filter(([f]) => !SECRET_FIELDS.has(f)))
  }
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...state, loginData }))
  } catch {
    /* storage unavailable */
  }
}

interface Ctx {
  state: PlaygroundState
  set: (patch: Partial<PlaygroundState>) => void
  setLoginField: (field: string, value: string) => void
  setOption: (op: string, field: string, value: string) => void
  loginDataKey: string
}

const PlaygroundContext = React.createContext<Ctx | null>(null)

export function PlaygroundProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = React.useState<PlaygroundState>(load)

  React.useEffect(() => persist(state), [state])

  const loginType = state.loginType[state.platform] || getPlatform(state.platform).loginTypes[0]
  const loginDataKey = `${state.platform}:${loginType}`

  const value = React.useMemo<Ctx>(
    () => ({
      state,
      loginDataKey,
      set: (patch) => setState((s) => ({ ...s, ...patch })),
      setLoginField: (field, v) =>
        setState((s) => ({
          ...s,
          loginData: { ...s.loginData, [loginDataKey]: { ...(s.loginData[loginDataKey] || {}), [field]: v } },
        })),
      setOption: (op, field, v) =>
        setState((s) => ({
          ...s,
          options: { ...s.options, [`${s.platform}:${op}`]: { ...(s.options[`${s.platform}:${op}`] || {}), [field]: v } },
        })),
    }),
    [state, loginDataKey]
  )

  return <PlaygroundContext.Provider value={value}>{children}</PlaygroundContext.Provider>
}

export function usePlayground() {
  const ctx = React.useContext(PlaygroundContext)
  if (!ctx) throw new Error("usePlayground must be used inside PlaygroundProvider")
  return ctx
}
