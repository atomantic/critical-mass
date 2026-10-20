// Gateway routes reject with { success: false, error }; engine handlers behind them
// answer { success: false, message }. Either one is the reason the operator needs.
export function describeActionFailure(status, body) {
  const data = body && typeof body === 'object' ? body : {}
  const reason = [data.error, data.message].find(text => typeof text === 'string' && text.trim())
  if (reason) return reason.trim()
  if (!status) return 'The server sent an unreadable response. Check the engine logs.'
  // A 2xx reply can still carry { success: false } or a body that is not JSON.
  const outcome = status < 400 ? 'reported a failure' : 'rejected the request'
  return `The server ${outcome} (HTTP ${status}) without giving a reason. Check the engine logs.`
}
