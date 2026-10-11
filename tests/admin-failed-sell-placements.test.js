// issue #1035 — the Simple DCA dashboard never rendered 'sell_failed' rows, so
// a booked buy with no covering sell had no visible failed step and no exit.
// Renders the real component with synthetic status data.
const { before, describe, it } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { createRequire } = require('node:module')
const { pathToFileURL } = require('node:url')

const adminRequire = createRequire(path.join(__dirname, '..', 'admin', 'package.json'))
const React = adminRequire('react')
const { renderToStaticMarkup } = adminRequire('react-dom/server')
let FailedSellPlacements

before(async () => {
  const { rolldown } = await import(pathToFileURL(adminRequire.resolve('rolldown')).href)
  const bundle = await rolldown({
    input: path.join(__dirname, '..', 'admin', 'src', 'components', 'FailedSellPlacements.jsx'),
    external: (id) => !id.startsWith('.') && !path.isAbsolute(id),
    transform: { jsx: 'react' },
  })
  let code
  try { code = (await bundle.generate({ format: 'cjs' })).output[0].code } finally { await bundle.close() }
  const m = { exports: {} }
  vm.runInNewContext(code, { module: m, exports: m.exports, require: adminRequire, console, React })
  FailedSellPlacements = m.exports.default || m.exports
})

const failedRow = {
  buyOrderId: 'buy-synthetic-1',
  buyPrice: 51234.5,
  buyQuantity: 0.00195,
  sellQuantity: 0.001755,
  status: 'sell_failed',
  sellFailedReason: 'Failed to place sell order after 3 attempts: INSUFFICIENT_FUND',
  sellFailedAt: '2026-10-11T12:00:00.000Z',
}

const render = (props) => renderToStaticMarkup(React.createElement(FailedSellPlacements, { baseCurrency: 'BTC', ...props }))

describe('FailedSellPlacements (issue #1035)', () => {
  it('renders nothing when no sell placement failed', () => {
    assert.equal(render({ failedSells: [] }), '')
    assert.equal(render({}), '')
  })

  it('shows each failed buy with its id, bought quantity, reason and a Retry sell action', () => {
    const html = render({ failedSells: [failedRow], placementIntents: [] })
    assert.match(html, /Failed Sell Placements \(1\)/)
    assert.match(html, /buy-synthetic-1/)
    assert.match(html, /0\.00195 BTC/)
    assert.match(html, /INSUFFICIENT_FUND/)
    assert.match(html, /2026-10-11 12:00:00/)
    const button = html.match(/<button[^>]*>[^<]*<\/button>/)[0]
    assert.match(button, />Retry sell</)
    assert.doesNotMatch(button, /disabled/)
  })

  it('blocks retry and shows the reconcile path while a placement intent needs attention', () => {
    const html = render({
      failedSells: [{ ...failedRow, sellPlacementUnresolved: { intentId: 'intent-42', clientOrderId: 'coid-42' } }],
      placementIntents: [
        { id: 'intent-42', clientOrderId: 'coid-42', needsAttention: true, recoveryHint: 'Check client order id coid-42 on the exchange' },
        { id: 'in-flight', needsAttention: false, recoveryHint: 'not shown' },
      ],
    })
    assert.match(html, /Retry is blocked/)
    assert.match(html, /Check client order id coid-42 on the exchange/)
    assert.doesNotMatch(html, /not shown/)
    assert.match(html, /Earlier sell outcome unknown \(intent <span[^>]*>intent-42/)
    assert.match(html.match(/<button[^>]*>/)[0], /disabled/)
  })

  it('labels only the row being retried and disables the others meanwhile', () => {
    const html = render({ failedSells: [failedRow, { ...failedRow, buyOrderId: 'buy-synthetic-2' }], retryingBuyId: 'buy-synthetic-1' })
    const buttons = html.match(/<button[^>]*>[^<]*<\/button>/g)
    assert.equal(buttons.length, 2)
    assert.match(buttons[0], />Retrying\.\.\.</)
    assert.match(buttons[1], />Retry sell</)
    assert.ok(buttons.every(b => /disabled/.test(b)))
  })
})

describe('Dashboard wiring (issue #1035)', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'admin', 'src', 'components', 'Dashboard.jsx'), 'utf8')

  it('feeds the section from the live DCA status read, outside the pending-orders table', () => {
    assert.match(source, /<FailedSellPlacements[\s\S]*?failedSells=\{liveData\?\.failedSells\}/)
    assert.match(source, /placementIntents=\{liveData\?\.placementIntents\}/)
    assert.ok(source.indexOf('<FailedSellPlacements') < source.indexOf('{/* Pending Orders */}'))
  })

  it('posts the buy id to the retry route and refreshes status afterwards', () => {
    assert.match(source, /retry-failed-sell\$\{pairQuery\}/)
    assert.match(source, /JSON\.stringify\(\{ buyOrderId \}\)/)
    assert.match(source, /onSettled: \(\) => fetchLive\(\)/)
  })
})
