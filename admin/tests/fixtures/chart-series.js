// Synthetic chart inputs shared by the d3 parity snapshot (frozen in d3-parity.json) and the
// owned-chart tests. Changing anything here invalidates the snapshot, which can no longer be
// regenerated now that d3 is gone — add new cases instead of editing these.

// Local time zone the snapshot was taken in. America/New_York crosses the 2026-03-08 DST
// change inside the day/week fixtures, so local-day tick boundaries are exercised.
export const PARITY_TZ = 'America/New_York'
export const NOW = Date.UTC(2026, 2, 8, 15, 0, 0)

export const SHAPES = {
  flat: [100, 100, 100, 100, 100, 100],
  monotonic: [10, 20, 35, 50, 80, 120],
  spiky: [50, 200, 20, 180, 10, 220, 60],
  twoPoints: [40, 90],
  onePoint: [75],
  empty: [],
}

// Sample spacing per shape so the time axes cover minute, hour, day and week tick intervals.
const MINUTE = 60e3
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
export const STEPS = {
  flat: 15 * MINUTE,
  monotonic: DAY,
  spiky: 6 * HOUR,
  twoPoints: 7 * DAY,
  onePoint: HOUR,
  empty: MINUTE,
}

export const SIZES = { wide: { width: 640, height: 240 }, narrow: { width: 280, height: 160 } }

const timed = (values, step) => values.map((v, i) => ({ t: NOW - (values.length - 1 - i) * step, v }))
const iso = (t) => new Date(t).toISOString()

const REGIMES = [
  { offset: 50 * MINUTE, mode: 'HARVEST' },
  { offset: 20 * MINUTE, mode: 'CAUTION' },
  { offset: 5 * MINUTE, mode: 'TREND' },
]

function dcaCases(shape, values, step) {
  const points = timed(values, step)
  const mean = values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0
  return [
    ['AreaChart', { data: points.map(({ t, v }) => ({ date: iso(t), fundSize: v })), title: 'Fund Balance', valueKey: 'fundSize' }],
    ['BarChart', {
      data: points.map(({ t, v }, i) => ({ date: iso(t), bought: v, sold: i % 2 ? v / 2 : 0 })),
      title: 'Volume',
      series: [
        { key: 'bought', color: '#3b82f6', label: 'Bought (USDC)' },
        { key: 'sold', color: '#10b981', label: 'Sold (USDC)' },
      ],
    }],
    ['ComposedChart', {
      data: points.map(({ t, v }, i) => ({ date: iso(t), cumFees: v * 0.01 * (i + 1), cumRebates: v * 0.004 * (i + 1), netFees: v * 0.006 * (i + 1) })),
      title: 'Fees',
      areas: [
        { key: 'cumFees', color: '#ef4444', label: 'Fees' },
        { key: 'cumRebates', color: '#10b981', label: 'Rebates' },
      ],
      lines: [{ key: 'netFees', color: '#8b5cf6', label: 'Net', strokeWidth: 2 }],
    }],
    ['PriceChart', {
      priceData: points.map(({ t, v }) => ({ date: iso(t), price: 1000 + v })),
      buyData: points.map(({ t, v }) => ({ date: iso(t), price: 1000 + v })),
      sellData: points.filter((_, i) => i % 2 === 0).map(({ t, v }) => ({ date: iso(t), price: 1000 + v, sellPrice: (1000 + v) * 1.04 })),
      avgCostBasis: values.length ? 1000 + mean : 0,
    }],
    // Same timestamp for every sample switches PriceChart to its index-based x scale.
    ['PriceChart', {
      priceData: values.map((v) => ({ date: iso(NOW), price: 1000 + v })),
      buyData: [],
      sellData: values.map((v) => ({ date: iso(NOW), price: 1000 + v, sellPrice: (1000 + v) * 1.04 })),
      avgCostBasis: 0,
    }, 'index'],
    ['PendingOrdersChart', {
      orders: values.map((v, i) => ({ sellPrice: 1000 + v * 3, buyPrice: 960 + v * 3, sellQuantity: 0.001 * (i + 1) })),
      currentPrice: 1000 + mean * 3,
    }],
    ['CostBasisDistributionChart', {
      orders: values.map((v) => ({ buyPrice: 1000 + v })),
      currentPrice: 1090,
    }],
  ].map(([chart, props, variant]) => ({ name: `${chart}:${shape}${variant ? `:${variant}` : ''}`, chart, props }))
}

function regimeCases(shape, values) {
  const regimeData = REGIMES.map(({ offset, mode }) => ({ timestamp: NOW - offset, mode }))
  const modes = ['HARVEST', 'CAUTION', 'TREND']
  return [
    ['RegimePriceChart', {
      priceData: values.map((v, i) => ({ timestamp: NOW - (values.length - 1 - i) * 5 * MINUTE, price: 60000 + v * 10 })),
      regimeData,
      currentPrice: 61000,
      anchorPrice: 60800,
      atr: 400,
      kFactor: 0.6,
      height: 280,
    }],
    ['VolatilityChart', {
      atrData: values.map((v, i) => ({ timestamp: NOW - (values.length - 1 - i) * 2 * MINUTE, atr1m: v, atr5m: v * 1.3, realizedVol: v / 50, volBaseline: 1.5 })),
      regimeData,
      height: 300,
    }],
    ['RegimeTimeline', {
      data: values.map((v, i) => ({ timestamp: NOW - (values.length - i) * 9 * MINUTE + v * 1000, mode: modes[i % 3] })),
      currentRegime: { mode: 'CAUTION', since: NOW - 30 * MINUTE },
      height: 60,
    }],
  ].map(([chart, props]) => ({ name: `${chart}:${shape}`, chart, props }))
}

// Every chart-level parity case, in snapshot order.
export function chartCases() {
  const cases = []
  for (const [shape, values] of Object.entries(SHAPES)) {
    cases.push(...dcaCases(shape, values, STEPS[shape]).map((c) => ({ ...c, size: 'wide' })))
    cases.push(...regimeCases(shape, values).map((c) => ({ ...c, size: 'wide' })))
  }
  // Narrow container: responsive margins, font sizes and tick counts.
  cases.push(...dcaCases('monotonic', SHAPES.monotonic, STEPS.monotonic).map((c) => ({ ...c, name: `${c.name}:narrow`, size: 'narrow' })))
  return cases
}

// Generator-level parity inputs for the owned chart-math module.
export const LINEAR_DOMAINS = [
  [0, 1], [0, 100], [0, 113000], [-3.7, 12.2], [0.0001, 0.00093], [100, 100], [49990, 50120],
  [5, -5], [0, 0], [1e-7, 3e-7], [0, 3], [0, 7], [96.5, 222.1], [-0.42, 0.37], [0, 1.1], [1, 2],
]
export const TICK_COUNTS = [1, 2, 5, 6, 10]

export const TIME_SPANS = [
  800, 9e3, 70e3, 7 * MINUTE, 50 * MINUTE, 3 * HOUR, 20 * HOUR, 2.5 * DAY, 9 * DAY, 40 * DAY,
  200 * DAY, 3 * 365 * DAY, 30 * 365 * DAY,
]
export const TIME_TICK_COUNTS = [4, 6, 8, 10]
// Unaligned start offsets so ceil/floor alignment is exercised, not just round boundaries.
export const TIME_OFFSETS = [0, 37_123]

export const PATH_SERIES = {
  ...Object.fromEntries(Object.entries(SHAPES).map(([name, values]) => [name, values.map((v, i) => [i * 50, 200 - v])])),
  coincidentStart: [[0, 10], [0, 10], [50, 20], [100, 5]],
  verticalStep: [[0, 10], [50, 10], [50, 30], [100, 20], [150, 25]],
  decreasingX: [[150, 10], [100, 40], [50, 20], [0, 30]],
  fractional: [[0.12345, 9.87654], [33.3333, 1.11111], [66.6667, 7.77777], [99.9999, 3.33333]],
}
// Null samples break the line (recharts connectNulls=false semantics).
export const GAPPED_SERIES = [10, null, 30, 40, null, null, 70, 80, null, 95].map((v, i) => [i * 40, v])

export const BAND_CASES = [
  { domain: [], padding: 0.2 },
  { domain: ['a'], padding: 0.2 },
  { domain: ['a', 'b', 'c'], padding: 0.2 },
  { domain: ['a', 'b', 'a', 'c', 'd', 'e', 'f'], padding: 0.2 },
  { domain: ['bought', 'sold'], padding: 0.05, range: [0, 57.3] },
]

export const BIN_VALUES = {
  ...SHAPES,
  prices: [1012.5, 1031.2, 1008.9, 1077.4, 1050, 1050, 1099.99, 1003.1],
  tiny: [0.00012, 0.00031, 0.00019, 0.00027],
}
