const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const src = fs.readFileSync(path.join(__dirname, '..', 'admin', 'src', 'components', 'sentinel', 'Dashboard.jsx'), 'utf8')

describe('Sentinel dashboard touch targets', () => {
  it('defines a 44px shared target class', () => {
    assert.match(src, /TOUCH_BTN = '[^']*min-h-11 min-w-11[^']*shrink-0[^']*inline-flex/)
  })

  it('applies it to every operational control', () => {
    const uses = src.match(/\$\{TOUCH_BTN\}/g) || []
    // Stop, Start, Force Poll, Enable/Disable, feed switch, Remove, Clear All, Dismiss
    assert.ok(uses.length >= 8, `expected >=8 uses, got ${uses.length}`)
  })

  it('keeps the compact visual switch track inside the 44px button', () => {
    assert.match(src, /role="switch"[\s\S]*?\$\{TOUCH_BTN\}[\s\S]*?block w-8 h-5 rounded-full/)
  })

  it('lets long feed content reflow without hiding controls', () => {
    assert.match(src, /flex flex-wrap items-center/)
    assert.match(src, /basis-full sm:order-none/)
    assert.match(src, /min-w-0/)
  })
})
