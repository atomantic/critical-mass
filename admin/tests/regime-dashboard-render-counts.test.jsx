import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import RegimeDashboard from '../src/components/RegimeDashboard'
import { shareStructure } from '../src/utils/structuralShare.mjs'

// Render counters: the real leaf components are kept (including their real
// React.memo comparison); only the inner render function is wrapped to count.
const renders = vi.hoisted(() => ({ filled: 0, volatility: 0, timeline: 0, priceChart: 0, openOrders: 0, config: 0, lastPrice: null }))
const store = vi.hoisted(() => ({ status: null, seq: 1_000_000, listeners: new Set() }))

async function counted(path, key, { passthrough = false, onProps } = {}) {
  const actual = await vi.importActual(path)
  const Real = actual.default
  const Inner = Real.type ?? Real
  const Counted = (props) => { renders[key] += 1; onProps?.(props); return passthrough ? Inner(props) : null }
  return { ...actual, default: Real.type ? React.memo(Counted, Real.compare) : Counted }
}

vi.mock('../src/utils/productId.mjs', () => ({ getBaseCurrency: () => 'BTC', getQuoteCurrency: () => 'USDC' }))
const toast = vi.hoisted(() => ({ value: { addToast: () => null } }))
vi.mock('../src/components/Toast', () => ({ useToast: () => toast.value }))
vi.mock('../src/hooks/useTradeEvents', async () => {
  const react = await import('react')
  return {
    useRegimeEvents: () => {
      const [, force] = react.useState(0)
      react.useEffect(() => { const l = () => force(n => n + 1); store.listeners.add(l); return () => store.listeners.delete(l) }, [])
      return { status: store.status, statusSeq: store.seq, setStatus: () => {} }
    },
  }
})
const stableHistory = vi.hoisted(() => ({ priceHistory: [], atrHistory: [], regimeHistory: [], initializeFromCache: () => {} }))
vi.mock('../src/hooks/useChartDataBuffer', () => ({ useChartDataBuffer: () => stableHistory }))
vi.mock('../src/components/charts/VolatilityChart', () => counted('../src/components/charts/VolatilityChart', 'volatility'))
vi.mock('../src/components/charts/RegimeTimeline', () => counted('../src/components/charts/RegimeTimeline', 'timeline'))
vi.mock('../src/components/charts/RegimePriceChart', () => counted('../src/components/charts/RegimePriceChart', 'priceChart', { onProps: p => { renders.lastPrice = p.currentPrice } }))
vi.mock('../src/components/regime/FilledOrdersSection', () => counted('../src/components/regime/FilledOrdersSection', 'filled', { passthrough: true }))
vi.mock('../src/components/regime/OpenOrdersTable', () => counted('../src/components/regime/OpenOrdersTable', 'openOrders', { passthrough: true }))
vi.mock('../src/components/regime/ConfigurationSummary', () => counted('../src/components/regime/ConfigurationSummary', 'config', { passthrough: true }))
vi.mock('../src/components/celestial/CelestialVisualization', () => ({ default: () => null }))

const config = { productId: 'BTC-USDC', maxCycleBuys: 3, kFactor: 0.6, tpMinPercent: 1, tpMaxPercent: 2, aggressiveness: 'conservative' }
const aggregates = {
  detailFills: [], fillCount: 5, cycleCount: 1, sellOrderCount: 1, latestCycleId: 'cycle-1',
  totalPnl: 90, totalHoldback: 0.1, detailsTruncated: true,
  cycles: [{ cycleId: 'cycle-1', entryCount: 4, exitCount: 1 }],
  fillCycleGroups: [{ cycleId: 'cycle-1', sellCount: 1, buyCount: 1, totalSize: 5, totalPnl: 90, totalHoldback: 0.1, minTs: 1, maxTs: 2 }],
  fillCycleCount: 1,
}
const statusAt = (lastPrice, totalAsset = 0.1) => ({
  isRunning: true, entryMode: 'ladder', lifecycle: { lifecycle: 'active' },
  market: { lastPrice, atr1m: 123, atr5m: 234, vwap: 59900, vwapDistance: 0.5, realizedVol: 1, volBaseline: 0.5 },
  position: { cycleBuys: 1, totalAsset, totalCostBasis: 5000, avgCostBasis: 50000, realizedPnL: 90, realizedAssetPnL: 0.1 },
  regime: { mode: 'HARVEST', since: 1 }, health: { mode: 'ACTIVE' }, risk: {},
  pendingOrders: [{ orderId: 'tp-1', type: 'take_profit', side: 'sell', size: 0.01, price: 61000, timestamp: 1, status: 'open' }],
  placementIntents: [], config,
})
// A socket push deserialises brand-new objects every time.
const push = (status) => act(() => { store.status = JSON.parse(JSON.stringify(status)); store.seq += 1; store.listeners.forEach(l => l()) })
const snapshot = () => ({ ...renders })

beforeEach(() => {
  Object.assign(renders, { filled: 0, volatility: 0, timeline: 0, priceChart: 0, openOrders: 0, config: 0, lastPrice: null })
  store.status = JSON.parse(JSON.stringify(statusAt(60000)))
  vi.stubGlobal('fetch', vi.fn(async (url) => ({ ok: true, json: async () => {
    if (url.includes('/regime/config')) return { config }
    if (url.includes('/regime/status')) return { status: store.status }
    if (url.includes('/regime/fills')) return aggregates
    if (url.includes('/presets/')) return { presets: {} }
    return {}
  } })))
})
afterEach(() => { cleanup(); vi.unstubAllGlobals(); store.listeners.clear() })

describe('shareStructure', () => {
  it('reuses unchanged subtrees and replaces changed ones', () => {
    const a = { x: { n: 1 }, list: [{ id: 1 }, { id: 2 }], p: 1 }
    const b = shareStructure(a, JSON.parse(JSON.stringify({ ...a, p: 2 })))
    expect(b).not.toBe(a)
    expect(b.x).toBe(a.x)
    expect(b.list).toBe(a.list)
    expect(shareStructure(a, JSON.parse(JSON.stringify(a)))).toBe(a)
  })
})

describe('RegimeDashboard render counts on 1s status pushes', () => {
  async function settle() {
    render(<RegimeDashboard exchange="coinbase" pair="BTC-USDC" />)
    await screen.findByText(/1 sell across 1 cycle/)
    // let the config/fills/chart reads finish committing
    await act(async () => { await new Promise(r => setTimeout(r, 20)) })
  }

  it('a price-only push re-renders neither the fills table, nor the other charts, orders or config, yet price still updates', async () => {
    await settle()
    const before = snapshot()
    const totalsBefore = screen.getByText(/1 sell across 1 cycle/).parentElement.textContent
    expect(renders.lastPrice).toBe(60000)

    await push(statusAt(61000))

    const after = snapshot()
    expect(after.filled).toBe(before.filled)
    expect(after.volatility).toBe(before.volatility)
    expect(after.timeline).toBe(before.timeline)
    expect(after.openOrders).toBe(before.openOrders)
    expect(after.config).toBe(before.config)
    // Live price still flows: the price chart gets it, the header shows it, and the
    // mark-to-market grand total (a context consumer) updates without the table rendering.
    expect(after.priceChart).toBe(before.priceChart + 1)
    expect(renders.lastPrice).toBe(61000)
    expect(document.body.textContent).toContain('61,000')
    expect(screen.getByText(/1 sell across 1 cycle/).parentElement.textContent).not.toBe(totalsBefore)
  })

  it('a position-only push updates the position but still skips the fills table and charts', async () => {
    await settle()
    const before = snapshot()
    const textBefore = document.body.textContent

    await push(statusAt(60000, 0.25))

    expect(document.body.textContent).not.toBe(textBefore)
    expect(document.body.textContent).toContain('0.25')
    const after = snapshot()
    expect(after.filled).toBe(before.filled)
    expect(after.volatility).toBe(before.volatility)
    expect(after.timeline).toBe(before.timeline)
    expect(after.priceChart).toBe(before.priceChart)
    expect(after.config).toBe(before.config)
  })

  it('an identical push is a no-op for every memoised leaf', async () => {
    await settle()
    const before = snapshot()
    await push(statusAt(60000))
    expect(snapshot()).toEqual(before)
  })
})
