import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    include: ['tests/**/*.test.{js,jsx}'],
    // Default is 5s. RegimeDashboard.test.jsx and app-fund-state.test.jsx take
    // <1s each in isolation but reached 5-6s when the host ran other agents in
    // parallel (issue #1507). 20s leaves headroom on a loaded host without
    // masking real hangs, which still fail. Do not add retries for these.
    testTimeout: 20000,
  },
})
