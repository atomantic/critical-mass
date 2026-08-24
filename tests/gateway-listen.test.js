// @ts-check
const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const {
  isTailscaleIpv4,
  tailscaleIpv4s,
  resolveListenHosts,
  isGatewayOrigin,
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
})

describe('isGatewayOrigin', () => {
  const listed = ['http://localhost:5563', 'http://localhost:5564']

  it('allows missing origin, the allowlist, MagicDNS, and 100.x', () => {
    assert.equal(isGatewayOrigin(undefined, listed), true)
    assert.equal(isGatewayOrigin('http://localhost:5564', listed), true)
    assert.equal(isGatewayOrigin('http://void.taile8179.ts.net:5564', listed), true)
    assert.equal(isGatewayOrigin('https://void.taile8179.ts.net', listed), true)
    assert.equal(isGatewayOrigin('http://100.83.147.46:5563', listed), true)
  })

  it('rejects unrelated origins', () => {
    assert.equal(isGatewayOrigin('http://evil.example', listed), false)
    assert.equal(isGatewayOrigin('http://192.168.1.14:5563', listed), false)
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
