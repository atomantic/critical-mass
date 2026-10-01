const { before, describe, it } = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const vm = require('node:vm')
const { createRequire } = require('node:module')
const { pathToFileURL } = require('node:url')

const adminRequire = createRequire(path.join(__dirname, '..', 'admin', 'package.json'))
const React = adminRequire('react')
const { renderToStaticMarkup } = adminRequire('react-dom/server')
let mod

before(async () => {
  const { rolldown } = await import(pathToFileURL(adminRequire.resolve('rolldown')).href)
  const bundle = await rolldown({
    input: path.join(__dirname, '..', 'admin', 'src', 'components', 'InfoTooltip.jsx'),
    external: () => true,
    transform: { jsx: 'react' },
  })
  let code
  try { code = (await bundle.generate({ format: 'cjs' })).output[0].code } finally { await bundle.close() }
  const m = { exports: {} }
  vm.runInNewContext(code, { module: m, exports: m.exports, require: adminRequire, console, React })
  mod = m.exports
})

const rect = (left, top, w = 12, h = 12) => ({ left, top, right: left + w, bottom: top + h, width: w, height: h })

describe('InfoTooltip', () => {
  it('does not mount help content while closed', () => {
    const html = renderToStaticMarkup(React.createElement(mod.default, { tip: React.createElement('div', null, 'SECRET HELP'), label: 'About ATR' }))
    assert.match(html, /aria-label="About ATR"/)
    assert.match(html, /aria-expanded="false"/)
    assert.match(html, /<button[^>]*type="button"/)
    assert.doesNotMatch(html, /SECRET HELP/)
  })

  for (const vw of [360, 768, 1280]) {
    for (const align of ['left', 'center', 'right']) {
      for (const triggerLeft of [0, vw / 2, vw - 12]) {
        it(`keeps popup inside ${vw}px viewport (${align}, trigger x=${triggerLeft})`, () => {
          const vp = { width: vw, height: 640 }
          const p = mod.computeTooltipPosition({ trigger: rect(triggerLeft, 300), popup: { height: 120 }, viewport: vp, align, maxWidth: 320 })
          assert.ok(p.left >= 0 && p.left + p.width <= vw)
          assert.ok(p.top >= 0 && p.top + Math.min(120, p.maxHeight) <= vp.height)
        })
      }
    }
  }

  it('flips below near the top and scrolls when taller than the viewport', () => {
    const vp = { width: 360, height: 400 }
    const below = mod.computeTooltipPosition({ trigger: rect(10, 4), popup: { height: 100 }, viewport: vp })
    assert.ok(below.top >= 16)
    const tall = mod.computeTooltipPosition({ trigger: rect(10, 200), popup: { height: 900 }, viewport: vp })
    assert.equal(tall.maxHeight, 384)
    assert.equal(tall.top, 8)
  })
})
