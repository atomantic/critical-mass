import { describe, expect, it } from 'vitest'
import snapshot from './fixtures/d3-parity.json'
import { GAPPED_SERIES, PARITY_TZ, PATH_SERIES } from './fixtures/chart-series'
import { sameNumbers } from './fixtures/chart-harness'
import {
  areaPath, bandScale, extent, formatTime, histogram, linePath, linearScale, max, min, timeScale, trianglePath,
} from '../src/lib/chart-math'

// The snapshot's local-time ticks were taken in this zone (DST change inside the fixtures).
process.env.TZ = PARITY_TZ

// JSON turns NaN/undefined into null; compare through the same round trip.
const json = (value) => JSON.parse(JSON.stringify(value ?? null))
const close = (actual, expected) =>
  expect(json(actual).map((v, i) => (v == null || expected[i] == null ? v : Math.abs(v - expected[i]) <= 1e-6 ? expected[i] : v))).toEqual(expected)
const samePath = (actual, expected) => {
  if (!sameNumbers(actual, expected)) expect(actual).toBe(expected)
}

describe('chart-math reproduces d3 7.9', () => {
  it('linear ticks, nice domains, default labels, mapping and invert', () => {
    for (const c of snapshot.linear) {
      const scale = linearScale(c.domain, [240, 0])
      const label = `${c.domain} / ${c.count}`
      expect(json(scale.ticks(c.count)), label).toEqual(c.ticks)
      expect(json(scale.ticks(c.count).map(scale.tickFormat(c.count))), label).toEqual(c.labels)
      expect(json(scale.nice(c.count).domain()), label).toEqual(c.nice)
      const [d0, d1] = c.domain
      close([d0, d1, (d0 + d1) / 2, d1 * 2 - d0 + 1].map(scale), c.mapped)
      close([0, 60, 240, 300].map(scale.invert), c.inverted)
    }
  })

  it('local-time ticks across second to multi-year spans', () => {
    for (const c of snapshot.time) {
      const scale = timeScale(c.domain, [0, 600])
      expect(scale.ticks(c.count).map(Number), `${c.domain} / ${c.count}`).toEqual(c.ticks)
      const [t0, t1] = c.domain
      close([t0, (t0 + t1) / 2, t1].map(scale), c.mapped)
      close([0, 150, 600].map((p) => +scale.invert(p)), c.inverted)
    }
  })

  it('monotone-x line and area paths', () => {
    const { gapped, ...series } = snapshot.paths
    expect(Object.keys(series)).toEqual(Object.keys(PATH_SERIES))
    for (const [name, pts] of Object.entries(PATH_SERIES)) {
      samePath(linePath(pts), series[name].line)
      samePath(areaPath(pts, { y0: 200 }), series[name].area)
      samePath(areaPath(pts, { y0: (d) => d[1] + 15 }), series[name].areaBand)
    }
    const defined = (d) => d[1] != null
    samePath(linePath(GAPPED_SERIES, { defined }), gapped.line)
    samePath(areaPath(GAPPED_SERIES, { y0: 200, defined }), gapped.area)
  })

  it('band scale positions and bandwidth', () => {
    for (const c of snapshot.band) {
      const scale = bandScale(c.domain, c.range, { padding: c.padding })
      expect(json(c.domain.map(scale))).toEqual(c.positions)
      expect(scale.bandwidth()).toBeCloseTo(c.bandwidth, 9)
      expect(scale.step()).toBeCloseTo(c.step, 9)
      expect(json(scale('zz'))).toEqual(c.unknown)
    }
  })

  it('histogram bins over a fixed domain', () => {
    for (const c of snapshot.bins) {
      const bins = histogram(c.values, { domain: c.domain, thresholds: c.thresholds })
      expect(json(bins.map((b) => [b.x0, b.x1, b.values.length])), c.name).toEqual(c.bins)
    }
  })

  it('triangle symbol, %H:%M format and extent/max/min', () => {
    for (const c of snapshot.triangles) expect(trianglePath(c.size)).toBe(c.d)
    const hm = formatTime('%H:%M')
    for (const c of snapshot.timeFormat) expect(hm(new Date(c.t))).toBe(c.text)
    for (const c of snapshot.arrays) {
      expect(json(extent(c.values))).toEqual(c.extent)
      expect(json(max(c.values))).toEqual(c.max)
      expect(json(min(c.values))).toEqual(c.min)
    }
  })
})
