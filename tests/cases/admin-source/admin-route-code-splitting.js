const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const routeSource = fs.readFileSync(
  path.join(__dirname, '../../../admin/src/routeChunks.js'),
  'utf8',
)
const appSource = fs.readFileSync(
  path.join(__dirname, '../../../admin/src/App.jsx'),
  'utf8',
)

const routeComponents = [
  'Dashboard',
  'ConfigEditor',
  'TransactionsDCA',
  'TransactionsRegime',
  'ChartsDCA',
  'ChartsRegime',
  'CostBasisDCA',
  'CostBasisRegime',
  'Backtest',
  'Optimizer',
  'Overview',
  'KeysConfig',
  'NotificationsConfig',
  'BackupRestore',
  'RegimeDashboard',
]

// The render-observable route behaviour (shared loading status, chunk-failure
// recovery, per-fund remounts) is covered by admin/tests/app-route-loading.test.jsx.
// What remains cannot be observed by rendering: that route modules are split
// into lazy chunks instead of static imports.
describe('admin route code splitting', () => {
  it('loads route-only dashboard modules through dynamic imports', () => {
    for (const component of routeComponents) {
      assert.match(
        routeSource,
        new RegExp(`const ${component} = lazyRoute\\(routePaths\\.\\w+, \\(\\) => import\\('\\./components/${component}'\\)\\)`),
      )
      assert.doesNotMatch(
        routeSource + appSource,
        new RegExp(`import ${component} from ['\"]\\./components/${component}['\"]`),
      )
    }
  })
})
