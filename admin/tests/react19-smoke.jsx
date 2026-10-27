// Synthetic-only fixture: no gateway, exchanges, operator data or credentials.
import React, { StrictMode, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { CartesianChart } from '../src/components/charts/primitives/CartesianChart'
import BTCPriceChart from '../src/components/charts/BTCPriceChart'
import { AreaChart } from '../src/components/charts/AreaChart'
import HeikinAshiRenderer from '../src/components/charts/HeikinAshiRenderer'
import AtomokuCloudRenderer from '../src/components/charts/AtomokuCloudRenderer'
import SignalAnnotationRenderer from '../src/components/charts/SignalAnnotationRenderer'
import { _roots } from '@react-three/fiber'
import CelestialVisualization from '../src/components/celestial/CelestialVisualization'
import { TIER_ORDER } from '../src/components/celestial/celestialConstants'

// Pause motion so previews mount in the supported static state (also what a reduced-motion operator gets).
window.localStorage.setItem('celestial-motion-paused', 'true')
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
const balances = [0, 1, 2, 3, 4, 5].map(i => ({ date: new Date(now - (5 - i) * 3600000).toISOString(), value: 100 + i * 7 }))
const celestial = { enabled: true, bodies: TIER_ORDER.map((tier, i) => ({
  id: 'fixture-' + tier, tier, costBasis: 1000 / (i + 1), assetQty: 0.01, tpPrice: 51000,
})) }

// Tier-valid five-body system (issue #1812): 20% / 8% / 3% / 1.5% / 0.5% of maxUsdcDeployed.
const FIVE_TIER_BODIES = [['sun', 2000], ['planet', 800], ['moon', 300], ['asteroid', 150], ['satellite', 50]]
  .map(([tier, costBasis]) => ({ id: 'five-' + tier, tier, costBasis, assetQty: 0.01, tpPrice: 51000 }))
const SAME_TIER_BODIES = [['sun', 2000], ['moon', 300], ['moon', 280], ['moon', 260], ['satellite', 50]]
  .map(([tier, costBasis], i) => ({ id: 'sib-' + i, tier, costBasis, assetQty: 0.01, tpPrice: 51000 }))
const celestialOf = bodies => ({ enabled: true, bodies })

// Projects every visible mesh's world bounding sphere through the scene's real camera into
// normalized device coordinates; the smoke asserts all of them sit inside [-1, 1].
// `elapsed` seeds the orbit clock so nested motion can be checked away from phase zero.
window.__celestialProjection = async (selector, elapsed = 0) => {
  const state = _roots.get(document.querySelector(selector + ' canvas'))?.store.getState()
  if (!state) return null
  const frames = window.__smokeDraws
  state.clock.elapsedTime = elapsed
  state.invalidate()
  while (window.__smokeDraws < frames + 2) await new Promise(resolve => requestAnimationFrame(resolve))
  const { camera, scene } = state
  camera.updateMatrixWorld()
  scene.updateMatrixWorld(true)
  const tanV = Math.tan((camera.fov * Math.PI) / 360)
  const meshes = []
  scene.traverse(obj => {
    if (!obj.isMesh || !obj.geometry) return
    for (let node = obj; node; node = node.parent) if (!node.visible) return
    if (obj.material?.visible === false) return
    obj.geometry.boundingSphere ??= (obj.geometry.computeBoundingSphere(), obj.geometry.boundingSphere)
    const sphere = obj.geometry.boundingSphere?.clone().applyMatrix4(obj.matrixWorld)
    if (!sphere || !Number.isFinite(sphere.radius)) return
    const viewDepth = -sphere.center.clone().applyMatrix4(camera.matrixWorldInverse).z
    const ndc = sphere.center.clone().project(camera)
    const ry = sphere.radius / (viewDepth * tanV)
    meshes.push({ minX: ndc.x - ry / camera.aspect, maxX: ndc.x + ry / camera.aspect, minY: ndc.y - ry, maxY: ndc.y + ry, viewDepth })
  })
  const bounds = meshes.reduce((acc, m) => ({
    minX: Math.min(acc.minX, m.minX), maxX: Math.max(acc.maxX, m.maxX),
    minY: Math.min(acc.minY, m.minY), maxY: Math.max(acc.maxY, m.maxY),
  }), { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity })
  return { count: meshes.length, bounds, nearest: Math.min(...meshes.map(m => m.viewDepth)), camera: camera.position.toArray(), aspect: camera.aspect }
}

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
    {/* The fixture ships without Tailwind; these are the only utilities the DCA svg needs. */}
    <style>{'.w-full{width:100%}.h-full{height:100%}'}</style>
    <div id="area" style={{ height: 160 }}><AreaChart data={balances} title="Smoke" /></div>
    <div id="btc"><BTCPriceChart exchange="coinbase" chartType="heikinAshi"
      showIntervalSelector defaultInterval="1m" defaultRange="3h"
      overlays={['atomoku']} signalAnnotations={annotations} /></div>
    <CelestialVisualization celestial={celestial} maxUsdcDeployed={10000} />
    {/* Overview-card (379px) and 390px-viewport (326px) previews of the tier-valid system. */}
    <div id="celestial-five-desktop" style={{ width: 379 }}><CelestialVisualization celestial={celestialOf(FIVE_TIER_BODIES)} maxUsdcDeployed={10000} /></div>
    <div id="celestial-five-mobile" style={{ width: 326 }}><CelestialVisualization celestial={celestialOf(FIVE_TIER_BODIES)} maxUsdcDeployed={10000} /></div>
    <div id="celestial-single" style={{ width: 379 }}><CelestialVisualization celestial={celestialOf(FIVE_TIER_BODIES.slice(0, 1))} maxUsdcDeployed={10000} /></div>
    <div id="celestial-siblings" style={{ width: 379 }}><CelestialVisualization celestial={celestialOf(SAME_TIER_BODIES)} maxUsdcDeployed={10000} /></div>
    <div id="celestial-empty" style={{ width: 379 }}><CelestialVisualization celestial={celestialOf([])} maxUsdcDeployed={10000} /></div>
  </div>
}
const root = createRoot(document.getElementById('root'))
root.render(<StrictMode><Fixture /></StrictMode>)
window.__smokeUnmount = () => root.unmount()
