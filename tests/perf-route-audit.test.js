const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { redactEndpoint, createCollector, maxOverlap, aggregate, verdict } = require('../scripts/lib/perf-metrics')
const { startFixture } = require('../scripts/lib/perf-fixture')
const { runAudit, main, PAGE_CAP } = require('../scripts/perf-route-audit')

describe('perf metrics', () => {
  it('redacts ids, exchange and query values', () => {
    assert.equal(
      redactEndpoint('get', '/api/coinbase/regime/fills?pair=BTC-USD&page=3&paged=true'),
      'GET /api/:exchange/regime/fills?page&paged&pair',
    )
    assert.equal(redactEndpoint('GET', '/api/x/orders/0123456789abcdef'), 'GET /api/:exchange/orders/:id')
  })

  it('computes overlap, bytes per minute and verdicts', () => {
    assert.equal(maxOverlap([{ start: 0, end: 10 }, { start: 5, end: 12 }, { start: 12, end: 14 }]), 2)
    const c = createCollector(() => 0)
    c.recordHttp({ method: 'GET', url: '/api/a/config?x=1', start: 0, end: 1, status: 200, decodedBytes: 100, wireBytes: 40, phase: 'p' })
    c.recordWs({ event: 'regime:status', at: 0, bytes: 50, phase: 'p' })
    const s = aggregate(c, 'p', 30000)
    assert.equal(s.http['GET /api/:exchange/config?x'].wireBytes, 40)
    assert.equal(s.ws['in regime:status'].bytesPerMinute, 100)
    assert.equal(s.totalBytesPerMinute, 300)
    assert.equal(verdict([{ ok: true }], ['no session']), 'UNVERIFIED')
    assert.equal(verdict([{ ok: false }], ['no session']), 'FAIL')
    assert.equal(verdict([{ ok: true }]), 'PASS')
  })
})

describe('route audit against the synthetic fixture', () => {
  it('serves a 30,000-fill ledger as a bounded page and passes all checks', async () => {
    const fixture = await startFixture()
    try {
      assert.equal(fixture.ledgerSize, 30000)
      const huge = await (await fetch(`${fixture.baseUrl}/api/coinbase/regime/fills?paged=true&pageSize=100000`)).json()
      assert.ok(huge.fills.length <= PAGE_CAP)
      const result = await runAudit({ baseUrl: fixture.baseUrl, pollMs: 200, idleMs: 1500, roomsOf: fixture.roomsOf })
      for (const c of result.checks) assert.ok(c.ok, c.name)
      assert.equal(Object.keys(result.config.http).length, 1)
      assert.ok(result.transactions.http['GET /api/:exchange/config'].count === 1)
    } finally {
      await fixture.stop()
    }
  })

  it('removes its temporary storage', async () => {
    const fixture = await startFixture({ fills: 10 })
    assert.ok(fs.existsSync(fixture.dir))
    await fixture.stop()
    assert.equal(fs.existsSync(fixture.dir), false)
  })

  it('reports UNVERIFIED (exit 2) for an external gateway without a session', async () => {
    const saved = process.env.CM_PERF_TOKEN
    delete process.env.CM_PERF_TOKEN
    const log = console.log
    console.log = () => {}
    try {
      assert.equal(await main(['--base-url', 'http://127.0.0.1:1']), 2)
    } finally {
      console.log = log
      if (saved !== undefined) process.env.CM_PERF_TOKEN = saved
    }
  })
})

describe('audit model stays aligned with the UI', () => {
  it('polls Transactions every 10s with a 100-row page', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'admin', 'src', 'components', 'TransactionsRegime.jsx'), 'utf8')
    assert.match(src, /setInterval\(refresh, 10000\)/)
    assert.match(src, /pageSize: '100'/)
    assert.match(src, /\/api\/\$\{exchange\}\/config/)
  })
})

describe('route audit failure handling', () => {
  it('reports UNVERIFIED instead of hanging when the gateway is unreachable', async () => {
    const log = console.log
    console.log = () => {}
    const saved = process.env.CM_PERF_TOKEN
    process.env.CM_PERF_TOKEN = 'synthetic-token'
    try {
      const code = await Promise.race([
        main(['--base-url', 'http://127.0.0.1:1', '--idle-seconds', '0.1', '--poll-seconds', '0.1']),
        new Promise(resolve => setTimeout(() => resolve('hung'), 20000)),
      ])
      assert.equal(code, 2)
    } finally {
      console.log = log
      if (saved === undefined) delete process.env.CM_PERF_TOKEN
      else process.env.CM_PERF_TOKEN = saved
    }
  })
})
