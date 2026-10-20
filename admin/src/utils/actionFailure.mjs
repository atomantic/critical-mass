// Gateway routes reject with { success: false, error }; engine handlers behind them
// answer { success: false, message }. Either one is the reason the operator needs.
export function describeActionFailure(status, body) {
  const data = body && typeof body === 'object' ? body : {}
  const reason = [data.error, data.message].find(text => typeof text === 'string' && text.trim())
  if (reason) return reason.trim()
  return status
    ? `The server rejected the request (HTTP ${status}) without giving a reason. Check the engine logs.`
    : 'The server sent an unreadable response. Check the engine logs.'
}
