// @ts-check
const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { createUpDownService } = require('../src/updown/updown-service')

const io = { to: () => ({ emit: () => {} }) }

// Real signal engine (stability/flush state) with a fake file store, so loadState is exercised.
const makeService = (files) => createUpDownService(io, {
  readJSON: (file, fallback) => (file in files ? structuredClone(files[file]) : fallback),
  writeJSON: (file, state) => { files[file] = structuredClone(state) },
  DATA_DIR: '/tmp/updown-load-state-restore',
  candleCache: { getCandles: () => [], isSeeded: () => true },
  createScorecard: () => ({
    start: () => Promise.resolve(),
    stop: () => {},
    getMetrics: () => ({ adaptiveWeights: null, byWindow: {} }),
    recordPrediction: () => {},
    recordPerpFill: () => {},
  }),
})

const seed = (service) => {
  service.setContract({ expiry: Date.now() + 60_000, target: 120, stop: 90, range: 5, direction: 'up' })
  service.setPosition({ entryPrice: 100, contracts: 2, direction: 'up' })
}

describe('UpDown loadState replaces in-memory state (restore reload)', () => {
  for (const [name, restore] of [
    ['restored archive has no state file', (files, key) => { delete files[key] }],
    ['restored file lacks position, book and contract', (files, key) => { files[key] = { signalHistory: [] } }],
  ]) {
    it(`clears pre-restore state when the ${name}`, async () => {
      const files = {}
      const service = makeService(files)
      seed(service)
      assert.ok(service.getStatus().position)

      service.stop() // quiesce persists the live (pre-restore) state
      const [key] = Object.keys(files)
      assert.ok(files[key].position)
      restore(files, key)

      await service.start()
      const status = service.getStatus()
      assert.equal(status.position, null)
      assert.equal(status.contract.target, null)
      assert.equal(status.perp.contracts, 0)

      service.stop() // next persist must not resurrect pre-restore values
      const persisted = files[Object.keys(files)[0]]
      assert.equal(persisted.position, null)
      assert.equal(persisted.contract.target, null)
      assert.equal(persisted.perpBook.lots.length, 0)
      assert.equal(persisted.perpBook.open, false)
    })
  }

  it('applies a restored position over a different in-memory one', async () => {
    const files = {}
    const service = makeService(files)
    seed(service)
    service.stop()
    const [key] = Object.keys(files)
    files[key] = { ...files[key], position: { entryPrice: 50, contracts: 1, direction: 'up', entryTime: 1 } }

    await service.start()
    assert.equal(service.getStatus().position.entryPrice, 50)
    service.stop()
  })
})

describe('UpDown state format version (#1397)', () => {
  it('stamps the persisted state and reloads it', () => {
    const files = {}
    const service = makeService(files)
    seed(service)
    service.stop()
    const [key] = Object.keys(files)
    assert.equal(files[key].formatVersion, 1)
    assert.doesNotThrow(() => makeService(files))
  })

  it('loads a pre-versioning state file', () => {
    assert.doesNotThrow(() => makeService({ '/tmp/updown-load-state-restore/updown-state.json': { signalHistory: [] } }))
  })

  it('refuses a state file written by a newer build', () => {
    const files = { '/tmp/updown-load-state-restore/updown-state.json': { formatVersion: 99, signalHistory: [] } }
    assert.throws(() => makeService(files), /written by a newer build \(format v99/)
  })
})
