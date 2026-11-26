// @vitest-environment node
import { describe, it } from 'vitest'
import assert from 'node:assert/strict'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import InfoTooltip from '../src/components/InfoTooltip.jsx'
import { computeTooltipPosition } from '../src/components/tooltipPosition.mjs'

const rect = (left, top, w = 12, h = 12) => ({ left, top, right: left + w, bottom: top + h, width: w, height: h })

describe('InfoTooltip', () => {
  it('exposes the help as a stable accessible description while closed without mounting the visual popup', () => {
    const html = renderToStaticMarkup(React.createElement(InfoTooltip, { tip: React.createElement('div', null, 'ATR help text'), label: 'About ATR' }))
    const button = html.match(/<button[^>]*>/)?.[0]
    const description = html.match(/<span id="([^"]+-description)" class="sr-only" hidden="">([\s\S]*?)<\/span>/)
    assert.match(button, /aria-label="About ATR"/)
    assert.match(button, /aria-expanded="false"/)
    assert.match(button, /type="button"/)
    assert.ok(description, 'screen-reader description is present before activation')
    assert.match(button, new RegExp(`aria-describedby="${description[1]}"`))
    assert.match(description[2], /ATR help text/)
    assert.match(description[0], /hidden=""/)
    assert.doesNotMatch(html, /role="tooltip"/)
  })

  it('uses unique description IDs for repeated tooltips', () => {
    const html = renderToStaticMarkup(React.createElement(React.Fragment, null,
      React.createElement(InfoTooltip, { tip: 'Configuration help', label: 'Configuration' }),
      React.createElement(InfoTooltip, { tip: 'ATR help', label: 'About ATR' }),
    ))
    const descriptionIds = [...html.matchAll(/id="([^"]+-description)"/g)].map(match => match[1])
    const buttons = [...html.matchAll(/<button[^>]*>/g)].map(match => match[0])
    assert.equal(descriptionIds.length, 2)
    assert.equal(new Set(descriptionIds).size, 2)
    for (const button of buttons) assert.match(button, /aria-describedby="[^"]+-description"/)
    assert.match(html, /Configuration help/)
    assert.match(html, /ATR help/)
  })

  for (const vw of [360, 768, 1280]) {
    for (const align of ['left', 'center', 'right']) {
      for (const triggerLeft of [0, vw / 2, vw - 12]) {
        it(`keeps popup inside ${vw}px viewport (${align}, trigger x=${triggerLeft})`, () => {
          const vp = { width: vw, height: 640 }
          const p = computeTooltipPosition({ trigger: rect(triggerLeft, 300), popup: { height: 120 }, viewport: vp, align, maxWidth: 320 })
          assert.ok(p.left >= 0 && p.left + p.width <= vw)
          assert.ok(p.top >= 0 && p.top + Math.min(120, p.maxHeight) <= vp.height)
        })
      }
    }
  }

  it('flips below near the top and scrolls when taller than the viewport', () => {
    const vp = { width: 360, height: 400 }
    const below = computeTooltipPosition({ trigger: rect(10, 4), popup: { height: 100 }, viewport: vp })
    assert.ok(below.top >= 16)
    const tall = computeTooltipPosition({ trigger: rect(10, 200), popup: { height: 900 }, viewport: vp })
    assert.equal(tall.maxHeight, 384)
    assert.equal(tall.top, 8)
  })
})
