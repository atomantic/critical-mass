import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { TooltipContent } from '../src/components/charts/primitives/Tooltip'
import { CartesianChart } from '../src/components/charts/primitives/CartesianChart'
import BTCPriceChart from '../src/components/charts/BTCPriceChart'
import Backtest from '../src/components/Backtest'
import ScorecardAnalysis from '../src/components/updown/ScorecardAnalysis'

const candles = vi.hoisted(() => ({ chartData: [] }))
vi.mock('../src/hooks/useCandleData', () => ({
  DEFAULT_VIEWS: {},
  default: () => ({
    chartData: candles.chartData,
    view: '1h', setView: () => {}, isLoading: false,
    viewConfig: { bucketMs: 60000, indicatorTf: '1m' }, views: {},
    interval: '1m', setInterval: () => {}, timeRange: '1h', setTimeRange: () => {}, availableRanges: [],
  }),
}))

// jsdom has no layout: give every element a fixed box (getBoundingClientRect stays at 0,0,
// so a pointer's clientX/clientY is its offset inside the hovered element). Legends report
// `legendHeight` (one 24px row unless a test wraps them).
function stubBox(width, height, legendHeight = 24) {
  vi.spyOn(Element.prototype, 'clientWidth', 'get').mockReturnValue(width)
  vi.spyOn(Element.prototype, 'clientHeight', 'get').mockImplementation(function () {
    return this.classList?.contains('chart-legend-box') ? legendHeight : height
  })
}

const tickLabels = (axis) => [...axis.querySelectorAll('.tick text')].map((t) => t.textContent)
const axes = (container) => [...container.querySelectorAll('svg.cartesian-chart > g[text-anchor]')]
const tooltipRows = (container) => [...container.querySelectorAll('.chart-tooltip li')].map((li) => li.textContent)

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('TooltipContent', () => {
  const html = (props) => renderToStaticMarkup(<TooltipContent {...props} />)

  it('renders nothing while inactive or when every value is empty', () => {
    expect(html({ active: false, payload: [{ dataKey: 'price', value: 42000 }] })).toBe('')
    expect(html({ active: true, payload: [] })).toBe('')
    expect(html({ active: true, payload: [{ dataKey: 'price', value: null }] })).toBe('')
  })

  it('formats the label and each series row with the caller styles', () => {
    const out = html({
      active: true,
      label: '12:00',
      payload: [{ dataKey: 'price', name: 'price', value: 42000, color: '#f00' }, { dataKey: 'vwap', name: 'vwap', value: -1, color: '#0f0' }],
      contentStyle: { backgroundColor: '#111827' },
      labelStyle: { color: '#9ca3af' },
      formatter: (value) => (value > 0 ? [`$${value.toLocaleString()}`, 'Price'] : [null, null]),
    })
    expect(out).toMatch(/12:00/)
    expect(out).toMatch(/Price<\/span><span> : <\/span><span>\$42,000/)
    expect(out).toMatch(/#111827/)
    // A formatter returning a null value drops that row.
    expect(out).not.toMatch(/#0f0/)
  })
})

describe('CartesianChart', () => {
  it('breaks a line at empty samples unless connectNulls is set', () => {
    stubBox(400, 200)
    const data = [{ v: 1 }, { v: 2 }, { v: null }, { v: 3 }, { v: 4 }]
    const { container, rerender } = render(<CartesianChart data={data} height={200} series={[{ dataKey: 'v' }]} />)
    const path = () => container.querySelector('.series-line path').getAttribute('d')
    expect(path().match(/M/g)).toHaveLength(2)
    rerender(<CartesianChart data={data} height={200} series={[{ dataKey: 'v', connectNulls: true }]} />)
    expect(path().match(/M/g)).toHaveLength(1)
  })

  it('steps through samples with the arrow keys and clears on blur', () => {
    stubBox(400, 200)
    const data = [{ t: 'a', v: 1 }, { t: 'b', v: 2 }, { t: 'c', v: 3 }]
    const { container } = render(<CartesianChart data={data} height={200} xAxis={{ dataKey: 't' }} tooltip={{}} series={[{ dataKey: 'v' }]} />)
    const svg = container.querySelector('svg.cartesian-chart')
    expect(svg.getAttribute('tabindex')).toBe('0')
    const label = () => container.querySelector('.chart-tooltip p')?.textContent
    fireEvent.keyDown(svg, { key: 'ArrowRight' })
    expect(label()).toBe('a')
    fireEvent.keyDown(svg, { key: 'ArrowRight' })
    fireEvent.keyDown(svg, { key: 'ArrowRight' })
    fireEvent.keyDown(svg, { key: 'ArrowRight' })
    expect(label()).toBe('c')
    fireEvent.keyDown(svg, { key: 'ArrowLeft' })
    expect(label()).toBe('b')
    expect(container.querySelector('[aria-live="polite"] .chart-tooltip')).toBeTruthy()
    fireEvent.blur(svg)
    expect(label()).toBeUndefined()
  })

  it('gives a wrapped legend its measured height', () => {
    stubBox(300, 200, 48)
    const { container } = render(<CartesianChart data={[{ v: 1 }, { v: 2 }]} height={200} legend series={[{ dataKey: 'v' }]} />)
    expect(container.querySelector('svg.cartesian-chart').getAttribute('height')).toBe('152')
  })

  it('clips series to the plot only on axes whose fixed domain the data may exceed', () => {
    stubBox(400, 200)
    const data = [{ v: 1 }, { v: 20 }, { v: 3 }]
    const { container, rerender } = render(<CartesianChart data={data} height={200} yAxes={[{ domain: [0, 10], allowDataOverflow: true }]} series={[{ dataKey: 'v' }]} />)
    const clipRef = container.querySelector('.series-line').getAttribute('clip-path')
    const rect = container.querySelector(`clipPath${clipRef.slice(4, -1)} rect`)
    // Plot: x 65..395 (60px axis + 5px margins), y 5..165 (200 - 2×5 margin - 30 axis).
    expect(['x', 'y', 'width', 'height'].map((k) => rect.getAttribute(k))).toEqual(['65', '5', '330', '160'])
    expect([...container.querySelectorAll('.tick text')].map((t) => t.textContent)).toContain('10')
    rerender(<CartesianChart data={data} height={200} yAxes={[{ domain: [0, 10] }]} series={[{ dataKey: 'v' }]} />)
    expect(container.querySelector('.series-line').getAttribute('clip-path')).toBeNull()
  })
})

describe('BTCPriceChart', () => {
  beforeEach(() => {
    stubBox(600, 260)
    // Every bucket shares one time label: positions must still come from the unique chartIndex.
    candles.chartData = [50000, 50100, 50200, 50300, 50400].map((price, i) => ({
      label: '12:00', price, haOpen: price - 20, haClose: price + 20, haHigh: price + 40, haLow: price - 40,
    }))
  })

  it('renders price ticks, a positioned reference line and a hovered-index tooltip', () => {
    const { container } = render(
      <BTCPriceChart
        exchange="coinbase"
        chartType="heikinAshi"
        defaultInterval="1m"
        referenceLines={[{ y: 50200, stroke: '#10b981', label: 'Target $50,200' }]}
      />,
    )
    const [xAxis, yAxis] = axes(container)
    // Candle highs/lows widen the core range: [49960, 50440] padded 5% → [49936, 50464].
    expect(tickLabels(yAxis)).toEqual(['$50,000', '$50,100', '$50,200', '$50,300', '$50,400'])
    expect(tickLabels(xAxis)).toEqual(['12:00', '12:00', '12:00', '12:00', '12:00'])

    // Plot spans y 5..230 (260 - 5 top - 30 axis); 50200 sits at (50464-50200)/528 of it.
    const rule = container.querySelector('.reference-line line')
    expect(Number(rule.getAttribute('y1'))).toBeCloseTo(5 + 225 * (264 / 528), 6)
    expect(within(container.querySelector('.reference-line')).getByText('Target $50,200')).toBeTruthy()

    const candlesX = [...container.querySelectorAll('rect[stroke]')].map((r) => Number(r.getAttribute('x')))
    expect(candlesX).toHaveLength(5)
    expect(candlesX.every((x, i) => !i || x > candlesX[i - 1])).toBe(true)

    // Plot is 520px wide (600 - 2×5 margin - 70 axis): index 3 sits 390px in.
    fireEvent.mouseMove(container.querySelector('rect.overlay'), { clientX: 385, clientY: 40 })
    expect(container.querySelector('.chart-tooltip p').textContent).toBe('12:00')
    expect(tooltipRows(container)).toEqual(['Price : $50,300'])
    fireEvent.mouseLeave(container.querySelector('rect.overlay'))
    expect(container.querySelector('.chart-tooltip')).toBeNull()
  })
})

const snapshots = [
  { date: '2026-01-01', usdcBalance: 4000, assetValue: 2000, totalValue: 6000, assetPrice: 50000 },
  { date: '2026-01-02', usdcBalance: 5000, assetValue: 4000, totalValue: 9000, assetPrice: 52000 },
  { date: '2026-01-03', usdcBalance: 6000, assetValue: 6000, totalValue: 12000, assetPrice: 61000 },
]

const backtestResult = {
  success: true,
  params: { productId: 'BTC-USDC', intervals: 3, intervalType: 'daily' },
  intervalSnapshots: snapshots,
  pendingOrders: [],
  metrics: {
    fundSize: 10000, roiBasis: 10000, totalInvested: 9000, totalValue: 12000, roi: 20, finalUSDC: 6000,
    assetReserves: 0.01, btcOnOrders: 0.09, totalAsset: 0.1, endPrice: 61000, assetValue: 6000,
    sellsFilled: 1, totalSells: 3, fillRate: 33, avgIntervalsToFill: 1, totalFees: 1, totalRebates: 0.5,
    netFees: 0.5, startPrice: 50000, startDate: '2026-01-01T00:00:00Z', endDate: '2026-01-03T00:00:00Z',
    finalAvailableFunds: 6000, intervalsSkipped: 0, intervalsBought: 3,
  },
}

describe('Backtest portfolio chart', () => {
  it('stacks balances, labels both axes and shows the hovered snapshot', async () => {
    stubBox(600, 320)
    vi.stubGlobal('fetch', vi.fn(async () => ({ json: async () => backtestResult })))
    const { container } = render(<Backtest summary={{ config: { productId: 'BTC-USDC', totalAllocation: 10000 } }} />)
    fireEvent.click(screen.getByRole('button', { name: 'Run Backtest' }))
    await screen.findByText('Portfolio Composition Over Time')

    const [xAxis, usdAxis, priceAxis] = axes(container)
    expect(tickLabels(xAxis)).toEqual(['01-01', '01-02', '01-03'])
    expect(tickLabels(usdAxis)).toEqual(['$0k', '$2k', '$4k', '$6k', '$8k', '$10k', '$12k'])
    expect(tickLabels(priceAxis)).toEqual(['$0k', '$10k', '$20k', '$30k', '$40k', '$50k', '$60k', '$70k'])
    // Recharts ordering: legend entries by value, tooltip rows by series name.
    expect([...container.querySelectorAll('.chart-legend li')].map((li) => li.textContent))
      .toEqual(['BTC Value', 'Total Value', 'USDC', 'basePrice'])

    // The asset area sits on the USDC balance: its first top point is 4000 + 2000 = 6000,
    // halfway up the 256px plot (320 - 24 legend - 2×5 margin - 30 axis) that starts at y 5.
    const assetArea = container.querySelectorAll('.series-area path[stroke="none"]')[1]
    expect(assetArea.getAttribute('d')).toMatch(/^M65,133C/)

    // 470px plot (600 - 2×5 margin - 2×60 axes), so index 2 is the right edge.
    fireEvent.mouseMove(container.querySelector('rect.overlay'), { clientX: 470, clientY: 10 })
    expect(container.querySelector('.chart-tooltip p').textContent).toBe('Date: 2026-01-03')
    expect(tooltipRows(container)).toEqual(['BTC Value : $6,000.00', 'Total Value : $12,000.00', 'USDC : $6,000.00', 'BTC Price : $61,000.00'])
  })
})

describe('ScorecardAnalysis charts', () => {
  it('draws accuracy ticks, the 50% coin-flip line and hovered tooltips', async () => {
    stubBox(600, 192)
    const analysis = {
      summary: { predictions: 10, outcomes: 4 },
      catalog: { indicators: [{ key: 'rsi', label: 'RSI' }, { key: 'macd', label: 'MACD' }], timeframes: ['1m'] },
      accuracyOverTime: [
        { hour: '2026-10-18T09', accuracy: 40 },
        { hour: '2026-10-18T10', accuracy: 55 },
        { hour: '2026-10-18T11', accuracy: 70 },
      ],
      indicatorAccuracyOverTime: [
        { hour: '2026-10-18T09', rsi: 50, macd: 45 },
        { hour: '2026-10-18T10', rsi: 60, macd: null },
      ],
      weightEvolution: [
        { ts: '2026-10-18T09:15:00Z', rsi: 0.25, macd: 0.75 },
        { ts: '2026-10-18T10:15:00Z', rsi: 0.5, macd: 0.5 },
      ],
      failurePatterns: [],
    }
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => analysis })))
    const { container } = render(<MemoryRouter><ScorecardAnalysis /></MemoryRouter>)
    await screen.findByText('Accuracy Over Time')
    await waitFor(() => expect(container.querySelectorAll('svg.cartesian-chart')).toHaveLength(3))

    const [accuracy, trends, weights] = [...container.querySelectorAll('svg.cartesian-chart')].map((svg) => svg.parentElement)
    const [xAxis, yAxis] = axes(accuracy)
    expect(tickLabels(xAxis)).toEqual(['10-18 09:00', '10-18 10:00', '10-18 11:00'])
    expect(tickLabels(yAxis)).toEqual(['0', '20', '40', '60', '80', '100'])
    // Plot spans y 5..157 (192 - 2×5 margin - 30 axis): 50% is its midpoint.
    expect(Number(accuracy.querySelector('.reference-line line').getAttribute('y1'))).toBe(81)

    fireEvent.mouseMove(accuracy.querySelector('rect.overlay'), { clientX: 240, clientY: 20 })
    expect(accuracy.querySelector('.chart-tooltip p').textContent).toBe('10-18 10:00')
    expect(tooltipRows(accuracy)).toEqual(['Accuracy : 55%'])

    expect([...trends.parentElement.querySelectorAll('.chart-legend li')].map((li) => li.textContent)).toEqual(['MACD', 'RSI'])
    fireEvent.mouseMove(trends.querySelector('rect.overlay'), { clientX: 470, clientY: 20 })
    expect(tooltipRows(trends)).toEqual(['RSI : 60%'])

    fireEvent.mouseMove(weights.querySelector('rect.overlay'), { clientX: 0, clientY: 20 })
    expect(weights.querySelector('.chart-tooltip p').textContent).toBe('2026-10-18 09:15')
    expect(tooltipRows(weights)).toEqual(['MACD : 75.0%', 'RSI : 25.0%'])
  })
})
