// Render harness + SVG serializer shared by the frozen d3 parity snapshot and the parity test,
// so both sides render every case under identical container size, clock and time zone.
import { render } from '@testing-library/react'
import { vi } from 'vitest'
import { NOW, SIZES } from './chart-series'

// Geometry and labels only: colours/styles are not part of the parity contract.
const GEOMETRY = ['width', 'height', 'transform', 'd', 'x', 'y', 'x1', 'x2', 'y1', 'y2', 'cx', 'cy', 'r', 'points', 'dy']
const TAGS = new Set(['svg', 'g', 'path', 'line', 'rect', 'circle', 'text', 'polygon'])
// Hover-only layers (focus marker, pointer overlay) are rendered lazily by the owned charts.
const SKIP_CLASS = /(^|\s)(focus|overlay)(\s|$)/

export function serializeSvg(container) {
  // The regime charts carry an info-icon svg in their heading; the plot is the role="img" one.
  const svg = container.querySelector('svg[role="img"]') || container.querySelector('svg')
  if (!svg) return [['placeholder', {}, container.textContent.trim()]]
  const out = []
  const walk = (el) => {
    if (SKIP_CLASS.test(el.getAttribute('class') || '')) return
    const tag = el.tagName.toLowerCase()
    if (TAGS.has(tag)) {
      const attrs = {}
      for (const name of GEOMETRY) {
        const value = el.getAttribute(name)
        if (value != null) attrs[name] = value
      }
      if (tag !== 'g' || attrs.transform) out.push(tag === 'text' ? [tag, attrs, el.textContent] : [tag, attrs])
    }
    for (const child of el.children) walk(child)
  }
  walk(svg)
  return out
}

class StaticResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

export function renderChartCase(Component, chartCase) {
  const { width, height } = SIZES[chartCase.size]
  vi.spyOn(Element.prototype, 'clientWidth', 'get').mockReturnValue(width)
  vi.spyOn(Element.prototype, 'clientHeight', 'get').mockReturnValue(height)
  vi.stubGlobal('ResizeObserver', StaticResizeObserver)
  vi.useFakeTimers({ now: NOW, toFake: ['Date'] })
  const result = render(<Component {...chartCase.props} />)
  const snapshot = serializeSvg(result.container)
  result.unmount()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  return snapshot
}

// Numeric tokens may differ by float noise only; every other character must match exactly.
const NUMBER = /-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/gi

export function sameNumbers(actual, expected, tolerance = 1e-6) {
  if (actual === expected) return true
  if (typeof actual !== 'string' || typeof expected !== 'string') return false
  if (actual.replace(NUMBER, '#') !== expected.replace(NUMBER, '#')) return false
  const a = actual.match(NUMBER) || []
  const b = expected.match(NUMBER) || []
  return a.length === b.length && a.every((n, i) => Math.abs(Number(n) - Number(b[i])) <= tolerance)
}

export function diffSnapshot(actual, expected) {
  const len = Math.max(actual.length, expected.length)
  for (let i = 0; i < len; i++) {
    const [aTag, aAttrs = {}, aText] = actual[i] || []
    const [eTag, eAttrs = {}, eText] = expected[i] || []
    const keys = new Set([...Object.keys(aAttrs), ...Object.keys(eAttrs)])
    const attrsMatch = [...keys].every((k) => sameNumbers(aAttrs[k], eAttrs[k]))
    if (aTag !== eTag || !attrsMatch || (aText ?? null) !== (eText ?? null)) {
      return { index: i, actual: actual[i] ?? null, expected: expected[i] ?? null }
    }
  }
  return null
}
