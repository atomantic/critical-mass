const { before, describe, it } = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const vm = require('node:vm')
const { createRequire } = require('node:module')
const { pathToFileURL } = require('node:url')

const adminRequire = createRequire(path.join(__dirname, '..', 'admin', 'package.json'))
const React = adminRequire('react')
const { renderToStaticMarkup } = adminRequire('react-dom/server')
const { MemoryRouter } = adminRequire('react-router-dom')
let Card

before(async () => {
  const { rolldown } = await import(pathToFileURL(adminRequire.resolve('rolldown')).href)
  const bundle = await rolldown({
    input: path.join(__dirname, '..', 'admin', 'src', 'components', 'ClosedFundCard.jsx'),
    external: (id) => !id.startsWith('.') && !path.isAbsolute(id),
    transform: { jsx: 'react' },
  })
  let code
  try { code = (await bundle.generate({ format: 'cjs' })).output[0].code } finally { await bundle.close() }
  const m = { exports: {} }
  vm.runInNewContext(code, { module: m, exports: m.exports, require: adminRequire, console, React })
  Card = m.exports.default || m.exports
})

describe('ClosedFundCard layout', () => {
  const longPair = 'VERYLONGSYNTHETICBASEASSET-VERYLONGSYNTHETICQUOTEASSET'
  const render = (card) => renderToStaticMarkup(
    React.createElement(MemoryRouter, null, React.createElement(Card, { card, icon: 'G', iconClass: 'bg-blue-600' })))

  it('wraps and shrinks identity and summary instead of overflowing', () => {
    const html = render({ exchange: 'gemini', pair: longPair, cyclesCompleted: 12, realizedPnL: 123.45 })
    const link = html.match(/<a[^>]*>/)[0]
    assert.match(link, /flex-wrap/)
    assert.match(link, /min-w-0/)
    assert.doesNotMatch(link, /whitespace-nowrap/)
    assert.match(html, /min-w-0[^"]*break-words/)
    assert.match(html, /\[overflow-wrap:anywhere\]/)
    assert.match(html, new RegExp(`href="/gemini/${longPair}"`))
  })

  it('keeps cycles, P&L and Closed text visible', () => {
    const html = render({ exchange: 'gemini', pair: 'BTCUSD', cyclesCompleted: 3, realizedPnL: -5 })
    assert.match(html, /3 cycles/)
    assert.match(html, /text-red-500/)
    assert.match(html, />Closed</)
  })
})
