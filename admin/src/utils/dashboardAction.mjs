const responseErrorMessage = async (response, fallbackMessage) => {
  const payload = await response.json().catch(() => ({}))
  return payload.error || payload.message || fallbackMessage
}

const errorText = (error, fallback) => (error instanceof Error && error.message ? error.message : fallback)

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
    let response
    try {
      response = await request()
      if (!response.ok) {
        addToast({
          type: 'error',
          title: failureTitle,
          message: await responseErrorMessage(response, failureMessage),
        })
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
      await onSuccess?.(response)
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
