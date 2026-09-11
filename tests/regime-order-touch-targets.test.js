const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const dashboardSource = fs.readFileSync(
  path.join(__dirname, '..', 'admin', 'src', 'components', 'RegimeDashboard.jsx'),
  'utf8',
)

const stylesSource = fs.readFileSync(
  path.join(__dirname, '..', 'admin', 'src', 'index.css'),
  'utf8',
)

test('regime order actions share a touch target without changing their handlers', () => {
  assert.match(
    dashboardSource,
    /const REGIME_ORDER_TOUCH_TARGET = 'min-h-11 min-w-11 inline-flex items-center justify-center regime-order-touch-target'/,
  )
  assert.equal((dashboardSource.match(/\$\{REGIME_ORDER_TOUCH_TARGET\}/g) || []).length, 2)
  assert.equal((dashboardSource.match(/renderTpEditBtn\(order, '(pct|price)'\)/g) || []).length, 2)
  assert.match(dashboardSource, /title="Edit TP target"[\s\S]*?e\.stopPropagation\(\)[\s\S]*?setTpEditModal\(/)
  assert.match(dashboardSource, /title=\{`Roll up into \$\{tgtLabel\}`\}[\s\S]*?e\.stopPropagation\(\)[\s\S]*?setRollUpConfirm\(/)
})

test('order action targets are 44px for narrow or coarse-pointer layouts', () => {
  assert.match(stylesSource, /@media \(pointer: fine\) and \(min-width: 768px\)\s*\{[\s\S]*?\.regime-order-touch-target\s*\{[\s\S]*?min-height: unset;[\s\S]*?min-width: unset;/)
})
