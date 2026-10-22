// Ownership fence for the AI Providers prompt runner.
//
// Every asynchronous step of a run (creation POST, metadata poll, output read,
// stop request, run-list refresh) is authorised by a generation token that is
// acquired synchronously *before* the first await. Unmounting, replacing, or
// settling the run bumps the generation, so continuations that were already in
// flight can no longer install timers, mutate runner state, or clear a newer
// run's timer.
//
// Polling is completion-scheduled: the next metadata request is only queued once
// the previous one has resolved, so a slow request can never overlap another.
//
// Server-side runs outlive the page, so ownership can be re-acquired with
// attach(runId) from persisted server state. Ownership is only released on an
// authoritative signal: a terminal metadata read (endTime set, or isActive
// false) or an acknowledged stop. An unreadable status or a failed stop keeps
// the run identity and surfaces a recoverable notice instead.

import { apiFetch } from './apiClient.js'

export const RUN_POLL_INTERVAL_MS = 2000

export const RUN_NOTICE = { READ: 'read', STOP: 'stop' }

const noop = () => {}

export const createRunLifecycle = ({
  fetchImpl = apiFetch,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  createAbortController = () => new AbortController(),
  pollIntervalMs = RUN_POLL_INTERVAL_MS,
  setRunningId = noop,
  setRunOutput = noop,
  setPending = noop,
  setStopPending = noop,
  setRunNotice = noop,
  refreshRuns = noop,
} = {}) => {
  const state = {
    generation: 0, timerId: null, controller: null, creating: false, runId: null, polling: false, stopping: false, notice: null,
  }

  const owns = (token) => state.generation === token

  const markCreating = (creating) => {
    if (state.creating === creating) return
    state.creating = creating
    setPending(creating)
  }

  const setNotice = (notice) => {
    state.notice = notice
    setRunNotice(notice)
  }

  const markStopping = (stopping) => {
    if (state.stopping === stopping) return
    state.stopping = stopping
    setStopPending(stopping)
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
    state.polling = false
    state.notice = null
    markCreating(false)
    markStopping(false)
  }

  const request = (url, options = {}) =>
    fetchImpl(url, { ...options, signal: state.controller?.signal })

  // Metadata read that distinguishes "the server answered" from "the read failed":
  // a transport error, non-2xx status, or unreadable body is never terminal.
  const readMeta = async (runId) => {
    const response = await request(`/api/runs/${runId}`).catch(() => null)
    if (!response) return { error: 'Could not reach the server to read run status.' }
    if (!response.ok) return { error: `Run status is unavailable (HTTP ${response.status}).` }
    const meta = await response.json().catch(() => null)
    return meta && typeof meta === 'object' ? { meta } : { error: 'Run status response was unreadable.' }
  }

  // Returns null for a failed read, distinct from '' for a run with no output.
  const readOutput = async (runId) => {
    const response = await request(`/api/runs/${runId}/output`).catch(() => null)
    return response?.ok ? response.text().catch(() => null) : null
  }

  const schedulePoll = (token, runId) => {
    if (!owns(token)) return
    state.timerId = setTimer(() => {
      state.timerId = null
      pollRun(token, runId)
    }, pollIntervalMs)
  }

  const pollRun = async (token, runId) => {
    if (!owns(token)) return
    state.polling = true
    const { meta, error } = await readMeta(runId)
    if (!owns(token)) return
    state.polling = false

    // Ownership is kept: the run may still be live on the server, so an
    // unreadable status must be retryable rather than look like completion.
    if (!meta) {
      setNotice({ kind: RUN_NOTICE.READ, message: error })
      return
    }

    // isActive is authoritative: a record that has no endTime but is no longer
    // active was interrupted (e.g. server restart) and will never finish.
    const interrupted = !meta.endTime && meta.isActive === false
    if (!meta.endTime && !interrupted) {
      // A successful read only clears a read error; an unacknowledged stop stays
      // visible until a retry begins or the run authoritatively settles.
      if (state.notice?.kind === RUN_NOTICE.READ) setNotice(null)
      schedulePoll(token, runId)
      return
    }

    const output = await readOutput(runId)
    if (!owns(token)) return

    // A failed output read is not "No output": keep ownership and offer a retry.
    if (output === null) {
      setNotice({ kind: RUN_NOTICE.READ, message: 'Run finished but its output could not be read.' })
      return
    }

    invalidate()
    setRunningId(null)
    setNotice(null)
    const fallback = interrupted ? 'Run was interrupted before it finished.' : 'No output'
    setRunOutput(output || meta.error || fallback)
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
    setNotice(null)

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

  // Take (or re-take) ownership of a run that already exists on the server, e.g.
  // after navigation or reload. No creation POST is issued; the first metadata
  // read happens immediately and settles completed/interrupted runs in place.
  const attach = (runId) => {
    if (!runId || state.creating || state.runId === runId) return
    invalidate()
    const token = state.generation
    state.runId = runId
    state.controller = createAbortController()
    setRunOutput('')
    setNotice(null)
    setRunningId(runId)
    pollRun(token, runId)
  }

  // Re-read status (and output, once terminal) after a read notice.
  const refresh = () => {
    const runId = state.runId
    if (runId === null || state.polling) return
    if (state.timerId !== null) {
      clearTimer(state.timerId)
      state.timerId = null
    }
    setNotice(null)
    pollRun(state.generation, runId)
  }

  // Explicit operator Stop is the only path that cancels the run server-side.
  // Local ownership is kept until the server acknowledges: a failed request
  // leaves the run identity and a visible, retryable error in place.
  const stop = async (runId = state.runId) => {
    if (!runId || state.stopping) return
    if (state.runId !== runId) attach(runId)
    if (state.runId !== runId) return
    const token = state.generation
    markStopping(true)
    setNotice(null)

    // Deliberately unsignalled: the cancellation must still reach the server if
    // the polling controller is aborted by navigation.
    const response = await fetchImpl(`/api/runs/${runId}/stop`, { method: 'POST' }).catch(() => null)
    if (!owns(token)) return
    markStopping(false)

    if (response?.ok) {
      invalidate()
      setRunningId(null)
      setRunOutput('Run stopped.')
      refreshRuns()
      return
    }

    // 404 means the server no longer considers the run active (it finished or
    // was already stopped), which is not proof our stop landed: re-read the
    // authoritative status and let that settle ownership.
    if (response?.status === 404) {
      refresh()
      return
    }

    const reason = response ? `The server rejected the stop request (HTTP ${response.status}).` : 'Could not reach the server to stop the run.'
    setNotice({ kind: RUN_NOTICE.STOP, message: `${reason} The run may still be working — retry Stop.` })
  }

  // Unmount/navigation: release local ownership only. Server-side work keeps
  // running until the operator stops it explicitly.
  const dispose = invalidate

  return { execute, attach, refresh, stop, dispose }
}
