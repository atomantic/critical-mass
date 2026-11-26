// @vitest-environment node
import { describe, it } from 'vitest'
import assert from 'node:assert/strict'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import FailedSellPlacements from '../src/components/FailedSellPlacements.jsx'

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
    assert.doesNotMatch(button, /\sdisabled(?:\s|=|>)/)
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
    assert.match(html.match(/<button[^>]*>/)[0], /\sdisabled(?:\s|=|>)/)
  })

  it('labels only the row being retried and disables the others meanwhile', () => {
    const html = render({ failedSells: [failedRow, { ...failedRow, buyOrderId: 'buy-synthetic-2' }], retryingBuyId: 'buy-synthetic-1' })
    const buttons = html.match(/<button[^>]*>[^<]*<\/button>/g)
    assert.equal(buttons.length, 2)
    assert.match(buttons[0], />Retrying\.\.\.</)
    assert.match(buttons[1], />Retry sell</)
    assert.ok(buttons.every(b => /\sdisabled(?:\s|=|>)/.test(b)))
  })
})
