import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { ThemeProvider } from "next-themes"
import { Toaster } from "@/components/ui/sonner"
import { TooltipProvider } from "@/components/ui/tooltip"
import { PlaygroundProvider } from "@/lib/store"
import App from "./App.tsx"
import "./index.css"

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
      <TooltipProvider>
        <PlaygroundProvider>
          <App />
          <Toaster position="bottom-center" />
        </PlaygroundProvider>
      </TooltipProvider>
    </ThemeProvider>
  </StrictMode>
)
