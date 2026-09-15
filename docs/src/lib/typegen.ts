import { resolve, spec, type Schema } from "@/lib/spec"

/**
 * Generate TypeScript declarations from an OpenAPI schema. Named `$ref`s become
 * their own interfaces (emitted once, dependencies first); anonymous objects are
 * inlined.
 */
export function generateTypes(rootName: string, schema: Schema): string {
  const emitted = new Map<string, string>()

  const indent = (s: string, n: number) => s.replace(/\n/g, "\n" + "  ".repeat(n))

  function objectBody(s: Schema, depth: number): string {
    const props = Object.entries<Schema>(s.properties || {})
    const lines = props.map(([k, v]) => {
      const rv = resolve(v)
      const opt = s.required?.includes(k) ? "" : "?"
      const doc = rv?.description ? `/** ${rv.description.replace(/\*\//g, "").replace(/\s+/g, " ")} */\n` : ""
      const key = /^[A-Za-z_$][\w$]*$/.test(k) ? k : JSON.stringify(k)
      return doc + `${key}${opt}: ${toType(v, depth + 1)}`
    })
    if (s.additionalProperties && !props.length) {
      const inner = s.additionalProperties === true ? "unknown" : toType(s.additionalProperties, depth + 1)
      return `Record<string, ${inner}>`
    }
    if (!lines.length) return "Record<string, unknown>"
    return `{\n  ${indent(lines.join("\n"), 1)}\n}`
  }

  function toType(raw: Schema, depth = 0): string {
    if (!raw) return "unknown"
    if (raw.$ref) {
      const name = raw.$ref.split("/").pop() as string
      if (!emitted.has(name)) {
        emitted.set(name, "") // reserve (handles recursive TermNode)
        emitted.set(name, declare(name, spec.components.schemas[name]))
      }
      return name
    }
    const s = raw
    if (s.const !== undefined) return JSON.stringify(s.const)
    if (s.enum) return s.enum.map((e: unknown) => JSON.stringify(e)).join(" | ")
    if (s.oneOf) return s.oneOf.map((o: Schema) => toType(o, depth)).join(" | ")
    if (s.allOf) return s.allOf.map((o: Schema) => toType(o, depth)).join(" & ")
    const types: string[] = Array.isArray(s.type) ? s.type : [s.type]
    const mapped = types.map((t) => {
      switch (t) {
        case "string":
          return "string"
        case "integer":
        case "number":
          return "number"
        case "boolean":
          return "boolean"
        case "null":
          return "null"
        case "array": {
          const item = toType(s.items, depth)
          return /[|&]/.test(item) ? `Array<${item}>` : `${item}[]`
        }
        case "object":
        case undefined:
          return s.properties || s.additionalProperties ? objectBody(s, depth) : "Record<string, unknown>"
        default:
          return "unknown"
      }
    })
    return mapped.join(" | ")
  }

  function declare(name: string, s: Schema): string {
    const body = toType(s)
    return body.startsWith("{") ? `export interface ${name} ${body}` : `export type ${name} = ${body}`
  }

  const root = declare(rootName, resolve(schema))
  return [...emitted.values(), root].filter(Boolean).join("\n\n") + "\n"
}
