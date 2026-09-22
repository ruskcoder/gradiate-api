import raw from "@/generated/openapi.json"

/* eslint-disable @typescript-eslint/no-explicit-any */
export type Schema = any

export interface Platform {
  id: string
  name: string
  fullName: string
  mount: string
  loginTypes: string[]
  exampleLink: string
  helpers: string[]
  operations: string[]
  summary: string
  notes: string[]
}

export interface OperationMeta {
  key: string
  path: string
  title: string
  group: string
  summary: string
  description: string
  platforms: string[]
}

export const spec: any = raw
export const platforms: Platform[] = spec["x-platforms"]
export const operations: OperationMeta[] = spec["x-operations"]

export const HELPER_KEYS = new Set(["districts", "authMethods"])

export function getPlatform(id: string) {
  return platforms.find((p) => p.id === id) ?? platforms[0]
}

export function getOperationMeta(key: string) {
  return operations.find((o) => o.key === key)
}

/** The concrete OpenAPI operation object for a platform + core operation. */
export function getOperation(platformId: string, key: string): any | undefined {
  const platform = getPlatform(platformId)
  const meta = getOperationMeta(key)
  if (!meta) return undefined
  return spec.paths[platform.mount + meta.path]?.post
}

export function resolve(schema: Schema): Schema {
  if (schema && schema.$ref) {
    const name = schema.$ref.split("/").pop()
    return { ...spec.components.schemas[name], "x-ref": name }
  }
  return schema
}

/** Flatten `allOf` into one object schema (later entries win). */
export function flatten(schema: Schema): Schema {
  const s = resolve(schema)
  if (!s) return s
  if (!s.allOf) return s
  const out: Schema = { type: "object", properties: {}, required: [] as string[] }
  for (const part of s.allOf) {
    const f = flatten(part)
    Object.assign(out.properties, f.properties || {})
    out.required.push(...(f.required || []))
    if (f.description && !out.description) out.description = f.description
  }
  return out
}

export function typeLabel(schema: Schema): string {
  const s = resolve(schema)
  if (!s) return "any"
  if (s["x-ref"] && !["LoginType"].includes(s["x-ref"])) return s["x-ref"]
  if (s.const !== undefined) return JSON.stringify(s.const)
  if (s.enum) return "enum"
  if (s.oneOf) return s.oneOf.map(typeLabel).join(" | ")
  if (s.allOf) return "object"
  if (Array.isArray(s.type)) return s.type.join(" | ")
  if (s.type === "array") return `${typeLabel(s.items)}[]`
  if (s.type === "object" && s.additionalProperties && !s.properties) return "map"
  return s.type || "object"
}

export const LOGIN_TYPE_SCHEMA: Record<string, string> = {
  credentials: "CredentialsLoginData",
  classlink: "ClassLinkLoginData",
  classlinkCredentials: "ClassLinkCredentialsLoginData",
  microsoftSession: "MicrosoftSessionLoginData",
  token: "TokenLoginData",
}

export const LOGIN_TYPE_LABEL: Record<string, string> = {
  credentials: "Portal credentials",
  classlink: "ClassLink session",
  classlinkCredentials: "ClassLink login",
  microsoftSession: "Microsoft session",
  token: "API access token",
}

export function loginDataSchema(loginType: string) {
  return spec.components.schemas[LOGIN_TYPE_SCHEMA[loginType]]
}

export function methodPath(platformId: string, key: string) {
  const meta = getOperationMeta(key)
  return getPlatform(platformId).mount + (meta?.path ?? "")
}
