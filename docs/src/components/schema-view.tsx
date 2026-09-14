import * as React from "react"
import { ChevronRightIcon } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Md } from "@/components/markdown"
import { flatten, resolve, typeLabel, type Schema } from "@/lib/spec"
import { cn } from "@/lib/utils"

/** The nested object schema to expand under a field, if any. */
function childSchema(schema: Schema): Schema | null {
  const s = resolve(schema)
  if (!s) return null
  if (s.type === "array") return childSchema(s.items)
  if (s.allOf || (s.properties && Object.keys(s.properties).length)) return flatten(s)
  return null
}

function Field({
  name,
  schema,
  required,
  depth,
}: {
  name: string
  schema: Schema
  required?: boolean
  depth: number
}) {
  const s = resolve(schema)
  const child = depth < 4 ? childSchema(schema) : null
  const [open, setOpen] = React.useState(false)
  const enumValues: string[] | undefined = s?.enum

  return (
    <div className="border-b py-3 last:border-b-0">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <code className="font-mono text-[13px] font-semibold text-foreground">{name}</code>
        <span className="font-mono text-xs text-muted-foreground">{typeLabel(schema)}</span>
        {required && <span className="text-xs font-medium text-red-600 dark:text-red-400">required</span>}
        {s?.default !== undefined && (
          <span className="text-xs text-muted-foreground">
            default <code className="inline-code">{JSON.stringify(s.default)}</code>
          </span>
        )}
      </div>
      {s?.description && <Md text={s.description} className="mt-1 block text-sm text-muted-foreground" />}
      {enumValues && (
        <div className="mt-2 flex flex-wrap gap-1">
          {enumValues.map((v) => (
            <Badge key={v} variant="outline" className="font-mono text-[11px]">{v}</Badge>
          ))}
        </div>
      )}
      {s?.example && (
        <div className="mt-1 text-xs text-muted-foreground">
          Example: <code className="inline-code">{String(s.example)}</code>
        </div>
      )}
      {child && (
        <Collapsible open={open} onOpenChange={setOpen} className="mt-2">
          <CollapsibleTrigger className="inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground">
            <ChevronRightIcon className={cn("size-3 transition-transform", open && "rotate-90")} />
            {open ? "Hide" : "Show"} child attributes
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div className="mt-2 rounded-lg border px-4">
              <SchemaFields schema={child} depth={depth + 1} />
            </div>
          </CollapsibleContent>
        </Collapsible>
      )}
    </div>
  )
}

export function SchemaFields({ schema, depth = 0, omit = [] }: { schema: Schema; depth?: number; omit?: string[] }) {
  const s = flatten(schema)
  const props = Object.entries(s?.properties || {}).filter(([k]) => !omit.includes(k))
  if (!props.length) {
    return <p className="py-3 text-sm text-muted-foreground">No fields.</p>
  }
  return (
    <div>
      {props.map(([name, prop]) => (
        <Field key={name} name={name} schema={prop} required={s.required?.includes(name)} depth={depth} />
      ))}
    </div>
  )
}
