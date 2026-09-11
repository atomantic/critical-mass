const assert = require('node:assert/strict')
const { describe, it } = require('node:test')

// Exercises the real runner lifecycle owner used by admin/src/components/ai/Providers.jsx
// with deferred fetch promises and injected fake timers, so every await boundary
// can be interleaved with unmount, stop, and replacement deterministically.

const deferred = () => {
  let settle
  const promise = new Promise(resolve => { settle = resolve })
  return { promise, resolve: settle }
}

const jsonResponse = (payload) => ({ json: async () => payload })
const textResponse = (body) => ({ text: async () => body })

const flush = async () => {
  for (let i = 0; i < 6; i += 1) await new Promise(resolve => setImmediate(resolve))
}

const createHarness = async () => {
  const { createRunLifecycle } = await import('../admin/src/utils/runLifecycle.mjs')
  const calls = []
  const timers = new Map()
  const view = { runningId: null, output: null, pending: false, refreshes: 0 }
  let nextTimerId = 1

  const fetchImpl = (url, options = {}) => {
    const call = { url, method: options.method || 'GET', signal: options.signal, ...deferred() }
    calls.push(call)
    return call.promise
  }

  const lifecycle = createRunLifecycle({
    fetchImpl,
    setTimer: (fn) => {
      const id = nextTimerId
      nextTimerId += 1
      timers.set(id, fn)
      return id
    },
    clearTimer: (id) => { timers.delete(id) },
    pollIntervalMs: 2000,
    setRunningId: (id) => { view.runningId = id },
    setRunOutput: (output) => { view.output = output },
    setPending: (pending) => { view.pending = pending },
    refreshRuns: () => { view.refreshes += 1 },
  })

  const lastCall = (fragment) => [...calls].reverse().find(c => c.url.includes(fragment))
  const callsTo = (fragment) => calls.filter(c => c.url.includes(fragment))
  const fireTimers = async () => {
    const pending = [...timers.values()]
    timers.clear()
    pending.forEach(fn => fn())
    await flush()
  }

  return { lifecycle, calls, callsTo, lastCall, timers, view, fireTimers }
}

// Drive a run up to the point where the first metadata poll is in flight.
const startPolling = async (harness, runId) => {
  harness.lifecycle.execute({ providerId: 'p1', prompt: 'hello' })
  await flush()
  harness.lastCall('/api/runs').resolve(jsonResponse({ runId }))
  await flush()
  await harness.fireTimers()
}

describe('AI runner lifecycle ownership', () => {
  it('installs no timer and issues no metadata request when creation resolves after unmount', async () => {
    const h = await createHarness()
    h.lifecycle.execute({ providerId: 'p1', prompt: 'hello' })
    await flush()
    assert.equal(h.calls.length, 1, 'only the creation POST is in flight')

    h.lifecycle.dispose()
    h.lastCall('/api/runs').resolve(jsonResponse({ runId: 'run-a' }))
    await flush()

    assert.equal(h.timers.size, 0, 'no poll timer survives unmount')
    assert.equal(h.calls.length, 1, 'no follow-up metadata request is issued')
    assert.equal(h.view.runningId, null)
    assert.equal(h.view.pending, false)
  })

  it('schedules no poll, output read, or run refresh when unmount lands mid-poll', async () => {
    const h = await createHarness()
    await startPolling(h, 'run-a')
    const meta = h.lastCall('/api/runs/run-a')
    assert.ok(meta, 'metadata poll is in flight')

    h.lifecycle.dispose()
    meta.resolve(jsonResponse({ endTime: 2 }))
    await flush()

    assert.equal(h.callsTo('/output').length, 0, 'no output read after unmount')
    assert.equal(h.view.refreshes, 0, 'no run-list refresh after unmount')
    assert.equal(h.timers.size, 0, 'no next poll scheduled after unmount')
  })

  it('aborts in-flight client reads on unmount', async () => {
    const h = await createHarness()
    await startPolling(h, 'run-a')
    const meta = h.lastCall('/api/runs/run-a')
    assert.equal(meta.signal.aborted, false)

    h.lifecycle.dispose()
    assert.equal(meta.signal.aborted, true, 'pending reads are aborted')
  })

  it('keeps the replacement run owned when a stopped run resolves late', async () => {
    const h = await createHarness()
    await startPolling(h, 'run-a')
    const staleMeta = h.lastCall('/api/runs/run-a')

    h.lifecycle.stop()
    await flush()
    assert.equal(h.callsTo('/api/runs/run-a/stop').length, 1, 'explicit Stop cancels server-side')

    h.lifecycle.execute({ providerId: 'p1', prompt: 'second' })
    await flush()
    h.lastCall('/api/runs').resolve(jsonResponse({ runId: 'run-b' }))
    await flush()
    assert.equal(h.view.runningId, 'run-b')
    assert.equal(h.timers.size, 1, 'run B owns exactly one timer')
    const timerB = [...h.timers.keys()][0]

    staleMeta.resolve(jsonResponse({ endTime: 5, error: 'stale' }))
    await flush()

    assert.equal(h.view.runningId, 'run-b', 'the stale run does not clear run B')
    assert.equal(h.view.output, '', 'run B output is untouched by the stale run')
    assert.equal(h.callsTo('/api/runs/run-a/output').length, 0, 'no stale output read')
    assert.deepEqual([...h.timers.keys()], [timerB], "run B's timer is never cleared by run A")
  })

  it('submits one run for repeated Execute during a pending creation', async () => {
    const h = await createHarness()
    h.lifecycle.execute({ providerId: 'p1', prompt: 'hello' })
    h.lifecycle.execute({ providerId: 'p1', prompt: 'hello' })
    await flush()
    h.lifecycle.execute({ providerId: 'p1', prompt: 'hello' })
    await flush()

    assert.equal(h.callsTo('/api/runs').length, 1, 'exactly one creation POST')
    assert.equal(h.view.pending, true, 'pending creation is tracked for the Execute button')

    h.lastCall('/api/runs').resolve(jsonResponse({ runId: 'run-a' }))
    await flush()
    assert.equal(h.view.pending, false)
    assert.equal(h.timers.size, 1)

    h.lifecycle.execute({ providerId: 'p1', prompt: 'again' })
    await flush()
    assert.equal(h.callsTo('/api/runs').length, 1, 'a live run blocks a second submission')
  })

  it('never overlaps metadata polls while a request is slow', async () => {
    const h = await createHarness()
    await startPolling(h, 'run-a')
    assert.equal(h.timers.size, 0, 'no follow-up poll is queued while one is in flight')

    await h.fireTimers()
    assert.equal(h.callsTo('/api/runs/run-a').length, 1, 'the slow poll is not duplicated')

    h.lastCall('/api/runs/run-a').resolve(jsonResponse({ endTime: null }))
    await flush()
    assert.equal(h.timers.size, 1, 'the next poll is scheduled on completion')
  })

  it('displays output, releases the timer, and refreshes on normal completion', async () => {
    const h = await createHarness()
    await startPolling(h, 'run-a')
    h.lastCall('/api/runs/run-a').resolve(jsonResponse({ endTime: 9 }))
    await flush()
    h.lastCall('/api/runs/run-a/output').resolve(textResponse('all done'))
    await flush()

    assert.equal(h.view.output, 'all done')
    assert.equal(h.view.runningId, null)
    assert.equal(h.timers.size, 0, 'the owned timer is released on completion')
    assert.equal(h.view.refreshes, 1, 'the run list refreshes once')
  })

  it('does not issue an implicit server stop when the view unmounts', async () => {
    const h = await createHarness()
    await startPolling(h, 'run-a')
    h.lifecycle.dispose()
    await flush()

    assert.equal(h.callsTo('/stop').length, 0, 'navigation leaves server-side work running')
  })

  it('surfaces a creation error without scheduling polling', async () => {
    const h = await createHarness()
    h.lifecycle.execute({ providerId: 'p1', prompt: 'hello' })
    await flush()
    h.lastCall('/api/runs').resolve(jsonResponse({ error: 'no provider' }))
    await flush()

    assert.equal(h.view.output, 'Error: no provider')
    assert.equal(h.timers.size, 0)
    assert.equal(h.view.pending, false)

    h.lifecycle.execute({ providerId: 'p1', prompt: 'retry' })
    await flush()
    assert.equal(h.callsTo('/api/runs').length, 2, 'a failed creation releases the lifecycle')
  })
  it('treats a creation response without a run id as a failure', async () => {
    const h = await createHarness()
    h.lifecycle.execute({ providerId: 'p1', prompt: 'hello' })
    await flush()
    h.lastCall('/api/runs').resolve(jsonResponse({}))
    await flush()

    assert.equal(h.view.output, 'Error: Run creation failed')
    assert.equal(h.timers.size, 0, 'nothing is polled without a run id')

    h.lifecycle.execute({ providerId: 'p1', prompt: 'retry' })
    await flush()
    assert.equal(h.callsTo('/api/runs').length, 2, 'the lifecycle is not wedged')
  })
})
