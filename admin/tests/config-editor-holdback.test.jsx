import React from 'react'
import { cleanup, fireEvent, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'
import { renderWithToasts as render } from './renderWithToasts'
import ConfigEditor from '../src/components/ConfigEditor'

const require = createRequire(import.meta.url)
const { createPositionSizer } = require('../../src/position-sizer')
vi.mock('../src/App', () => ({ getBaseCurrency: () => 'BTC', getQuoteCurrency: () => 'USD' }))
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

it('explains profit allocation with an example matching the production sizer', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({}) })))
  render(<ConfigEditor config={{ productId: 'BTC-USD', regime: { holdbackRatio: 0.5 } }} strategy="regime" />)
  const input = await screen.findByLabelText('Holdback Ratio')
  const explanation = screen.getByText(/Base allocation:/)
  expect(document.getElementById(input.getAttribute('aria-describedby')).textContent).toMatch(/gross TP profit/)
  expect(explanation.textContent).toMatch(/50% of gross TP profit/)
  expect(explanation.textContent).toMatch(/tier multiplies this ratio.*capped at 95%/)
  expect(explanation.textContent).toMatch(/excludes fees.*rounding.*minimum holdback.*exchange minimums.*not guaranteed/)

  const { sellQty, holdbackQty } = createPositionSizer('test-exchange', { holdbackRatio: 0.5 })
    .calculateTakeProfitSize(0.01, 100000, 110000, 1)
  expect(explanation.textContent).toContain(holdbackQty.toFixed(8))
  expect(explanation.textContent).toContain(sellQty.toFixed(8))
  expect(explanation.textContent).toContain(`${(holdbackQty / 0.01 * 100).toFixed(2)}% of the position`)
  expect(explanation.textContent).not.toMatch(/Sell 50%, hold 50% of position/)

  fireEvent.change(input, { target: { value: '0.75' } })
  expect(explanation.textContent).toMatch(/75% of gross TP profit/)
  expect(explanation.textContent).toMatch(/with ratio 0.5 and tier scale 1/)
})
