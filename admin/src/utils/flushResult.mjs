// Pure decision logic for a PM2 log-flush completion (`logs:flushed`),
// extracted from useLogStream/LogViewer so it can be unit-tested without
// React, a real socket, or a real PM2 flush (see #451).

/**
 * Whether a `logs:flushed` payload applies to the currently in-flight flush
 * request. Guards against three ways a stale/duplicate response could
 * otherwise be misapplied:
 *  - no request is pending (already settled — a duplicate error+close, or a
 *    late response after disconnect already resolved it as a failure)
 *  - the payload is for a different process than the one that was flushed
 *  - the selected process has since changed (switched tabs mid-flush)
 */
export const shouldAcceptFlushResult = (pending, data, currentProcessName) => {
  if (!pending || !data) return false
  if (data.processName !== pending.processName) return false
  if (data.processName !== currentProcessName) return false
  return true
}

/** Builds the one toast a completed flush should produce, success or failure. */
export const flushResultToast = ({ success, reason }, processName) => {
  if (success) {
    return { type: 'success', title: 'Logs Flushed', message: `Flushed logs for ${processName}` }
  }
  return {
    type: 'error',
    title: 'Flush Failed',
    message: reason ? `Failed to flush logs for ${processName}: ${reason}` : `Failed to flush logs for ${processName}`,
  }
}
