// Synthetic-only fixture: no gateway, exchanges, operator data or credentials.
import React, { StrictMode, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { CartesianChart } from '../src/components/charts/primitives/CartesianChart'
import BTCPriceChart from '../src/components/charts/BTCPriceChart'
import HeikinAshiRenderer from '../src/components/charts/HeikinAshiRenderer'
import AtomokuCloudRenderer from '../src/components/charts/AtomokuCloudRenderer'
import SignalAnnotationRenderer from '../src/components/charts/SignalAnnotationRenderer'
import CelestialVisualization from '../src/components/celestial/CelestialVisualization'
import { TIER_ORDER } from '../src/components/celestial/celestialConstants'

window.__smokeDraws = 0
for (const Context of [window.WebGLRenderingContext, window.WebGL2RenderingContext]) {
  if (!Context) continue
  for (const method of ['drawArrays', 'drawElements']) {
    const original = Context.prototype[method]
    Context.prototype[method] = function (...args) {
      window.__smokeDraws++
      return original.apply(this, args)
    }
  }
}

const now = Math.floor(Date.now() / 60000) * 60000
const candles = Array.from({ length: 180 }, (_, i) => ({
  timestamp: now - (179 - i) * 60000,
  open: 50000 + i * 5, close: 50002 + i * 5, high: 50010 + i * 5, low: 49990 + i * 5, volume: 10,
}))
window.fetch = async url => {
  if (url === '/api/candles/coinbase') return { ok: true, json: async () => ({ candles: { '1m': candles } }) }
  throw new Error('Unexpected synthetic fixture request')
}
const annotations = [{ timestamp: candles.at(-10).timestamp, type: 'OPEN' }]
const data = [0, 1, 2, 3].map(chartIndex => ({
  chartIndex, label: '12:00', price: 105 + chartIndex,
  haOpen: 104 + chartIndex, haClose: 106 + chartIndex, haHigh: 108 + chartIndex, haLow: 102 + chartIndex,
  atomokuLead1: 109 + chartIndex, atomokuLead2: 103 + chartIndex,
  atomokuConv: 107 + chartIndex, atomokuBase: 105 + chartIndex,
  signalChange: { type: ['OPEN', 'ADD', 'CLOSE', 'HOLD'][chartIndex] },
}))
const celestial = { enabled: true, bodies: TIER_ORDER.map((tier, i) => ({
  id: 'fixture-' + tier, tier, costBasis: 1000 / (i + 1), assetQty: 0.01, tpPrice: 51000,
})) }

function Fixture() {
  const [width, setWidth] = useState(800)
  const [empty, setEmpty] = useState(false)
  return <div style={{ width }} id="fixture">
    <button id="resize" onClick={() => setWidth(420)}>Resize</button>
    <button id="empty" onClick={() => setEmpty(true)}>Empty</button>
    <div id="layers"><CartesianChart data={empty ? [] : data} height={260}
      xAxis={{ tickFormatter: index => data[index].label }}
      yAxes={[{ domain: [100, 120] }]}
      series={[{ dataKey: 'price' }]}
      underlay={<>
        <HeikinAshiRenderer data={empty ? [] : data} />
        <AtomokuCloudRenderer data={empty ? [] : data} />
        <SignalAnnotationRenderer data={empty ? [] : data} />
      </>} /></div>
    <div id="btc"><BTCPriceChart exchange="coinbase" chartType="heikinAshi"
      showIntervalSelector defaultInterval="1m" defaultRange="3h"
      overlays={['atomoku']} signalAnnotations={annotations} /></div>
    <CelestialVisualization celestial={celestial} maxUsdcDeployed={10000} />
  </div>
}
const root = createRoot(document.getElementById('root'))
root.render(<StrictMode><Fixture /></StrictMode>)
window.__smokeUnmount = () => root.unmount()
