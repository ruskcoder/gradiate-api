import { operations, platforms } from "@/lib/spec"

export interface NavItem {
  title: string
  href: string
  badge?: string
}

export interface NavGroup {
  title: string
  items: NavItem[]
}

export const GUIDES: NavItem[] = [
  { title: "Introduction", href: "/" },
  { title: "Quickstart", href: "/guides/quickstart" },
  { title: "Authentication", href: "/guides/authentication" },
  { title: "Sessions", href: "/guides/sessions" },
  { title: "Streaming progress", href: "/guides/streaming" },
  { title: "Terms", href: "/guides/terms" },
  { title: "Errors & limits", href: "/guides/errors" },
  { title: "Tools & SDKs", href: "/guides/tools" },
  { title: "Changelog", href: "/guides/changelog" },
]

const API_GROUPS = ["Authentication", "Student", "Grades", "Reports"]

export const NAV: NavGroup[] = [
  { title: "Getting started", items: GUIDES },
  ...API_GROUPS.map((group) => ({
    title: group === "Authentication" ? "API · Auth" : `API · ${group}`,
    items: operations
      .filter((o) => o.group === group)
      .map((o) => ({
        title: o.title,
        href: `/api/${o.key}`,
        badge: o.platforms.length < platforms.length ? platforms.filter((p) => o.platforms.includes(p.id)).map((p) => p.name.split(" ")[0]).join(", ") : undefined,
      })),
  })),
  {
    title: "Platforms",
    items: [
      { title: "Comparison", href: "/platforms" },
      ...platforms.map((p) => ({ title: p.name, href: `/platforms/${p.id}` })),
    ],
  },
]

export const FLAT_NAV: NavItem[] = NAV.flatMap((g) => g.items)
