// Regime dashboard status freshness (#1388): a stopped emit replaces the running
// snapshot, the newest snapshot wins across socket/HTTP, and silence is flagged.
import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react'
import RegimeDashboard from '../src/components/RegimeDashboard'
import useRegimeDashboardData from '../src/components/regime/useRegimeDashboardData'
import useRegimeDashboardActions from '../src/components/regime/useRegimeDashboardActions'
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
const addToast = vi.hoisted(() => vi.fn())
vi.mock('../src/components/Toast', () => ({ useToast: () => ({ addToast }) }))
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
let mutationResponse

const reply = (data, status = 200) => ({ ok: status < 400, status, json: async () => data })
const statusReads = () => fetch.mock.calls.filter(([url]) => url.includes('/regime/status')).length

// Exercise the real confirmation dialogs in jsdom.
HTMLDialogElement.prototype.showModal = function () { this.open = true }
HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new Event('close')) }

beforeEach(() => {
  handlers.clear()
  addToast.mockClear()
  httpStatus = runningStatus()
  statusResponse = null
  mutationResponse = null
  vi.stubGlobal('fetch', vi.fn(async (url, options) => {
    if (options?.method === 'POST' && mutationResponse) return mutationResponse()
    if (url.includes('/regime/status') && statusResponse) return statusResponse()
    return { ok: true, json: async () => {
      if (url.includes('/regime/config')) return { config }
      if (url.includes('/regime/status')) return { status: httpStatus }
      if (url.includes('/regime/fills')) return { detailFills: [], fillCount: 0, fillCycleGroups: [] }
      if (url.includes('/regime/preview-ladder')) return { success: true, preview: { levelCount: 1, levels: [{ price: 59000, sizeUsdc: 100, assetQty: 0.001, distancePct: 1 }], totalBudget: 100, lowerBoundPct: 10 } }
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

  it('keeps a socket emit that lands while an HTTP status read is in flight', async () => {
    const { result } = renderHook(() => useRegimeDashboardData('coinbase', 'BTC-USDC', '?pair=BTC-USDC'))
    await waitFor(() => expect(result.current.loading).toBe(false))
    let respond
    statusResponse = () => new Promise(resolve => { respond = resolve })
    let read
    act(() => { read = result.current.fetchStatus() })
    emitStatus(stoppedStatus(60500))
    await act(async () => {
      respond({ ok: true, json: async () => ({ status: runningStatus(60400) }) })
      await read
    })
    expect(result.current.status.isRunning).toBe(false)
    expect(result.current.status.market.lastPrice).toBe(60500)
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


function useDashboardWithActions() {
  const data = useRegimeDashboardData('coinbase', 'BTC-USDC', '?pair=BTC-USDC')
  const actions = useRegimeDashboardActions({ exchange: 'coinbase', pairQuery: '?pair=BTC-USDC', addToast, ...data })
  return { ...data, ...actions }
}

describe('mutation/socket status ordering', () => {
  it.each([
    ['roll-up', 'handleRollUp', ['body-1']],
    ['collapse', 'handleCollapseAll', []],
    ['reset cycle', 'handleResetCycle', []],
    ['TP percentage', 'handleSetTp', ['pct']],
    ['TP price', 'handleSetTp', ['price']],
    ['ladder cancellation', 'handleExecuteCancelLadder', []],
  ])('refreshes current status after a late %s reply without reviving running state', async (_name, action, args) => {
    const { result } = renderHook(useDashboardWithActions)
    await waitFor(() => expect(result.current.loading).toBe(false))
    if (action === 'handleSetTp') act(() => result.current.setTpEditModal({ bodyId: 'body-1', inputValue: '2', priceValue: '61000', avgPrice: 50000 }))
    let respond
    mutationResponse = () => new Promise(resolve => { respond = resolve })
    let mutation
    act(() => { mutation = result.current[action](...args) })
    await waitFor(() => expect(respond).toBeTypeOf('function'))
    emitStatus(stoppedStatus(61000))
    httpStatus = stoppedStatus(62000)
    const readsBefore = statusReads()
    await act(async () => { respond(reply({ success: true, status: runningStatus(60000) })); await mutation })
    expect(statusReads()).toBe(readsBefore + 1)
    expect(result.current.status).toEqual(httpStatus)
    expect(result.current.isRunning).toBe(false)
    expect(addToast.mock.calls.some(([toast]) => toast.type === 'error')).toBe(false)
  })

  it('keeps a socket stop delivered during the post-mutation status read', async () => {
    const { result } = renderHook(useDashboardWithActions)
    await waitFor(() => expect(result.current.loading).toBe(false))
    mutationResponse = async () => reply({ success: true, status: runningStatus(60000) })
    let respond
    statusResponse = () => new Promise(resolve => { respond = resolve })
    let mutation
    act(() => { mutation = result.current.handleResetCycle() })
    await waitFor(() => expect(respond).toBeTypeOf('function'))
    emitStatus(stoppedStatus(63000))
    await act(async () => { respond(reply({ status: runningStatus(62000) })); await mutation })
    expect(result.current.status).toEqual(stoppedStatus(63000))
  })

  it.each([
    ['handleCollapseAll', 'Collapse failed'],
    ['handleResetCycle', 'Cycle reset failed'],
  ])('refreshes a partial %s failure without losing its action error or applying its snapshot', async (action, title) => {
    const { result } = renderHook(useDashboardWithActions)
    await waitFor(() => expect(result.current.loading).toBe(false))
    let respond
    mutationResponse = () => new Promise(resolve => { respond = resolve })
    let mutation
    act(() => { mutation = result.current[action]() })
    await waitFor(() => expect(respond).toBeTypeOf('function'))
    emitStatus(stoppedStatus(61000))
    httpStatus = stoppedStatus(62000)
    await act(async () => { respond(reply({ success: false, error: 'Synthetic partial failure', status: runningStatus() }, 400)); await mutation })
    expect(result.current.status).toEqual(httpStatus)
    expect(addToast).toHaveBeenCalledWith({ type: 'error', title, message: 'Synthetic partial failure' })
  })

  it.each(['rebuild ladder', 'reconcile placement'])('orders the rendered %s panel refresh after a late reply', async action => {
    httpStatus = { ...runningStatus(), config: { entryMode: 'ladder' }, placementIntents: [{ id: 'intent-1', clientOrderId: 'client-1', status: 'unresolved', needsAttention: true, action: 'entry', side: 'buy' }] }
    render(<RegimeDashboard exchange="coinbase" pair="BTC-USDC" />)
    await screen.findByRole('heading', { name: 'Risk Limits' })
    let respond
    mutationResponse = () => new Promise(resolve => { respond = resolve })
    if (action === 'rebuild ladder') {
      fireEvent.click(screen.getByRole('button', { name: 'Rebuild Ladder' }))
      fireEvent.click(await screen.findByRole('button', { name: 'Place 1 Order' }))
    } else {
      fireEvent.click(screen.getByRole('button', { name: 'Adopt', exact: true }))
      fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Look up & adopt' }))
    }
    await waitFor(() => expect(respond).toBeTypeOf('function'))
    emitStatus(stoppedStatus(61000))
    httpStatus = stoppedStatus(62000)
    const readsBefore = statusReads()
    await act(async () => { respond(reply({ success: true, status: runningStatus() })) })
    await waitFor(() => expect(statusReads()).toBe(readsBefore + 1))
    expect(screen.getByText('Engine Stopped')).toBeTruthy()
    expectNoRunningPanels()
  })

  it('keeps the last valid stopped state and shows inline Retry when a mutation refresh fails', async () => {
    httpStatus = { ...runningStatus(), position: { ...runningStatus().position, cycleBuys: 3 } }
    render(<RegimeDashboard exchange="coinbase" pair="BTC-USDC" />)
    fireEvent.click(await screen.findByRole('button', { name: 'Reset cycle & resume buying' }))
    mutationResponse = async () => reply({ success: true, status: runningStatus() })
    statusResponse = async () => reply({}, 504)
    emitStatus(stoppedStatus(61000))
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Reset cycle & resume buying' }))
    expect((await screen.findByRole('alert')).textContent).toContain('Status request failed')
    expect(screen.getByRole('alert').textContent).toContain('Showing last good data (stale)')
    expectNoRunningPanels()
    statusResponse = null
    httpStatus = stoppedStatus(62000)
    fireEvent.click(screen.getByRole('button', { name: 'Retry', exact: true }))
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
    expect(screen.getByText('Engine Stopped')).toBeTruthy()
    expectNoRunningPanels()
  })
})
