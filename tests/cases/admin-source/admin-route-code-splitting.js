const TEST_DIR = require('node:path').resolve(__dirname, '../..');
const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const appSource = fs.readFileSync(
  path.join(TEST_DIR, '..', 'admin', 'src', 'App.jsx'),
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
        appSource,
        new RegExp(`const ${component} = lazy\\(\\(\\) => import\\('\\./components/${component}'\\)\\)`),
      )
      assert.doesNotMatch(
        appSource,
        new RegExp(`import ${component} from ['\"]\\./components/${component}['\"]`),
      )
    }
  })
})
