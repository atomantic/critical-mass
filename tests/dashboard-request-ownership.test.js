const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { describe, it } = require('node:test')

// Exercises the real request owner used by RegimeDashboard's fills reads and the
// UpDown dashboard's status reads (#508) with deferred fetch promises, so every
// await boundary can be interleaved deterministically: overlapping polls, action
// boundaries, failures and unmounts.

const deferred = () => {
  let settle
  const promise = new Promise(resolve => { settle = resolve })
  return { promise, resolve: settle }
}

const flush = async () => {
  for (let i = 0; i < 6; i += 1) await new Promise(resolve => setImmediate(resolve))
}

// Response whose json() body is itself deferred, so the parse await boundary can
// be interleaved just like the transport one.
const jsonResponse = (payload) => ({ ok: true, json: async () => payload })
const failedResponse = (status = 500) => ({ ok: false, status, json: async () => ({}) })

const createHarness = async () => {
  const { createRequestOwner } = await import('../admin/src/utils/requestOwner.mjs')
  const calls = []
  const owner = createRequestOwner({
    fetchImpl: (url, options = {}) => {
      const call = { url, signal: options.signal, ...deferred() }
      calls.push(call)
      return call.promise
    },
  })
  return { owner, calls }
}

describe('dashboard request ownership', () => {
  it('drops a delayed initial fills response in favour of the newer live-fill refresh', async () => {
    const { owner, calls } = await createHarness()
    const view = { fills: null }
    // Mirrors RegimeDashboard's fetchFills commit.
    const fetchFills = async () => {
      const { owned, data } = await owner.read('/api/coinbase/regime/fills')
      if (owned && data) view.fills = data.fills || []
    }

    const initial = fetchFills()
    await flush()
    const refresh = fetchFills()
    await flush()

    calls[1].resolve(jsonResponse({ fills: [{ id: 'fill-1' }] }))
    await refresh
    assert.deepEqual(view.fills, [{ id: 'fill-1' }], 'the newer refresh commits')

    calls[0].resolve(jsonResponse({ fills: [] }))
    await initial
    assert.deepEqual(view.fills, [{ id: 'fill-1' }], 'the stale initial response cannot clear the new fill')
  })

  it('aborts a superseded read instead of leaving it in flight', async () => {
    const { owner, calls } = await createHarness()
    owner.read('/api/coinbase/regime/fills')
    await flush()
    assert.equal(calls[0].signal.aborted, false)

    owner.read('/api/coinbase/regime/fills')
    await flush()
    assert.equal(calls[0].signal.aborted, true, 'the older request is aborted')
    assert.equal(calls[1].signal.aborted, false, 'the current request keeps running')
  })

  it('commits nothing after an unmount invalidates the owner', async () => {
    const { owner, calls } = await createHarness()
    const view = { fills: [{ id: 'existing' }] }
    const pending = owner.read('/api/coinbase/regime/fills').then(({ owned, data }) => {
      if (owned && data) view.fills = data.fills || []
    })
    await flush()

    owner.invalidate()
    calls[0].resolve(jsonResponse({ fills: [] }))
    await pending
    assert.deepEqual(view.fills, [{ id: 'existing' }], 'a post-unmount response commits nothing')
    assert.equal(calls[0].signal.aborted, true)
  })

  it('keeps a pre-Stop status poll from restoring Running after the Stop refresh', async () => {
    const { owner, calls } = await createHarness()
    const view = { status: { running: true }, loading: false }
    // Mirrors the UpDown dashboard's fetchStatus commit.
    const fetchStatus = async () => {
      const { owned, data } = await owner.read('/api/updown/status')
      if (!owned) return
      if (data) view.status = data
      view.loading = false
    }

    const poll = fetchStatus()
    await flush()

    // handleStop(): invalidate the pre-action read, POST, then refresh.
    owner.invalidate()
    const refresh = fetchStatus()
    await flush()

    calls[1].resolve(jsonResponse({ running: false }))
    await refresh
    assert.deepEqual(view.status, { running: false }, 'the post-Stop refresh owns the display')

    calls[0].resolve(jsonResponse({ running: true }))
    await poll
    assert.deepEqual(view.status, { running: false }, 'the pre-Stop poll cannot restore Running')
  })

  it('lets an obsolete failure clear neither loading nor the newer snapshot', async () => {
    const { owner, calls } = await createHarness()
    const view = { status: null, loading: true }
    const fetchStatus = async () => {
      const { owned, data } = await owner.read('/api/updown/status')
      if (!owned) return
      if (data) view.status = data
      view.loading = false
    }

    const stale = fetchStatus()
    await flush()
    const current = fetchStatus()
    await flush()

    // The obsolete request fails; it must not touch loading or status.
    calls[0].resolve(failedResponse(503))
    await stale
    assert.equal(view.loading, true, 'an obsolete failure does not clear newer loading state')
    assert.equal(view.status, null)

    calls[1].resolve(jsonResponse({ running: true }))
    await current
    assert.equal(view.loading, false)
    assert.deepEqual(view.status, { running: true }, 'the current response still updates the display')
  })

  it('does not commit when the read is superseded while the body is parsing', async () => {
    const { owner, calls } = await createHarness()
    const view = { status: { running: false } }
    const fetchStatus = async () => {
      const { owned, data } = await owner.read('/api/updown/status')
      if (owned && data) view.status = data
    }

    const stale = fetchStatus()
    await flush()

    const body = deferred()
    calls[0].resolve({ ok: true, json: () => body.promise })
    await flush()

    // A newer read starts while the older body is still being parsed.
    fetchStatus()
    body.resolve({ running: true })
    await stale
    assert.deepEqual(view.status, { running: false }, 'ownership is re-checked after the parse boundary')
  })

  it('reports a current failure as owned but without data', async () => {
    const { owner, calls } = await createHarness()
    const pending = owner.read('/api/updown/status')
    await flush()
    calls[0].resolve(failedResponse(500))
    assert.deepEqual(await pending, { owned: true, ok: false, data: null })
  })

  it('treats a network rejection as a completed, data-less read', async () => {
    const { createRequestOwner } = await import('../admin/src/utils/requestOwner.mjs')
    const owner = createRequestOwner({ fetchImpl: async () => { throw new Error('offline') } })
    assert.deepEqual(await owner.read('/api/updown/status'), { owned: true, ok: false, data: null })
  })
})

describe('dashboard request ownership wiring', () => {
  const readSource = (relative) => fs.readFileSync(path.join(__dirname, '..', relative), 'utf8')

  it('routes RegimeDashboard fills reads through a per-mount owner', () => {
    const source = readSource('admin/src/components/RegimeDashboard.jsx')
    assert.match(source, /createRequestOwner/, 'RegimeDashboard imports the request owner')
    assert.match(source, /fillsOwner\.read\(`\/api\/\$\{exchange\}\/regime\/fills\$\{pairQuery\}`\)/)
    assert.doesNotMatch(source, /await fetch\(`\/api\/\$\{exchange\}\/regime\/fills/, 'fills are no longer fetched unfenced')
  })

  it('routes UpDown status reads through a per-mount owner and fences Start/Stop', () => {
    const source = readSource('admin/src/components/updown/Dashboard.jsx')
    assert.match(source, /statusOwner\.read\('\/api\/updown\/status'\)/)
    assert.doesNotMatch(source, /await fetch\('\/api\/updown\/status'\)/, 'status is no longer fetched unfenced')
    const invalidations = source.match(/statusOwner\.invalidate\(\)/g) || []
    assert.equal(invalidations.length, 3, 'Start, Stop and unmount each invalidate in-flight status reads')
  })
})
