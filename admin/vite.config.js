import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Default ports matching ecosystem.config.cjs
const UI_PORT = parseInt(process.env.VITE_PORT || '5564')
const API_PORT = parseInt(process.env.VITE_API_PORT || '5563')

export default defineConfig({
  plugins: [react()],
  server: {
    port: UI_PORT,
    host: '0.0.0.0',
    proxy: {
      '/api': {
        target: `http://localhost:${API_PORT}`,
        changeOrigin: true,
      },
      '/socket.io': {
        target: `http://localhost:${API_PORT}`,
        changeOrigin: true,
        ws: true,
      },
    },
  },
})
