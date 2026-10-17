// @ts-check
const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const {
  isTailscaleIpv4,
  tailscaleIpv4s,
  resolveListenHosts,
  isGatewayOrigin,
  createCorsMiddleware,
} = require('../src/gateway-listen')

describe('isTailscaleIpv4', () => {
  it('accepts CGNAT 100.64/10', () => {
    assert.equal(isTailscaleIpv4('100.64.0.1'), true)
    assert.equal(isTailscaleIpv4('100.83.147.46'), true)
    assert.equal(isTailscaleIpv4('100.127.255.255'), true)
  })

  it('rejects loopback, LAN, and 100.x outside 64–127', () => {
    assert.equal(isTailscaleIpv4('127.0.0.1'), false)
    assert.equal(isTailscaleIpv4('192.168.1.14'), false)
    assert.equal(isTailscaleIpv4('100.63.255.255'), false)
    assert.equal(isTailscaleIpv4('100.128.0.1'), false)
    assert.equal(isTailscaleIpv4('8.8.8.8'), false)
  })
})

describe('resolveListenHosts', () => {
  it('defaults to loopback plus Tailscale IPs, not LAN', () => {
    assert.deepEqual(
      resolveListenHosts(undefined, ['100.83.147.46']),
      ['127.0.0.1', '100.83.147.46'],
    )
    assert.deepEqual(resolveListenHosts('', []), ['127.0.0.1'])
  })

  it('HOST=0.0.0.0 is all-interfaces and skips the Tailscale extra', () => {
    assert.deepEqual(resolveListenHosts('0.0.0.0', ['100.83.147.46']), ['0.0.0.0'])
  })

  it('binds only loopback while operator bootstrap has no remote credential', () => {
    assert.deepEqual(
      resolveListenHosts(undefined, ['100.83.147.46'], { allowRemote: false }),
      ['127.0.0.1'],
    )
    assert.deepEqual(
      resolveListenHosts('127.0.0.1,100.83.147.46', [], { allowRemote: false }),
      ['127.0.0.1'],
    )
    assert.throws(
      () => resolveListenHosts('0.0.0.0', [], { allowRemote: false }),
      /Refusing non-loopback HOST/,
    )
  })
})

describe('isGatewayOrigin', () => {
  const listed = ['http://localhost:5570', 'http://localhost:5571']

  it('allows missing origin, the allowlist, MagicDNS, and 100.x', () => {
    assert.equal(isGatewayOrigin(undefined, listed), true)
    assert.equal(isGatewayOrigin('http://localhost:5571', listed), true)
    assert.equal(isGatewayOrigin('http://void.taile8179.ts.net:5571', listed), true)
    assert.equal(isGatewayOrigin('https://void.taile8179.ts.net', listed), true)
    assert.equal(isGatewayOrigin('http://100.83.147.46:5570', listed), true)
  })

  it('rejects unrelated origins', () => {
    assert.equal(isGatewayOrigin('http://evil.example', listed), false)
    assert.equal(isGatewayOrigin('http://192.168.1.14:5570', listed), false)
  })
})

describe('tailscaleIpv4s', () => {
  it('reads IPv4 Tailscale addresses off a net interface map', () => {
    assert.deepEqual(tailscaleIpv4s({
      lo0: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
      en0: [{ address: '192.168.1.14', family: 'IPv4', internal: false }],
      utun4: [{ address: '100.83.147.46', family: 'IPv4', internal: false }],
    }), ['100.83.147.46'])
  })
})

describe('createCorsMiddleware', () => {
  const listed = ['http://localhost:5570', 'http://localhost:5571']
  const middleware = createCorsMiddleware(listed)

  it('answers OPTIONS preflight for allowed origin', () => {
    const headers = {}
    let status = null
    let nextCalled = false
    const req = { method: 'OPTIONS', headers: { origin: 'https://void.taile8179.ts.net' } }
    const res = {
      header: (k, v) => { headers[k] = v },
      sendStatus: (s) => { status = s },
    }
    middleware(req, res, () => { nextCalled = true })
    assert.equal(status, 204)
    assert.equal(headers['Access-Control-Allow-Origin'], 'https://void.taile8179.ts.net')
    assert.equal(nextCalled, false)
  })

  it('passes through OPTIONS for disallowed origin without CORS headers', () => {
    const headers = {}
    let status = null
    let nextCalled = false
    const req = { method: 'OPTIONS', headers: { origin: 'http://evil.example' } }
    const res = {
      header: (k, v) => { headers[k] = v },
      sendStatus: (s) => { status = s },
    }
    middleware(req, res, () => { nextCalled = true })
    assert.equal(status, null)
    assert.equal(headers['Access-Control-Allow-Origin'], undefined)
    assert.equal(nextCalled, true)
  })
})

