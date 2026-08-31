const responseErrorMessage = async (response, fallbackMessage) => {
  const payload = await response.json().catch(() => ({}))
  return payload.error || payload.message || fallbackMessage
}

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
    const response = await request()
    if (!response.ok) {
      addToast({
        type: 'error',
        title: failureTitle,
        message: await responseErrorMessage(response, failureMessage),
      })
      return false
    }

    await onSuccess?.(response)
    return true
  } catch (error) {
    addToast({
      type: 'error',
      title: failureTitle,
      message: error instanceof Error && error.message ? error.message : failureMessage,
    })
    return false
  } finally {
    setBusy(false)
    onSettled?.()
  }
}
