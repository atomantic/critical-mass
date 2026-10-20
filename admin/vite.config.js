import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Default ports matching ecosystem.config.cjs
const UI_PORT = parseInt(process.env.VITE_PORT || '5571')
const API_PORT = parseInt(process.env.VITE_API_PORT || '5570')

export default defineConfig({
  plugins: [react()],
  server: {
    port: UI_PORT,
    host: '0.0.0.0',
    // Allow access over the private Tailscale network (e.g. *.ts.net MagicDNS hosts)
    allowedHosts: ['localhost', '127.0.0.1', '[::1]', '.ts.net'],
    proxy: {
      '/api': {
        target: `http://localhost:${API_PORT}`,
        changeOrigin: true,
        xfwd: true,
      },
      // Realtime bus (src/realtime-bus.js). Keep the browser's Host: the
      // gateway only upgrades a page from its own origin, and this websocket
      // proxy adds no X-Forwarded-Host.
      '/realtime': {
        target: `http://localhost:${API_PORT}`,
        changeOrigin: false,
        ws: true,
        xfwd: true,
      },
    },
  },
})
