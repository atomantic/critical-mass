const { describe, it } = require('node:test')
const assert = require('node:assert/strict')

const loadAction = () => import('../admin/src/utils/dashboardAction.mjs')

describe('DCA dashboard request lifecycle (issue #283)', () => {
  for (const [action, failureTitle] of [
    ['configuration update', 'Configuration Update Failed'],
    ['consolidation', 'Consolidation Failed'],
    ['order sync', 'Order Sync Failed'],
    ['regime export', 'Export Failed'],
  ]) {
    it(`releases the ${action} busy flag after a rejected request`, async () => {
      const { runDashboardAction } = await loadAction()
      const busyStates = []
      const toasts = []

      const succeeded = await runDashboardAction({
        setBusy: (busy) => busyStates.push(busy),
        request: async () => { throw new Error('gateway disconnected') },
        addToast: (toast) => toasts.push(toast),
        failureTitle,
        failureMessage: `Could not complete ${action}`,
      })

      assert.equal(succeeded, false)
      assert.deepEqual(busyStates, [true, false])
      assert.deepEqual(toasts, [{
        type: 'error',
        title: failureTitle,
        message: 'gateway disconnected',
      }])
    })
  }

  it('reports a server error and still releases the control on a non-OK response', async () => {
    const { runDashboardAction } = await loadAction()
    const busyStates = []
    const toasts = []

    const succeeded = await runDashboardAction({
      setBusy: (busy) => busyStates.push(busy),
      request: async () => ({
        ok: false,
        json: async () => ({ error: 'exchange is unavailable' }),
      }),
      addToast: (toast) => toasts.push(toast),
      failureTitle: 'Order Sync Failed',
      failureMessage: 'Could not sync DCA orders',
    })

    assert.equal(succeeded, false)
    assert.deepEqual(busyStates, [true, false])
    assert.equal(toasts[0].message, 'exchange is unavailable')
  })

  it('preserves success callbacks and always runs export cleanup', async () => {
    const { runDashboardAction } = await loadAction()
    const events = []

    const succeeded = await runDashboardAction({
      setBusy: (busy) => events.push(`busy:${busy}`),
      request: async () => ({ ok: true }),
      addToast: () => assert.fail('success must not add an error toast'),
      failureTitle: 'Export Failed',
      failureMessage: 'Could not export to regime',
      onSuccess: async () => events.push('success'),
      onSettled: () => events.push('settled'),
    })

    assert.equal(succeeded, true)
    assert.deepEqual(events, ['busy:true', 'success', 'busy:false', 'settled'])
  })
})
