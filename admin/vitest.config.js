import { configDefaults, defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

const testFiles = ['tests/**/*.test.{js,jsx}']

// Keep dedicated processes for native toolchains, timezone-changing parity
// tests, and cases that override browser globals or exercise VM fixtures.
const processTests = [
  'tests/{admin-tailwind-build,chart-math-parity,vite-hosts}.test.js',
  'tests/{app-fund-scoping,app-route-loading,chart-parity,transactions-cycle-options,use-candle-data}.test.jsx',
  'tests/{admin-accessible-forms,admin-dca-placement-recovery,admin-dca-summary,admin-manual-trades-recovery,ai-provider-form,cost-basis-regime-failure-recovery,depth-capability-boundary,global-settings-transactions,regime-dashboard-forms,regime-order-disclosures,updown-trade-actions}.test.js',
]

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    // Keep headroom for render-heavy tests on hosts running other workloads (#1507).
    testTimeout: 20000,
    projects: [
      {
        extends: true,
        test: {
          name: 'admin',
          include: testFiles,
          exclude: [...configDefaults.exclude, ...processTests],
          // Reuse worker environments, with an isolated VM for each test file.
          pool: 'vmThreads',
        },
      },
      {
        extends: true,
        test: { name: 'admin-process', include: processTests, pool: 'forks' },
      },
    ],
  },
})
