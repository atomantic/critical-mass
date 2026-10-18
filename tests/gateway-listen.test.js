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


describe('bindGatewayListeners', () => {
  const http = require('node:http')
  const { bindGatewayListeners } = require('../src/gateway-listen')
  const closeAll = (servers) => Promise.all(servers.map((s) => new Promise((resolve) => s.close(() => resolve()))))

  it('resolves only once every host is listening and returns the extra servers', async () => {
    const primary = http.createServer()
    const extras = []
    const logs = []
    const result = await bindGatewayListeners({
      hosts: ['127.0.0.1'], port: 0, server: primary,
      createServer: () => assert.fail('single host needs no extra server'),
      onExtra: (s) => extras.push(s),
      log: (level, message) => logs.push(`${level} ${message}`),
    })
    assert.deepEqual(result, [])
    assert.deepEqual(extras, [])
    assert.equal(primary.listening, true)
    assert.ok(primary.address().port > 0)
    assert.deepEqual(logs, ['INFO Critical Mass listening on http://127.0.0.1:0'])
    await closeAll([primary])
  })

  it('rejects with the occupied host and port and leaves nothing bound', async () => {
    const owner = http.createServer()
    await new Promise((resolve) => owner.listen(0, '127.0.0.1', resolve))
    const port = owner.address().port
    const primary = http.createServer()
    let extra
    await assert.rejects(
      bindGatewayListeners({
        hosts: ['127.0.0.1', '127.0.0.1'], port, server: primary,
        createServer: () => { extra = http.createServer(); return extra },
        onExtra: (s) => assert.equal(s, extra),
      }),
      (err) => err.code === 'EADDRINUSE' && err.host === '127.0.0.1' && err.port === port,
    )
    assert.equal(primary.listening, false)
    assert.equal(extra.listening, false)
    assert.equal(owner.listening, true, 'the existing owner keeps the port')
    await closeAll([owner])
  })

  it('closes a host that did bind when a later host fails', async () => {
    const primary = http.createServer()
    await new Promise((resolve) => primary.listen(0, '127.0.0.1', resolve))
    const port = primary.address().port
    await closeAll([primary])
    // Same loopback address twice: the first bind succeeds, the second collides with it.
    const first = http.createServer()
    const second = http.createServer()
    await assert.rejects(
      bindGatewayListeners({ hosts: ['127.0.0.1', '127.0.0.1'], port, server: first, createServer: () => second }),
      (err) => err.code === 'EADDRINUSE',
    )
    assert.equal(first.listening, false, 'the successful bind is released on failure')
    assert.equal(second.listening, false)
  })
})

describe('watchTailscaleListeners', () => {
  const { EventEmitter } = require('node:events')
  const { watchTailscaleListeners } = require('../src/gateway-listen')
  const { closeGatewayListeners } = require('../src/gateway-shutdown')

  // No real sockets or interfaces: a fake server that "listens" on the next tick.
  const fakeServer = (failWith) => Object.assign(new EventEmitter(), {
    listening: false,
    host: null,
    listen(_port, host) {
      this.host = host
      process.nextTick(() => {
        if (failWith) return this.emit('error', Object.assign(new Error('bind failed'), { code: failWith }))
        this.listening = true
        this.emit('listening')
      })
    },
    close(cb) { this.listening = false; cb() },
    closeIdleConnections() {},
  })
  const netsWith = (...addresses) => ({
    lo0: [{ family: 'IPv4', internal: true, address: '127.0.0.1' }],
    utun4: addresses.map((address) => ({ family: 'IPv4', internal: false, address })),
  })

  it('binds an address that appears after the first scan once, and shutdown closes it', async () => {
    let nets = netsWith()
    const extras = []
    const servers = []
    const logs = []
    const watcher = watchTailscaleListeners({
      bound: ['127.0.0.1'], port: 5570,
      createServer: () => { const s = fakeServer(); servers.push(s); return s },
      onExtra: (s) => extras.push(s),
      scan: () => tailscaleIpv4s(nets),
      log: (level, message) => logs.push(`${level} ${message}`),
    })
    try {
      assert.deepEqual(await watcher.scan(), [])
      assert.equal(servers.length, 0)

      nets = netsWith('100.83.147.46')
      assert.deepEqual(await watcher.scan(), ['100.83.147.46'])
      assert.deepEqual(await watcher.scan(), [], 'a bound address is not bound twice')
      assert.equal(servers.length, 1)
      assert.deepEqual(extras, servers)
      assert.equal(servers[0].listening, true)
      assert.equal(servers[0].host, '100.83.147.46')
      assert.deepEqual(logs, ['INFO Critical Mass listening on http://100.83.147.46:5570'])

      const io = { close: (cb) => cb() }
      await closeGatewayListeners(io, extras, [])
      assert.equal(servers[0].listening, false)
    } finally {
      watcher.stop()
    }
  })

  it('does not rebind an address from the initial bind', async () => {
    const watcher = watchTailscaleListeners({
      bound: ['127.0.0.1', '100.83.147.46'], port: 5570,
      createServer: () => assert.fail('nothing new to bind'),
      scan: () => ['100.83.147.46'],
    })
    try {
      assert.deepEqual(await watcher.scan(), [])
    } finally {
      watcher.stop()
    }
  })

  it('binds nothing once shutdown has begun', async () => {
    const watcher = watchTailscaleListeners({
      bound: [], port: 5570,
      createServer: () => assert.fail('stopping'),
      isStopping: () => true,
      scan: () => ['100.83.147.46'],
    })
    try {
      assert.deepEqual(await watcher.scan(), [])
    } finally {
      watcher.stop()
    }
  })

  it('retries a failed bind on the next scan and warns only once', async () => {
    let failWith = 'EADDRNOTAVAIL'
    const logs = []
    const watcher = watchTailscaleListeners({
      bound: [], port: 5570,
      createServer: () => fakeServer(failWith),
      scan: () => ['100.83.147.46'],
      log: (level, message) => logs.push(`${level} ${message}`),
    })
    try {
      assert.deepEqual(await watcher.scan(), [])
      assert.deepEqual(await watcher.scan(), [])
      assert.equal(logs.filter((l) => l.startsWith('WARN')).length, 1)
      failWith = undefined
      assert.deepEqual(await watcher.scan(), ['100.83.147.46'])
    } finally {
      watcher.stop()
    }
  })
})
