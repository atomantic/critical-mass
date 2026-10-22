import { describeMutationFailure } from './apiClient.js'

const errorText = (error, fallback) => (error instanceof Error && error.message ? error.message : fallback)

// `request` resolves to a shared API client result ({ ok, status, data, error }).
export const runDashboardAction = async ({
  setBusy,
  request,
  addToast,
  failureTitle,
  failureMessage,
  onSuccess,
  onSettled,
}) => {
  setBusy(true)

  try {
    let result
    try {
      result = await request()
      if (!result.ok) {
        addToast({ type: 'error', title: failureTitle, message: describeMutationFailure(result, failureMessage) })
        return false
      }
    } catch (error) {
      addToast({ type: 'error', title: failureTitle, message: errorText(error, failureMessage) })
      return false
    }

    // The server already accepted the request, so a throw from here on (an
    // unreadable reply body, a failed follow-up refresh) must not be reported
    // as a failure: that invites the operator to repeat an action that took effect.
    try {
      await onSuccess?.(result)
    } catch (error) {
      addToast({
        type: 'warning',
        title: 'Request accepted',
        message: `The server accepted the request, but this view could not be updated (${errorText(error, 'unknown error')}). Refresh to see the result before retrying.`,
      })
    }
    return true
  } finally {
    setBusy(false)
    onSettled?.()
  }
}
