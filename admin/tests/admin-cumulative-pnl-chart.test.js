// @vitest-environment node
import { describe, it } from 'vitest'
import assert from 'node:assert/strict'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import * as G from '../src/components/charts/cumulativePnlGeometry.js'
import Chart from '../src/components/charts/CumulativePnlChart.jsx'

const series = (vals) => vals.map((v, i) => ({ date: new Date(1700000000000 + i * 60000), pnl: 0, cumulative: v }))
const bounded = (g, view) => g.coords.every(c =>
  Number.isFinite(c.x) && Number.isFinite(c.y) && c.x >= 0 && c.x <= view.width && c.y >= 0 && c.y <= view.height)

describe('cumulative P&L chart', () => {
  it('keeps 1500 points inside the viewBox with a bounded path', () => {
    const vals = Array.from({ length: 1500 }, (_, i) => Math.sin(i / 50) * 100 + i / 10)
    const g = G.buildPnlGeometry(series(vals))
    assert.equal(g.coords.length, 1500)
    assert.ok(bounded(g, G.PNL_VIEW))
    assert.ok(g.path.startsWith('M'))
  })

  it('handles empty, single, all-zero and mixed-sign input', () => {
    assert.equal(G.buildPnlGeometry([]).coords.length, 0)
    for (const vals of [[5], [0, 0, 0], [-10, 20, -5, 0], [-3, -1], [2, 4]]) {
      const g = G.buildPnlGeometry(series(vals))
      assert.ok(bounded(g, G.PNL_VIEW), JSON.stringify(vals))
      assert.ok(Number.isFinite(g.zeroY) && g.zeroY >= 0 && g.zeroY <= G.PNL_VIEW.height)
    }
    const mixed = G.buildPnlGeometry(series([-10, 20]))
    assert.ok(mixed.coords[1].y < mixed.zeroY && mixed.coords[0].y > mixed.zeroY)
  })

  it('handles identical timestamps', () => {
    const pts = [1, 2, 3].map(v => ({ date: new Date(1700000000000), cumulative: v }))
    assert.ok(bounded(G.buildPnlGeometry(pts), G.PNL_VIEW))
  })

  it('renders svg, range control and selected value; no per-point bars', () => {
    const html = renderToStaticMarkup(React.createElement(Chart, { points: series([1, -2, 3.5]) }))
    assert.match(html, /<svg[^>]*viewBox="0 0 600 160"/)
    assert.match(html, /type="range"[^>]*max="2"/)
    assert.match(html, /\$3\.50/)
    assert.doesNotMatch(html, /gap-1/)
    assert.equal(renderToStaticMarkup(React.createElement(Chart, { points: [] })), '')
    assert.doesNotMatch(renderToStaticMarkup(React.createElement(Chart, { points: series([4]) })), /type="range"/)
  })
})
