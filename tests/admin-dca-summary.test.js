// Render the DCA summary boundary: unavailable accounting must not look like
// measured zero profit, while a real zero from regime accounting stays valid.
const { before, it } = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const vm = require('node:vm')
const { createRequire } = require('node:module')
const { pathToFileURL } = require('node:url')
const adminRequire = createRequire(path.join(__dirname, '../admin/package.json'))
const React = adminRequire('react')
const { renderToStaticMarkup } = adminRequire('react-dom/server')
let Dashboard
let CostBasisDCA
let StatCard
let ToggleSwitch
let formatCountdown

before(async () => {
  const { rolldown } = await import(pathToFileURL(adminRequire.resolve('rolldown')).href)
  const compile = async name => {
    const bundle = await rolldown({
      input: path.join(__dirname, `../admin/src/components/${name}.jsx`),
      external: () => true,
      transform: { jsx: 'react' },
    })
    let code
    try { code = (await bundle.generate({ format: 'cjs' })).output[0].code }
    finally { await bundle.close() }
    const stubs = {
      react: React,
      '../utils/plural.mjs': { plural: (n, s, p = `${s}s`) => `${n} ${n === 1 ? s : p}` },
      '../utils/pnlFormat.mjs': { pnlColorClass: n => (n >= 0 ? 'text-green-400' : 'text-red-400'), signedPrefix: n => (n >= 0 ? '+' : '') },
      '../utils/actionFailure.mjs': { describeActionFailure: (status, body) => body?.error || body?.message || `HTTP ${status}` },
      '../utils/intervals.mjs': { getIntervalMs: () => 86400000 },
      '../utils/countdown.mjs': { formatCountdown },
      './StatCard': StatCard,
      './ToggleSwitch': ToggleSwitch,
      './ActivityFeed': () => null,
      './FailedSellPlacements': () => null,
      './DcaPlacementRecovery': () => null,
      './DcaPendingBuyRecovery': () => null,
      './ModalDialog': () => null,
      '../utils/requestOwner.mjs': { createRequestOwner: () => ({}) },
      './Toast': { useToast: () => ({ addToast() {} }) },
      './regime/useDcaConversion': { fetchConvertPreview: async () => null },
      './charts/chartUtils': { formatCurrency: n => `$${n.toFixed(2)}`, formatPrice: String, formatAsset: String },
      '../App': { getBaseCurrency: () => 'ETH', getQuoteCurrency: () => 'USDC' },
      '../utils/api': { pairQuery: () => '?pair=ETH-USDC' },
      '../utils/apiClient': { apiGet: async url => { const res = await fetch(url); const data = await res.json(); return { ok: res.ok, status: res.status, data, error: res.ok ? null : `HTTP ${res.status}` } } },
      '../utils/dashboardAction.mjs': { runDashboardAction() {} },
    }
    const m = { exports: {} }
    vm.runInNewContext(code, { React, module: m, exports: m.exports, require: name => {
      assert.ok(name in stubs, `Unexpected import ${name}`)
      return stubs[name]
    } })
    return m.exports.default || m.exports
  }
  ;({ formatCountdown } = await import('../admin/src/utils/countdown.mjs'))
  StatCard = await compile('StatCard')
  ToggleSwitch = await compile('ToggleSwitch')
  Dashboard = await compile('Dashboard')
  CostBasisDCA = await compile('CostBasisDCA')
})

const render = (realizedProfit, costBasis = {}) => renderToStaticMarkup(React.createElement(Dashboard, {
  summary: {
    config: { totalAllocation: 1000, productId: 'ETH-USDC' },
    state: { usdcFundSize: 900, assetReserves: 0.002, orders: [] },
    stats: { totalBuys: 2, totalSells: 1, pendingOrders: 0, allocationUsed: 200,
      allocationRemaining: 800, intervalsRun: 2, totalFees: 3, totalRebates: 1, netFees: 2, realizedProfit },
    costBasis, nextTrade: { enabled: true, remaining: 800, nextTradeAmount: 30,
      nextTradeTime: '2026-01-01T00:00:00.000Z' },
  },
}))

it('shows unavailable DCA realized profit instead of a green zero', () => {
  const html = render(null)
  assert.match(html, /Realized/)
  assert.equal(html.match(/>Realized<\/div><div[^>]*>([^<]*)<\/div>/)[1], '—')
  assert.match(html, /Unavailable for Simple DCA/)
  assert.match(html, /\$900\.00/)
  assert.match(html, /\$30\.00/)
})

it('continues to display a measured zero or nonzero realized profit', () => {
  assert.match(render(0), /\+\$0\.00/)
  assert.match(render(12.34), /\+\$12\.34/)
  assert.doesNotMatch(render(0), /Unavailable for Simple DCA/)
})

it('keeps unavailable Fibonacci holdings costs out of both accounting surfaces', () => {
  const html = render(null, null)
  assert.equal(html.match(/>Float P&amp;L<\/div><div[^>]*>([^<]*)<\/div>/)[1], '—')
  assert.match(html, /Unavailable for Fibonacci DCA/)
  assert.match(html, /Cost: —/)
  const costPage = renderToStaticMarkup(React.createElement(CostBasisDCA, {
    summary: { config: { dcaStrategy: 'fibonacci' }, costBasis: null },
  }))
  assert.match(costPage, /Cost basis is unavailable for Fibonacci DCA/)
  assert.doesNotMatch(costPage, /Run the bot/)
})
