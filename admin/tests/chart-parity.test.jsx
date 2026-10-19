import { describe, expect, it } from 'vitest'
import snapshot from './fixtures/d3-parity.json'
import { PARITY_TZ, chartCases } from './fixtures/chart-series'
import { diffSnapshot, renderChartCase } from './fixtures/chart-harness'
import { AreaChart } from '../src/components/charts/AreaChart'
import { BarChart } from '../src/components/charts/BarChart'
import { ComposedChart } from '../src/components/charts/ComposedChart'
import { PriceChart } from '../src/components/charts/PriceChart'
import { PendingOrdersChart, CostBasisDistributionChart } from '../src/components/charts/PendingOrdersChart'
import RegimePriceChart from '../src/components/charts/RegimePriceChart'
import VolatilityChart from '../src/components/charts/VolatilityChart'
import RegimeTimeline from '../src/components/charts/RegimeTimeline'

// Tick labels format local time; the snapshot was taken in this zone.
process.env.TZ = PARITY_TZ

const COMPONENTS = { AreaChart, BarChart, ComposedChart, PriceChart, PendingOrdersChart, CostBasisDistributionChart, RegimePriceChart, VolatilityChart, RegimeTimeline }
const expected = new Map(snapshot.charts.map((c) => [c.name, c.svg]))

// Every chart must draw the same geometry (paths, ticks, labels, bars, markers) the d3
// implementation drew for the flat/monotonic/spiky/two-point/one-point/empty fixtures.
describe('chart geometry matches the frozen d3 snapshot', () => {
  const cases = chartCases()
  it('covers every snapshot case', () => {
    expect(cases.map((c) => c.name)).toEqual([...expected.keys()])
  })
  for (const c of cases) {
    it(c.name, () => {
      const actual = renderChartCase(COMPONENTS[c.chart], c)
      expect(diffSnapshot(actual, expected.get(c.name))).toBeNull()
    })
  }
})
