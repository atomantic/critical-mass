import React from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import RegimeDashboard from '../src/components/RegimeDashboard'

// Replaces the source-text 'Wiring' asserts at the end of
// tests/open-order-relations.test.js: Open Orders is fed the UNFILTERED fill
// ledger, and the All Cycles / Current Cycle toggle lives in Filled Orders.
const fixture = vi.hoisted(() => ({ status: null, addToast: vi.fn(), setStatus: vi.fn(), initializeFromCache: vi.fn() }))
vi.mock('../src/utils/productId.mjs', () => ({ getBaseCurrency: () => 'BTC', getQuoteCurrency: () => 'USDC' }))
vi.mock('../src/components/Toast', () => ({ useToast: () => ({ addToast: fixture.addToast }) }))
vi.mock('../src/hooks/useTradeEvents', () => ({ useRegimeEvents: () => ({ status: fixture.status, setStatus: fixture.setStatus }) }))
vi.mock('../src/hooks/useChartDataBuffer', () => ({ useChartDataBuffer: () => ({ priceHistory: [], atrHistory: [], regimeHistory: [], initializeFromCache: fixture.initializeFromCache }) }))
vi.mock('../src/components/charts/RegimePriceChart', () => ({ default: () => null }))
vi.mock('../src/components/charts/VolatilityChart', () => ({ default: () => null }))
vi.mock('../src/components/charts/RegimeTimeline', () => ({ default: () => null }))
vi.mock('../src/components/celestial/CelestialVisualization', () => ({ default: () => null }))
HTMLDialogElement.prototype.showModal = function () { this.open = true }
HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new Event('close')) }
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const buy = (orderId, extra) => ({ orderId, side: 'buy', size: 1, price: 100, quoteAmount: 100, timestamp: 1, ...extra })

it('keeps an older cycle\'s buy linked to its open TP when Filled Orders is narrowed to the current cycle', async () => {
  fixture.status = {
    isRunning: true, entryMode: 'ladder', lifecycle: { lifecycle: 'active' },
    market: { lastPrice: 60000 }, position: { cycleBuys: 1, totalAsset: 1, totalCostBasis: 100, avgCostBasis: 100 },
    regime: { mode: 'HARVEST', since: Date.now() }, health: { mode: 'ACTIVE' }, risk: {},
    pendingOrders: [{ orderId: 'tp-old', type: 'take_profit', status: 'open', size: 1, price: 120, placedAt: Date.now() - 1000 }],
  }
  const fills = [buy('old-buy', { cycleId: 'cycle-1', sellOrderId: 'tp-old' }), buy('new-buy', { cycleId: 'cycle-2' })]
  vi.stubGlobal('fetch', vi.fn(async url => ({ ok: true, json: async () =>
    url.includes('/regime/status') ? { status: fixture.status }
    : url.includes('/regime/config') ? { config: { productId: 'BTC-USDC' } }
    : url.includes('/regime/fills') ? { detailFills: fills, fillCount: 2, fillCycleGroups: [], latestCycleId: 'cycle-2' }
    : {} })))
  render(<RegimeDashboard exchange="coinbase" pair="BTC-USDC" />)

  const toggle = await screen.findByRole('button', { name: 'All Cycles' })
  const openRow = async () => (await screen.findByText('tp-old', { exact: false })).closest('tr')
  expect(within(await openRow()).getByText('(1 buy)')).toBeTruthy()
  fireEvent.click(toggle)
  expect(screen.getByRole('button', { name: 'Current Cycle' })).toBeTruthy()
  expect(within(await openRow()).getByText('(1 buy)')).toBeTruthy()
})
