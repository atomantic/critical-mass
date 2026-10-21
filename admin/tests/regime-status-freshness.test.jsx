// Regime dashboard status freshness (#1388): a stopped emit replaces the running
// snapshot, the newest snapshot wins across socket/HTTP, and silence is flagged.
import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, renderHook, screen, waitFor } from '@testing-library/react'
import RegimeDashboard from '../src/components/RegimeDashboard'
import useRegimeDashboardData from '../src/components/regime/useRegimeDashboardData'
import { mergeRegimeStatus, STATUS_STALE_MS, toUnreachableStatus } from '../src/utils/regimeStatusSnapshot.mjs'

const handlers = new Map()
const socket = {
  connected: true,
  on: (e, h) => { if (!handlers.has(e)) handlers.set(e, new Set()); handlers.get(e).add(h) },
  off: (e, h) => handlers.get(e)?.delete(h),
}
const emitStatus = status => act(() => {
  for (const h of [...(handlers.get('regime:status') || [])]) h({ exchange: 'coinbase', pair: 'BTC-USDC', status })
})

vi.mock('../src/lib/realtime', () => ({ getRealtimeClient: () => socket }))
vi.mock('../src/App', () => ({ getBaseCurrency: () => 'BTC', getQuoteCurrency: () => 'USDC' }))
vi.mock('../src/components/Toast', () => ({ useToast: () => ({ addToast: vi.fn() }) }))
vi.mock('../src/components/charts/RegimePriceChart', () => ({ default: () => <div>Price chart</div> }))
vi.mock('../src/components/charts/VolatilityChart', () => ({ default: () => <div>Volatility chart</div> }))
vi.mock('../src/components/charts/RegimeTimeline', () => ({ default: () => <div>Regime timeline</div> }))
vi.mock('../src/components/celestial/CelestialVisualization', () => ({ default: () => <div>Celestial visualization</div> }))

function runningStatus(lastPrice = 60000) {
  return {
    isRunning: true, entryMode: 'ladder', lifecycle: { lifecycle: 'active' },
    market: { lastPrice, atr1m: 123, atr5m: 234, vwap: 59900, vwapDistance: 0.5, realizedVol: 1, volBaseline: 0.5 },
    position: { cycleBuys: 1, totalAsset: 0.1, totalCostBasis: 5000, avgCostBasis: 50000, ladderActive: true },
    regime: { mode: 'HARVEST', since: Date.now() }, health: { mode: 'ACTIVE' },
    risk: { currentDrawdownPercent: 2, isDrawdownPaused: true },
    ladder: { active: true, pendingOrders: 1, committedUsdc: 250 },
    pendingOrders: [],
    tpOptimizer: { enabled: true, currentConfig: { tpMinPercent: 1, tpMaxPercent: 2, holdbackRatio: 0.5 } },
    sizeOptimizer: { enabled: true, currentConfig: {} },
    fillTimeStats: { count: 5, avgMs: 1200, p50Ms: 1000, p90Ms: 2000, minMs: 500, maxMs: 2500, staleRate: 5 },
  }
}

// Shape of src/regime-status.js buildStoppedRegimeStatus (market service while stopped).
function stoppedStatus(lastPrice = 60100, extra = {}) {
  return {
    isRunning: false, health: { mode: 'STOPPED' },
    position: { cycleBuys: 1, totalAsset: 0.1, totalCostBasis: 5000, avgCostBasis: 50000 },
    market: { lastPrice }, regime: { mode: 'HARVEST' }, pendingOrders: [], apy: {},
    lifecycle: { lifecycle: 'active' }, celestial: null, placementIntents: [], isDryRun: false,
    ...extra,
  }
}

const config = { productId: 'BTC-USDC', maxCycleBuys: 3, baseSizeUsdc: 100, kFactor: 0.6, tpMinPercent: 1, tpMaxPercent: 2, aggressiveness: 'conservative' }
let httpStatus
let statusResponse

beforeEach(() => {
  handlers.clear()
  httpStatus = runningStatus()
  statusResponse = null
  vi.stubGlobal('fetch', vi.fn(async (url) => {
    if (url.includes('/regime/status') && statusResponse) return statusResponse()
    return { ok: true, json: async () => {
      if (url.includes('/regime/config')) return { config }
      if (url.includes('/regime/status')) return { status: httpStatus }
      if (url.includes('/regime/fills')) return { detailFills: [], fillCount: 0, fillCycleGroups: [] }
      if (url.includes('/presets/')) return { presets: {} }
      return {}
    } }
  }))
})
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals() })

// The Entry card's mode label (the help tooltip also mentions LADDER).
const entryModeLabel = () => screen.getAllByText(/^(LADDER|REACTIVE)$/).find(el => el.className.includes('text-xl'))?.textContent

const expectNoRunningPanels = () => {
  expect(screen.queryByRole('button', { name: 'Resume' })).toBeNull()
  expect(screen.queryByRole('heading', { name: 'TP Auto-Management' })).toBeNull()
  expect(screen.queryByRole('heading', { name: 'Size Auto-Management' })).toBeNull()
  expect(screen.queryByRole('heading', { name: 'Fill Time Stats (7d)' })).toBeNull()
  expect(entryModeLabel()).toBe('REACTIVE')
  expect(screen.queryByText('1 order ($250)')).toBeNull()
}

describe('regime status snapshot rules', () => {
  it('replaces on a stopped payload or a running-state change and merges running emits', () => {
    const running = runningStatus()
    const stopped = stoppedStatus()
    expect(mergeRegimeStatus(running, stopped)).toBe(stopped)
    expect(mergeRegimeStatus(stopped, running)).toBe(running)
    expect(mergeRegimeStatus(null, running)).toBe(running)
    expect(mergeRegimeStatus(running, { isRunning: true, market: { lastPrice: 1 } })).toEqual({ ...running, market: { lastPrice: 1 } })
  })

  it('reduces a silent snapshot to stopped-status fields flagged as an unreachable engine', () => {
    const view = toUnreachableStatus(runningStatus())
    expect(view).toMatchObject({ isRunning: false, engineDown: true, statusSilent: true, health: { mode: 'ENGINE_DOWN' }, market: { lastPrice: 60000, stale: true } })
    for (const field of ['risk', 'ladder', 'entryMode', 'tpOptimizer', 'sizeOptimizer', 'fillTimeStats']) expect(view).not.toHaveProperty(field)
  })
})

describe('RegimeDashboard status freshness', () => {
  it('drops running-only panels when a stopped regime:status follows a running one', async () => {
    render(<RegimeDashboard exchange="coinbase" pair="BTC-USDC" />)
    await screen.findByRole('heading', { name: 'Risk Limits' })
    emitStatus(runningStatus())
    expect(screen.getByRole('button', { name: 'Resume' })).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'TP Auto-Management' })).toBeTruthy()
    expect(entryModeLabel()).toBe('LADDER')

    emitStatus(stoppedStatus())
    expect(screen.getByText('Engine Stopped')).toBeTruthy()
    expectNoRunningPanels()
  })

  it('shows a newer HTTP status over an earlier socket snapshot, and a later socket emit over that', async () => {
    const { result } = renderHook(() => useRegimeDashboardData('coinbase', 'BTC-USDC', '?pair=BTC-USDC'))
    await waitFor(() => expect(result.current.loading).toBe(false))
    emitStatus(runningStatus(61000))
    expect(result.current.status.market.lastPrice).toBe(61000)

    httpStatus = stoppedStatus(62000, { engineDown: true, health: { mode: 'ENGINE_DOWN' } })
    await act(async () => { await result.current.fetchStatus() })
    expect(result.current.status).toEqual(httpStatus)

    emitStatus(runningStatus(63000))
    expect(result.current.status.market.lastPrice).toBe(63000)
    expect(result.current.status.isRunning).toBe(true)
  })

  it('flags the engine unreachable after the stale window with no status, until a fresh one arrives', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    render(<RegimeDashboard exchange="coinbase" pair="BTC-USDC" />)
    await screen.findByRole('heading', { name: 'Risk Limits' })
    emitStatus(runningStatus())
    const statusReads = () => fetch.mock.calls.filter(([url]) => url.includes('/regime/status')).length
    const readsBefore = statusReads()
    // The probe hangs, as a request to a wedged gateway path would.
    statusResponse = () => new Promise(() => {})

    await act(async () => { vi.advanceTimersByTime(STATUS_STALE_MS - 1000) })
    expect(screen.queryByText('Engine Unreachable')).toBeNull()

    await act(async () => { vi.advanceTimersByTime(1000) })
    expect(screen.getByText('Engine Unreachable')).toBeTruthy()
    expect(screen.getByText(`No status update in ${STATUS_STALE_MS / 1000}s · showing last known state`)).toBeTruthy()
    expectNoRunningPanels()
    expect(statusReads()).toBe(readsBefore + 1)

    emitStatus(runningStatus())
    expect(screen.queryByText('Engine Unreachable')).toBeNull()
    expect(screen.getByRole('heading', { name: 'TP Auto-Management' })).toBeTruthy()
  })

  it('leaves a quiet stopped fund as Engine Stopped without probing', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    httpStatus = stoppedStatus()
    render(<RegimeDashboard exchange="coinbase" pair="BTC-USDC" />)
    await screen.findByText('Engine Stopped')
    const statusReads = () => fetch.mock.calls.filter(([url]) => url.includes('/regime/status')).length
    const readsBefore = statusReads()
    await act(async () => { vi.advanceTimersByTime(STATUS_STALE_MS * 2) })
    expect(screen.getByText('Engine Stopped')).toBeTruthy()
    expect(screen.queryByText('Engine Unreachable')).toBeNull()
    expect(statusReads()).toBe(readsBefore)
  })
})
