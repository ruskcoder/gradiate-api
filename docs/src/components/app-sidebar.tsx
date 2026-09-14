import { Link, useLocation } from "react-router-dom"
import { BookOpenIcon, FileJsonIcon } from "lucide-react"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  useSidebar,
} from "@/components/ui/sidebar"
import * as React from "react"
import { NAV } from "@/lib/nav"

export function AppSidebar() {
  const { pathname } = useLocation()
  const { isMobile, setOpenMobile } = useSidebar()

  // Close the mobile drawer after navigating.
  React.useEffect(() => {
    if (isMobile) setOpenMobile(false)
  }, [pathname, isMobile, setOpenMobile])

  return (
    <Sidebar>
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" render={<Link to="/" />}>
              <div className="flex aspect-square size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
                <BookOpenIcon className="size-4" />
              </div>
              <div className="grid flex-1 text-left leading-tight">
                <span className="truncate font-semibold">Gradexis API</span>
                <span className="truncate text-xs text-muted-foreground">Reference · v1</span>
              </div>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        {NAV.map((group) => (
          <SidebarGroup key={group.title}>
            <SidebarGroupLabel>{group.title}</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {group.items.map((item) => {
                  const isApi = item.href.startsWith("/api/")
                  return (
                    <SidebarMenuItem key={item.href}>
                      <SidebarMenuButton isActive={pathname === item.href} render={<Link to={item.href} />}>
                        {isApi && (
                          <span className="rounded bg-emerald-500/10 px-1 font-mono text-[9px] font-semibold text-emerald-700 dark:text-emerald-400">
                            POST
                          </span>
                        )}
                        <span>{item.title}</span>
                      </SidebarMenuButton>
                      {item.badge && <SidebarMenuBadge className="text-[10px] font-normal text-muted-foreground">{item.badge}</SidebarMenuBadge>}
                    </SidebarMenuItem>
                  )
                })}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        ))}
      </SidebarContent>
      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton render={<a href="/openapi.json" target="_blank" rel="noreferrer" />}>
              <FileJsonIcon />
              <span>openapi.json</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  )
}
