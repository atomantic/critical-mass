// Ownership fence for the AI Providers prompt runner.
//
// Every asynchronous step of a run (creation POST, metadata poll, output read,
// run-list refresh) is authorised by a generation token that is acquired
// synchronously *before* the first await. Unmounting, stopping, or replacing the
// run bumps the generation, so continuations that were already in flight can no
// longer install timers, mutate runner state, or clear a newer run's timer.
//
// Polling is completion-scheduled: the next metadata request is only queued once
// the previous one has resolved, so a slow request can never overlap another.

export const RUN_POLL_INTERVAL_MS = 2000

const noop = () => {}

export const createRunLifecycle = ({
  fetchImpl = fetch,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  createAbortController = () => new AbortController(),
  pollIntervalMs = RUN_POLL_INTERVAL_MS,
  setRunningId = noop,
  setRunOutput = noop,
  setPending = noop,
  refreshRuns = noop,
} = {}) => {
  const state = { generation: 0, timerId: null, controller: null, creating: false, runId: null }

  const owns = (token) => state.generation === token

  const markCreating = (creating) => {
    if (state.creating === creating) return
    state.creating = creating
    setPending(creating)
  }

  // Drop authority over the current run: the owned timer is cleared, in-flight
  // client reads are aborted, and the new generation invalidates every token
  // handed to a continuation that has not resumed yet.
  const invalidate = () => {
    state.generation += 1
    if (state.timerId !== null) {
      clearTimer(state.timerId)
      state.timerId = null
    }
    state.controller?.abort()
    state.controller = null
    state.runId = null
    markCreating(false)
  }

  const request = (url, options = {}) =>
    fetchImpl(url, { ...options, signal: state.controller?.signal })

  const schedulePoll = (token, runId) => {
    if (!owns(token)) return
    state.timerId = setTimer(() => {
      state.timerId = null
      pollRun(token, runId)
    }, pollIntervalMs)
  }

  const pollRun = async (token, runId) => {
    const meta = await request(`/api/runs/${runId}`).then(r => r.json()).catch(() => null)
    if (!owns(token)) return
    if (meta && !meta.endTime) {
      schedulePoll(token, runId)
      return
    }

    const output = meta
      ? await request(`/api/runs/${runId}/output`).then(r => r.text()).catch(() => '')
      : null
    if (!owns(token)) return

    invalidate()
    setRunningId(null)
    if (meta) setRunOutput(output || meta.error || 'No output')
    refreshRuns()
  }

  const execute = async ({ providerId, prompt }) => {
    // A pending creation or a live run already owns the lifecycle; repeated
    // Execute clicks must not submit a second run.
    if (state.creating || state.runId !== null) return

    invalidate()
    const token = state.generation
    markCreating(true)
    state.controller = createAbortController()
    setRunOutput('')

    const result = await request('/api/runs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ providerId, prompt }),
    }).then(r => r.json()).catch(err => ({ error: err.message }))
    if (!owns(token)) return

    markCreating(false)
    if (!result?.runId || result.error) {
      invalidate()
      setRunOutput(`Error: ${result?.error || 'Run creation failed'}`)
      return
    }

    state.runId = result.runId
    setRunningId(result.runId)
    schedulePoll(token, result.runId)
  }

  // Explicit operator Stop is the only path that cancels the run server-side.
  const stop = async () => {
    const runId = state.runId
    invalidate()
    setRunningId(null)
    if (!runId) return
    // Deliberately unsignalled: invalidate() aborted the polling controller, and
    // the cancellation must still reach the server.
    await fetchImpl(`/api/runs/${runId}/stop`, { method: 'POST' }).catch(() => null)
  }

  // Unmount/navigation: release local ownership only. Server-side work keeps
  // running until the operator stops it explicitly.
  const dispose = invalidate

  return { execute, stop, dispose }
}
