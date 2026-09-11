const { describe, it } = require('node:test')
const assert = require('node:assert/strict')

// Exercises the backend flush failure payload through the frontend's pure
// result-handling logic (admin/src/utils/flushResult.mjs), without a real
// PM2 flush, a real socket, or React (#451).
const loadFlushResult = () => import('../admin/src/utils/flushResult.mjs')

describe('flush result handling (issue #451)', () => {
  it('accepts a matching success/failure payload for the pending request', async () => {
    const { shouldAcceptFlushResult } = await loadFlushResult()
    const pending = { processName: 'critical-mass' }

    assert.equal(shouldAcceptFlushResult(pending, { processName: 'critical-mass', success: true }, 'critical-mass'), true)
    assert.equal(shouldAcceptFlushResult(pending, { processName: 'critical-mass', success: false, reason: 'exit code 1' }, 'critical-mass'), true)
  })

  it('rejects a duplicate/stale completion when nothing is pending', async () => {
    const { shouldAcceptFlushResult } = await loadFlushResult()

    assert.equal(shouldAcceptFlushResult(null, { processName: 'critical-mass', success: true }, 'critical-mass'), false)
  })

  it('rejects a response for a different process than the one flushed', async () => {
    const { shouldAcceptFlushResult } = await loadFlushResult()
    const pending = { processName: 'critical-mass' }

    assert.equal(shouldAcceptFlushResult(pending, { processName: 'other-app', success: true }, 'critical-mass'), false)
  })

  it('rejects a response after the selected process has since changed', async () => {
    const { shouldAcceptFlushResult } = await loadFlushResult()
    const pending = { processName: 'critical-mass' }

    // User switched tabs to 'other-app' while the 'critical-mass' flush was
    // still in flight; the late response must not be applied.
    assert.equal(shouldAcceptFlushResult(pending, { processName: 'critical-mass', success: true }, 'other-app'), false)
  })

  it('builds a success toast only for success:true', async () => {
    const { flushResultToast } = await loadFlushResult()

    const toast = flushResultToast({ success: true }, 'critical-mass')
    assert.equal(toast.type, 'success')
    assert.equal(toast.title, 'Logs Flushed')
    assert.match(toast.message, /critical-mass/)
  })

  it('builds an error toast for success:false, naming the reason when present', async () => {
    const { flushResultToast } = await loadFlushResult()

    const withReason = flushResultToast({ success: false, reason: 'exit code 1' }, 'critical-mass')
    assert.equal(withReason.type, 'error')
    assert.equal(withReason.title, 'Flush Failed')
    assert.match(withReason.message, /exit code 1/)

    const withoutReason = flushResultToast({ success: false }, 'critical-mass')
    assert.equal(withoutReason.type, 'error')
    assert.doesNotMatch(withoutReason.message, /undefined/)
  })
})
