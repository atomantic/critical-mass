// @ts-check
const { describe, it, before, after } = require('node:test')
const assert = require('node:assert/strict')
const express = require('express')
const { createSecurityHeadersMiddleware } = require('../src/gateway-listen')

describe('gateway security headers', () => {
  /** @type {import('http').Server} */
  let server
  let base = ''

  before(async () => {
    const app = express()
    app.disable('x-powered-by')
    app.use(createSecurityHeadersMiddleware())
    app.use('/drain', (req, res) => res.status(503).json({ success: false }))
    app.get('/', (req, res) => res.send('<html></html>'))
    app.use((req, res) => res.status(404).json({ success: false, error: 'Not found' }))
    await new Promise((resolve) => {
      server = app.listen(0, '127.0.0.1', resolve)
    })
    const { port } = /** @type {import('net').AddressInfo} */ (server.address())
    base = `http://127.0.0.1:${port}`
  })

  after(async () => {
    await new Promise((resolve) => server.close(resolve))
  })

  const expectHeaders = (res) => {
    assert.equal(res.headers.get('x-frame-options'), 'DENY')
    assert.equal(res.headers.get('content-security-policy'), "frame-ancestors 'none'")
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff')
    assert.equal(res.headers.get('referrer-policy'), 'no-referrer')
    assert.equal(res.headers.get('x-powered-by'), null)
  }

  it('sets anti-framing and hardening headers on a page response', async () => {
    expectHeaders(await fetch(`${base}/`))
  })

  it('sets the same headers on a JSON 404 and drops x-powered-by', async () => {
    const res = await fetch(`${base}/api/missing`)
    assert.equal(res.status, 404)
    expectHeaders(res)
  })

  it('sets the headers on responses short-circuited by later middleware', async () => {
    const res = await fetch(`${base}/drain`)
    assert.equal(res.status, 503)
    expectHeaders(res)
  })
})
