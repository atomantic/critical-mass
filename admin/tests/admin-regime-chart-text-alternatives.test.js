// @vitest-environment node
import { describe, it } from 'vitest'
import assert from 'node:assert/strict'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import * as text from '../src/components/charts/chartDataText.js'
import Price from '../src/components/charts/RegimePriceChart.jsx'
import Vol from '../src/components/charts/VolatilityChart.jsx'
import Timeline from '../src/components/charts/RegimeTimeline.jsx'
import Alt from '../src/components/charts/ChartDataAlternative.jsx'

const MIN = 60 * 1000
const render = (Comp, props) => renderToStaticMarkup(React.createElement(Comp, props))
const svgTag = (html) => html.match(/<svg[^>]*aria-labelledby[^>]*>/)[0]

describe('chartDataText helpers', () => {
  it('summarizes a series keeping missing values distinct from zero', () => {
    const s = text.summarizeSeries([
      { timestamp: 1, v: 0 }, { timestamp: 2, v: null }, { timestamp: 3, v: 5 }, { timestamp: 4, v: undefined }, { timestamp: 5, v: NaN },
    ], 'v')
    assert.equal(s.first.value, 0)
    assert.equal(s.latest.value, 5)
    assert.equal(s.min.value, 0)
    assert.equal(s.max.value, 5)
    assert.equal(s.missing, 3)
    assert.equal(s.trend, 'rose')
    assert.match(text.describeSeries('X', s, String), /3 of 5 samples have no value/)
    assert.equal(text.summarizeSeries([{ timestamp: 1, v: null }], 'v').present, 0)
    assert.match(text.describeSeries('X', text.summarizeSeries([], 'v'), String), /no values available/)
  })

  it('clips regime intervals to the window with the visual boundary rules', () => {
    const regimes = [
      { mode: 'HARVEST', timestamp: 0 },
      { mode: 'CAUTION', timestamp: 100 },
      { mode: 'TREND', timestamp: 100 }, // zero width, invisible
      { mode: 'HARVEST', timestamp: 150 },
      { mode: 'CAUTION', timestamp: 500 }, // starts after window end
    ]
    const out = text.buildRegimeIntervals(regimes, 50, 200)
    assert.deepEqual(JSON.parse(JSON.stringify(out.map(i => [i.mode, i.start, i.end, i.beganBeforeWindow]))), [
      ['HARVEST', 50, 100, true],
      ['TREND', 100, 150, false],
      ['HARVEST', 150, 500, false],
    ])
    assert.equal(text.buildRegimeIntervals([{ mode: 'HARVEST', timestamp: 10 }], 50, 200)[0].ongoing, true)
    assert.equal(text.buildRegimeIntervals([], 0, 10).length, 0)
  })
})

describe('ChartDataAlternative', () => {
  it('renders a closed native disclosure and its summary without building tables', () => {
    const html = render(Alt, {
      summaryId: 'sum', summary: ['hello'],
      getTables: () => { throw new Error('closed disclosure must not build tables') },
    })
    assert.match(html, /<details[^>]*>\s*<summary[^>]*>View chart data<\/summary>/)
    assert.match(html, /<div id="sum"[^>]*><p[^>]*>hello<\/p>/)
    assert.doesNotMatch(html, /<table|aria-live/)
  })
})

describe('regime chart consumers', () => {
  const now = Date.now()
  const prices = [
    { timestamp: now - 10 * MIN, price: 100 },
    { timestamp: now - 2 * MIN, price: 90 },
    { timestamp: now - 6 * MIN, price: null },
    { timestamp: now - 4 * MIN, price: 120 },
    { timestamp: now - 90 * MIN, price: 1 }, // outside the 1h window
  ]
  const regimes = [
    { mode: 'HARVEST', timestamp: now - 30 * MIN },
    { mode: 'TREND', timestamp: now - 5 * MIN },
  ]

  it('price chart exposes a named, described svg with the sorted, filtered samples', () => {
    const html = render(Price, { priceData: prices, regimeData: regimes, anchorPrice: 100, atr: 10, kFactor: 0.5 })
    const tag = svgTag(html)
    const heading = html.match(/<h3 id="([^"]+)"/)[1]
    const summary = html.match(/<div id="([^"]+)" data-chart-summary/)[1]
    assert.match(tag, /role="img"/)
    assert.ok(tag.includes(`aria-labelledby="${heading}"`))
    assert.ok(tag.includes(`aria-describedby="${summary}"`))
    assert.match(html, /4 price samples/)
    assert.match(html, /Price fell from \$100\.00 to \$90\.00 \(low \$90\.00 .*high \$120\.00/)
    assert.match(html, /1 of 4 samples have no value/)
    assert.match(html, /upper trigger \$105\.00, lower trigger \$95\.00/)
    assert.match(html, /HARVEST from \d\d:\d\d:\d\d to \d\d:\d\d:\d\d \(began before the window\); TREND from \d\d:\d\d:\d\d to the latest sample/)
    assert.doesNotMatch(html, /<table/)
    assert.doesNotMatch(html, /\$1\.00/)
  })

  it('volatility chart summarizes every series with units', () => {
    const atrData = [
      { timestamp: now - 2 * MIN, atr1m: 12, atr5m: 15, realizedVol: 0, volBaseline: 1.5 },
      { timestamp: now - 4 * MIN, atr1m: 10, atr5m: 14, realizedVol: 0.5, volBaseline: null },
      { timestamp: now - 40 * MIN, atr1m: 99, atr5m: 99, realizedVol: 9, volBaseline: 9 },
    ]
    const html = render(Vol, { atrData, regimeData: regimes })
    assert.match(svgTag(html), /role="img"/)
    assert.match(html, /2 volatility samples/)
    assert.match(html, /ATR 1m rose from \$10\.00 to \$12\.00/)
    assert.match(html, /Realized volatility fell from 0\.50% to 0\.00%/)
    assert.match(html, /Volatility baseline was unchanged at 1\.50% .*; 1 of 2 samples have no value/)
    assert.doesNotMatch(html, /<table/)
    assert.doesNotMatch(html, /99\.00/)
  })

  it('timeline names regime intervals and handles empty history', () => {
    const html = render(Timeline, { data: regimes })
    assert.match(svgTag(html), /role="img"/)
    assert.match(html, /2 regime intervals: HARVEST from .* to \d\d:\d\d:\d\d; TREND from .* to now/)
    assert.doesNotMatch(html, /<table/)
    const empty = render(Timeline, { data: [] })
    assert.match(empty, /No regime history in the window\./)
    const fallback = render(Timeline, { data: [], currentRegime: { mode: 'CAUTION', since: now - 20 * MIN } })
    assert.match(fallback, /1 regime interval: CAUTION from/)
  })

  it('shows no text alternative while collecting data', () => {
    assert.doesNotMatch(render(Price, { priceData: [] }), /View chart data/)
    assert.doesNotMatch(render(Vol, { atrData: [] }), /View chart data/)
  })
})
