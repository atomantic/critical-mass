const { before, describe, it } = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const vm = require('node:vm')
const { createRequire } = require('node:module')
const { pathToFileURL } = require('node:url')

const adminRequire = createRequire(path.join(__dirname, '..', 'admin', 'package.json'))
const React = adminRequire('react')
const { renderToStaticMarkup } = adminRequire('react-dom/server')
const adminSrc = path.join(__dirname, '..', 'admin', 'src')
const ENTRY = '\0closed-fund-card-entry'
let Card
let BrowserRouter

before(async () => {
  const { rolldown } = await import(pathToFileURL(adminRequire.resolve('rolldown')).href)
  // One bundle for the card and the owned router so the card's <Link> sees the
  // same RouterContext the test provides.
  const bundle = await rolldown({
    input: ENTRY,
    external: (id) => id !== ENTRY && !id.startsWith('.') && !path.isAbsolute(id),
    transform: { jsx: 'react' },
    plugins: [{
      name: 'closed-fund-card-entry',
      resolveId: (id) => (id === ENTRY ? id : null),
      load: (id) => (id === ENTRY ? [
        `export { default as Card } from ${JSON.stringify(path.join(adminSrc, 'components', 'ClosedFundCard.jsx'))}`,
        `export { BrowserRouter } from ${JSON.stringify(path.join(adminSrc, 'lib', 'router.jsx'))}`,
      ].join('\n') : null),
    }],
  })
  let code
  try { code = (await bundle.generate({ format: 'cjs' })).output[0].code } finally { await bundle.close() }
  const m = { exports: {} }
  // BrowserRouter seeds its location from window.location; effects never run
  // under renderToStaticMarkup, so this is the only browser surface it touches.
  const window = { location: { pathname: '/', search: '', hash: '' } }
  vm.runInNewContext(code, { module: m, exports: m.exports, require: adminRequire, console, React, window })
  ;({ Card, BrowserRouter } = m.exports)
})

describe('ClosedFundCard layout', () => {
  const longPair = 'VERYLONGSYNTHETICBASEASSET-VERYLONGSYNTHETICQUOTEASSET'
  const render = (card) => renderToStaticMarkup(
    React.createElement(BrowserRouter, null, React.createElement(Card, { card, icon: 'G', iconClass: 'bg-blue-600' })))

  it('wraps and shrinks identity and summary instead of overflowing', () => {
    const html = render({ exchange: 'gemini', pair: longPair, cyclesCompleted: 12, realizedPnL: 123.45 })
    const link = html.match(/<a[^>]*>/)[0]
    assert.match(link, /flex-wrap/)
    assert.match(link, /min-w-0/)
    assert.doesNotMatch(link, /whitespace-nowrap/)
    assert.match(html, /min-w-0[^"]*wrap-break-word/)
    assert.match(html, /wrap-anywhere/)
    assert.match(html, new RegExp(`href="/gemini/${longPair}"`))
  })

  it('keeps cycles, P&L and Closed text visible', () => {
    const html = render({ exchange: 'gemini', pair: 'BTCUSD', cyclesCompleted: 3, realizedPnL: -5 })
    assert.match(html, /3 cycles/)
    assert.match(html, /text-red-500/)
    assert.match(html, />Closed</)
  })
})
