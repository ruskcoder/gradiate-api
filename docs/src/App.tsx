import * as React from "react"
import { BrowserRouter, Navigate, Route, Routes, useLocation } from "react-router-dom"
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar"
import { AppSidebar } from "@/components/app-sidebar"
import { SiteHeader } from "@/components/site-header"
import { EndpointPage } from "@/pages/endpoint"
import { GuidePage, OverviewPage } from "@/pages/guides"
import { ComparisonPage, PlatformPage } from "@/pages/platforms"

function ScrollToHash() {
  const { pathname, hash } = useLocation()
  React.useEffect(() => {
    if (hash) {
      requestAnimationFrame(() => document.getElementById(hash.slice(1))?.scrollIntoView())
    } else {
      window.scrollTo({ top: 0 })
    }
  }, [pathname, hash])
  return null
}

export default function App() {
  return (
    <BrowserRouter>
      <ScrollToHash />
      <SidebarProvider>
        <AppSidebar />
        <SidebarInset>
          <SiteHeader />
          <Routes>
            <Route path="/" element={<OverviewPage />} />
            <Route path="/guides/:slug" element={<GuidePage />} />
            <Route path="/api/:op" element={<EndpointPage />} />
            <Route path="/platforms" element={<ComparisonPage />} />
            <Route path="/platforms/:id" element={<PlatformPage />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </SidebarInset>
      </SidebarProvider>
    </BrowserRouter>
  )
}
