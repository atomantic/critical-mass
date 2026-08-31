const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const appSource = fs.readFileSync(
  path.join(__dirname, '..', 'admin', 'src', 'App.jsx'),
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

  it('uses one shared Suspense boundary around the route outlet', () => {
    assert.match(
      appSource,
      /<Suspense fallback={<RouteLoadingFallback \/>}>\s*<Routes>/,
    )
    assert.equal(
      (appSource.match(/<Suspense fallback={<RouteLoadingFallback \/>}>/g) || []).length,
      1,
    )
  })

  it('preserves fund-specific remount keys on lazy route elements', () => {
    const keyedRoutes = [
      '<RegimeDashboard key={`${currentExchange}-${currentPair}`}',
      '<Dashboard key={`${currentExchange}-${currentPair}`}',
      '<ChartsRegime key={`${currentExchange}-${currentPair}`}',
      '<Backtest key={`${currentExchange}:${currentPair}`}',
      '<Optimizer key={`${currentExchange}:${currentPair}`}',
    ]

    for (const route of keyedRoutes) {
      assert.ok(appSource.includes(route), `expected App.jsx to retain ${route}`)
    }
  })
})
