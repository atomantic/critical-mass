import { describe, it } from 'vitest'
import assert from 'node:assert/strict'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import Card from '../src/components/ClosedFundCard.jsx'
import { BrowserRouter } from '../src/lib/router.jsx'

describe('ClosedFundCard layout', () => {
  const longPair = 'VERYLONGSYNTHETICBASEASSET-VERYLONGSYNTHETICQUOTEASSET'
  const render = (card) => renderToStaticMarkup(
    React.createElement(BrowserRouter, null, React.createElement(Card, { card, icon: 'G', iconClass: 'bg-blue-600' })))

  it('wraps and shrinks identity and summary instead of overflowing', () => {
    const html = render({ exchange: 'gemini', pair: longPair, cyclesCompleted: 12, realizedPnL: 123.45 })
    const link = html.match(/<a[^>]*>/)[0]
    assert.match(link, /flex-wrap/)
    assert.match(link, /min-w-0/)
    assert.doesNotMatch(link, /whitespace-nowrap/)
    assert.match(html, /min-w-0[^"]*wrap-break-word/)
    assert.match(html, /wrap-anywhere/)
    assert.match(html, new RegExp(`href="/gemini/${longPair}"`))
  })

  it('keeps cycles, P&L and Closed text visible', () => {
    const html = render({ exchange: 'gemini', pair: 'BTCUSD', cyclesCompleted: 3, realizedPnL: -5 })
    assert.match(html, /3 cycles/)
    assert.match(html, /text-red-500/)
    assert.match(html, />Closed</)
  })
})
