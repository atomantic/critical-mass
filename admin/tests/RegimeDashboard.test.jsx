import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import RegimeDashboard from '../src/components/RegimeDashboard'

const fixture = vi.hoisted(() => ({ status: null, addToast: vi.fn(), setStatus: vi.fn(), initializeFromCache: vi.fn() }))
vi.mock('../src/App', () => ({ getBaseCurrency: () => 'BTC', getQuoteCurrency: () => 'USDC' }))
vi.mock('../src/components/Toast', () => ({ useToast: () => ({ addToast: fixture.addToast }) }))
vi.mock('../src/hooks/useTradeEvents', () => ({ useRegimeEvents: () => ({ status: fixture.status, setStatus: fixture.setStatus }) }))
vi.mock('../src/hooks/useChartDataBuffer', () => ({ useChartDataBuffer: () => ({ priceHistory: [], atrHistory: [], regimeHistory: [], initializeFromCache: fixture.initializeFromCache }) }))
// Canvas/WebGL/chart engines are separately covered by the browser smoke harness.
vi.mock('../src/components/charts/RegimePriceChart', () => ({ default: () => <div>Price chart</div> }))
vi.mock('../src/components/charts/VolatilityChart', () => ({ default: () => <div>Volatility chart</div> }))
vi.mock('../src/components/charts/RegimeTimeline', () => ({ default: () => <div>Regime timeline</div> }))
vi.mock('../src/components/celestial/CelestialVisualization', () => ({ default: () => <div>Celestial visualization</div> }))

function runningStatus() {
  return {
    isRunning: true, entryMode: 'ladder', lifecycle: { lifecycle: 'active' },
    market: { lastPrice: 60000, atr1m: 123, atr5m: 234, vwap: 59900, vwapDistance: 0.5, realizedVol: 1, volBaseline: 0.5 },
    position: { cycleBuys: 3, totalAsset: 0.1, totalCostBasis: 5000, avgCostBasis: 50000, ladderActive: true, lastEntryTime: Date.now() - 5000 },
    regime: { mode: 'HARVEST', since: Date.now() }, health: { mode: 'ACTIVE' },
    risk: { currentDrawdownPercent: 2, isDrawdownPaused: true },
    celestial: { enabled: true, bodiesActive: 2, bodies: [{ id: 'body-1' }, { id: 'body-2' }] },
    ladder: { active: true, pendingOrders: 1, committedUsdc: 250 },
    pendingOrders: [{ orderId: 'ladder-1', type: 'ladder', side: 'buy', size: 0.01, price: 59000, timestamp: Date.now() }],
    placementIntents: [{ id: 'intent-1', needsAttention: true, status: 'unresolved', action: 'entry', side: 'buy', size: 0.01, price: 59000, clientOrderId: 'client-1', createdAt: Date.now(), recoveryHint: 'Check exchange order' }],
    macro: { mode: 'ACCUMULATION', score: 70, emas: { h21: 61000, h50: 62000, h200: 63000, d20: 64000 } },
    fillTimeStats: { count: 5, avgMs: 1200, p50Ms: 1000, p90Ms: 2000, minMs: 500, maxMs: 2500, staleRate: 5 },
    effectiveStaleMs: 10000,
    tpOptimizer: { enabled: true, currentConfig: { tpMinPercent: 1, tpMaxPercent: 2, holdbackRatio: 0.5 } },
    sizeOptimizer: { enabled: true, currentConfig: {} },
  }
}
const config = { productId: 'BTC-USDC', maxCycleBuys: 3, macroEnabled: true, baseSizeUsdc: 100, kFactor: 0.6, minIntervalMs: 60000, maxIntervalMs: 3600000, tpMinPercent: 1, tpMaxPercent: 2, cautionScale: 0.5, trendScale: 0, aggressiveness: 'conservative' }
const presets = { conservative: { kFactor: 0.6 }, moderate: { kFactor: 0.8 }, aggressive: { kFactor: 1 }, maximum: { kFactor: 1.2 } }

// jsdom has no native modal top layer; expose the dialog while exercising its real component.
HTMLDialogElement.prototype.showModal = function () { this.open = true }
HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new Event('close')) }

beforeEach(() => {
  fixture.status = runningStatus()
  vi.stubGlobal('fetch', vi.fn(async (url) => ({ ok: true, json: async () => {
    if (url.includes('/regime/config')) return { config }
    if (url.includes('/regime/status')) return { status: fixture.status }
    if (url.includes('/regime/fills')) return { fills: [] }
    if (url.includes('/presets/')) return { presets }
    return {}
  } })))
})
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.clearAllMocks() })

async function renderDashboard() {
  render(<RegimeDashboard exchange="coinbase" pair="BTC-USDC" />)
  await screen.findByRole('heading', { name: 'Risk Limits' })
}

describe('RegimeDashboard behavior pin', () => {
  it('renders the running fund sections, bodies, open ladder and blocking placement', async () => {
    await renderDashboard()
    for (const heading of ['Volatility', 'TP Auto-Management', 'Size Auto-Management', 'Fill Time Stats (7d)', 'Risk Limits', 'Position', 'Macro Regime', 'Configuration Summary', 'Open Orders', 'Unresolved Placements (1)']) {
      expect(screen.getByRole('heading', { name: heading })).toBeTruthy()
    }
    for (const value of ['Entry Status', 'HARVEST', 'LADDER', '1 orders ($250)', 'Check exchange order', 'New buys paused — cycle buy-limit reached (3/3)', '$123.00', '1.2s', '2 active / 0 completed']) {
      expect(screen.getAllByText(value, { exact: false }).length).toBeGreaterThan(0)
    }
    expect(screen.getByRole('button', { name: 'Collapse All (2)' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Reset cycle & resume buying' })).toBeTruthy()
  })

  it('confirms a placement adoption before dispatch and preserves its fund payload', async () => {
    await renderDashboard()
    fireEvent.click(screen.getByRole('button', { name: 'Adopt', exact: true }))
    const dialog = screen.getByRole('dialog')
    expect(fetch.mock.calls.some(([url]) => url.includes('reconcile-placement-intent'))).toBe(false)
    fireEvent.click(within(dialog).getByRole('button', { name: /adopt/i }))
    await waitFor(() => expect(fetch.mock.calls.some(([url]) => url.includes('reconcile-placement-intent'))).toBe(true))
    const [url, options] = fetch.mock.calls.find(([url]) => url.includes('reconcile-placement-intent'))
    expect(url).toBe('/api/coinbase/regime/reconcile-placement-intent?pair=BTC-USDC')
    expect(JSON.parse(options.body)).toEqual({ intentId: 'intent-1', action: 'adopt' })
  })

  it('previews aggressiveness without writing until Apply', async () => {
    await renderDashboard()
    fireEvent.click(screen.getByRole('button', { name: /Moderate/ }))
    expect(fetch.mock.calls.some(([, options]) => options?.method === 'PUT')).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: /Apply Moderate/ }))
    await waitFor(() => expect(fetch.mock.calls.some(([, options]) => options?.method === 'PUT')).toBe(true))
    const [, options] = fetch.mock.calls.find(([, options]) => options?.method === 'PUT')
    expect(JSON.parse(options.body)).toEqual({ aggressiveness: 'moderate', kFactor: 0.8 })
  })

  it('keeps the reset-cycle action hidden for a draining fund', async () => {
    fixture.status.lifecycle.lifecycle = 'draining'
    await renderDashboard()
    expect(screen.getByText(/New buys paused/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Reset cycle & resume buying' })).toBeNull()
  })

  it('renders the long-term bias breakdown and its advisory apply action', async () => {
    fixture.status.macro.longTermBias = {
      ready: true, suggestedLevel: 'moderate', score: 0.7, sampleSize: 90,
      cache: { health: 'full', coveragePct: 100, lookbackDays: 90 },
      components: { percentile: { weight: 0.6, score: 0.8 }, drawdown: { weight: 0.3, score: 0.5, drawdownPct: 10 }, zscore: { weight: 0.1, score: 0.4, zscore: -1 } },
    }
    await renderDashboard()
    expect(screen.getByRole('heading', { name: 'Long-Term Bias' })).toBeTruthy()
    expect(screen.getByText('Percentile of range (60%)')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Apply Suggested (Moderate)' }))
    await waitFor(() => expect(fetch.mock.calls.some(([, options]) => options?.method === 'PUT')).toBe(true))
    const [, options] = fetch.mock.calls.find(([, options]) => options?.method === 'PUT')
    expect(JSON.parse(options.body)).toEqual({ aggressiveness: 'moderate', kFactor: 0.8 })
  })

  it('renders historical dry-run analytics without live placement intents', async () => {
    fixture.status.isDryRun = true
    fixture.status.dryRun = { optimalTpAnalytics: { cycleCount: 2, avgOptimalTpPct: 1.5, avgActualTpPct: 1, avgMissedProfitPct: 0.5, avgTimeToMaxMs: 5000, recommendedTpRange: { min: 1, max: 2, median: 1.5 } } }
    await renderDashboard()
    expect(screen.getByRole('heading', { name: 'Optimal TP Analysis' })).toBeTruthy()
    expect(screen.getByText('Avg Optimal TP')).toBeTruthy()
    expect(screen.getByText('Recommended TP Range')).toBeTruthy()
    expect(screen.queryByRole('heading', { name: 'Unresolved Placements (1)' })).toBeNull()
  })
})
