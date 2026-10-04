const { before, describe, it } = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const vm = require('node:vm')
const { createRequire } = require('node:module')
const { pathToFileURL } = require('node:url')

const adminRequire = createRequire(path.join(__dirname, '..', 'admin', 'package.json'))
const React = adminRequire('react')
const { renderToStaticMarkup } = adminRequire('react-dom/server')
const charts = path.join(__dirname, '..', 'admin', 'src', 'components', 'charts')

async function load(file) {
  const { rolldown } = await import(pathToFileURL(adminRequire.resolve('rolldown')).href)
  const bundle = await rolldown({
    input: path.join(charts, file),
    external: (id) => id === 'react' || id.startsWith('react/') || id.startsWith('react-dom'),
    transform: { jsx: 'react' },
  })
  let code
  try { code = (await bundle.generate({ format: 'cjs' })).output[0].code } finally { await bundle.close() }
  const m = { exports: {} }
  vm.runInNewContext(code, {
    module: m, exports: m.exports, require: adminRequire, console, React,
    ResizeObserver: class { observe() {} disconnect() {} },
  })
  return m.exports
}

let text, Price, Vol, Timeline, Alt

before(async () => {
  ;[text, Price, Vol, Timeline, Alt] = await Promise.all([
    load('chartDataText.js'),
    load('RegimePriceChart.jsx'),
    load('VolatilityChart.jsx'),
    load('RegimeTimeline.jsx'),
    load('ChartDataAlternative.jsx'),
  ])
})

const MIN = 60 * 1000
// A lone default export bundles to `module.exports = Component`.
const comp = (mod) => mod.default || mod
const render = (Comp, props) => renderToStaticMarkup(React.createElement(comp(Comp), props))
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
  const columns = [{ key: 'a', label: 'Time' }, { key: 'b', label: 'Value (USD)' }]
  it('renders a native details disclosure with a captioned table and scoped headers', () => {
    const html = renderToStaticMarkup(React.createElement(comp(Alt), {
      summaryId: 'sum', summary: ['hello'], tables: [{ caption: 'Cap', columns, rows: [{ a: 't1', b: '$1' }] }],
    }))
    assert.match(html, /<details[^>]*>\s*<summary[^>]*>View chart data<\/summary>/)
    assert.match(html, /<caption[^>]*>Cap<\/caption>/)
    assert.match(html, /<th scope="col"[^>]*>Value \(USD\)<\/th>/)
    assert.match(html, /<div id="sum"[^>]*><p[^>]*>hello<\/p>/)
    assert.doesNotMatch(html, /aria-live/)
    assert.doesNotMatch(html, /Next/) // single page: no pagination
  })

  it('paginates numeric samples at 100 rows', () => {
    const rows = Array.from({ length: 250 }, (_, i) => ({ a: `t${i}`, b: `$${i}` }))
    const html = renderToStaticMarkup(React.createElement(comp(Alt), { summaryId: 's', tables: [{ caption: 'Cap', columns, rows }] }))
    assert.equal((html.match(/<tr /g) || []).length, 100)
    assert.match(html, /Rows 1 to 100 of 250/)
    assert.match(html, /<button type="button"[^>]*disabled=""[^>]*>Previous<\/button>/)
    assert.match(html, /<button type="button"[^>]*>Next<\/button>/)
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
    assert.match(html, /Latest sample \(/)
    // chronological rows, outside-window sample excluded, missing shown as such
    const rows = [...html.matchAll(/<tr [^>]*><th scope="row"[^>]*>([^<]*)<\/th><td[^>]*>([^<]*)<\/td>/g)].map(m => m[2])
    assert.deepEqual(rows.slice(0, 4), ['$100.00', 'missing', '$120.00', '$90.00'])
    assert.doesNotMatch(html, /\$1\.00/)
  })

  it('volatility chart lists every series with units and sorted rows', () => {
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
    for (const h of ['ATR 1m \\(USD\\)', 'ATR 5m \\(USD\\)', 'Realized volatility \\(%\\)', 'Volatility baseline \\(%\\)']) {
      assert.match(html, new RegExp(`<th scope="col"[^>]*>${h}</th>`))
    }
    assert.match(html, /<td[^>]*>missing<\/td>/)
    assert.doesNotMatch(html, /99\.00/)
  })

  it('timeline names regime intervals and handles empty history', () => {
    const html = render(Timeline, { data: regimes })
    assert.match(svgTag(html), /role="img"/)
    assert.match(html, /2 regime intervals: HARVEST from .* to \d\d:\d\d:\d\d; TREND from .* to now/)
    assert.match(html, /<th scope="col"[^>]*>Duration<\/th>/)
    assert.match(html, /Now \(/)
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
