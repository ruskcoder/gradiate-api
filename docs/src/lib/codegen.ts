/** Request-body assembly + cURL / Python / JavaScript snippet generation. */

export type Body = Record<string, unknown>

export const LANGUAGES = [
  { id: "curl", label: "cURL", shiki: "bash" },
  { id: "python", label: "Python", shiki: "python" },
  { id: "javascript", label: "JavaScript", shiki: "javascript" },
] as const

const SESSION_PLACEHOLDER = "<session from /login>"

/** Collapse a long session into a placeholder so snippets stay readable. */
function displayBody(body: Body): Body {
  if (body.session && typeof body.session === "object") {
    return { ...body, session: SESSION_PLACEHOLDER }
  }
  return body
}

function indent(text: string, spaces: number) {
  const pad = " ".repeat(spaces)
  return text
    .split("\n")
    .map((l, i) => (i === 0 ? l : pad + l))
    .join("\n")
}

function toPython(value: unknown, level = 0): string {
  const pad = "    ".repeat(level + 1)
  const end = "    ".repeat(level)
  if (value === null || value === undefined) return "None"
  if (value === true) return "True"
  if (value === false) return "False"
  if (typeof value === "string") {
    if (value === SESSION_PLACEHOLDER) return "session  # from /login"
    return JSON.stringify(value)
  }
  if (typeof value === "number") return String(value)
  if (Array.isArray(value)) {
    if (!value.length) return "[]"
    return `[\n${value.map((v) => pad + toPython(v, level + 1)).join(",\n")}\n${end}]`
  }
  const entries = Object.entries(value as object)
  if (!entries.length) return "{}"
  return `{\n${entries.map(([k, v]) => `${pad}${JSON.stringify(k)}: ${toPython(v, level + 1)}`).join(",\n")}\n${end}}`
}

export function generateSnippet(language: string, url: string, body: Body): string {
  const shown = displayBody(body)
  const json = JSON.stringify(shown, null, 2)

  if (language === "python") {
    const usesSession = shown.session === SESSION_PLACEHOLDER
    return [
      "import requests",
      "",
      ...(usesSession ? ["session = None  # the `session` object returned by /login", ""] : []),
      `response = requests.post(`,
      `    ${JSON.stringify(url)},`,
      `    json=${indent(toPython(shown, 1), 4)},`,
      `)`,
      "",
      "data = response.json()",
      'print(data["success"], data)',
    ].join("\n")
  }

  if (language === "javascript") {
    const js = json.replace(`"session": "${SESSION_PLACEHOLDER}"`, '"session": session // from /login')
    return [
      `const response = await fetch(${JSON.stringify(url)}, {`,
      `  method: "POST",`,
      `  headers: { "Content-Type": "application/json" },`,
      `  body: JSON.stringify(${indent(js, 2)}),`,
      `});`,
      "",
      "const data = await response.json();",
      "console.log(data);",
    ].join("\n")
  }

  return [
    `curl -X POST ${JSON.stringify(url).replace(/^"|"$/g, "'")} \\`,
    `  -H 'Content-Type: application/json' \\`,
    `  -d '${json.replace(/'/g, "'\\''")}'`,
  ].join("\n")
}
