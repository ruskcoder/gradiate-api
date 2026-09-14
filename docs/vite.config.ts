import path from 'node:path'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: '/',
  resolve: {
    alias: { '@': path.resolve(import.meta.dirname, './src') },
  },
  server: {
    // `npm run dev` proxies API calls to a locally running gradexis-api.
    proxy: {
      '^/(hac|powerschool|skyward-legacy|openapi.json)': 'http://localhost:3000',
    },
  },
})
