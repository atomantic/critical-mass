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
      request: async () => ({ ok: false, status: 503, data: { error: 'exchange is unavailable' }, error: 'exchange is unavailable' }),
      addToast: (toast) => toasts.push(toast),
      failureTitle: 'Order Sync Failed',
      failureMessage: 'Could not sync DCA orders',
    })

    assert.equal(succeeded, false)
    assert.deepEqual(busyStates, [true, false])
    assert.equal(toasts[0].message, 'exchange is unavailable')
  })

  it('does not report an accepted request as failed when its reply cannot be read', async () => {
    const { runDashboardAction } = await loadAction()
    const events = []
    const toasts = []

    const succeeded = await runDashboardAction({
      setBusy: (busy) => events.push(`busy:${busy}`),
      request: async () => ({ ok: true, status: 200, data: null, error: null }),
      addToast: (toast) => toasts.push(toast),
      failureTitle: 'Sell Retry Failed',
      failureMessage: 'Could not place the sell for this buy',
      onSuccess: async () => { throw new SyntaxError('Unexpected token <') },
      onSettled: () => events.push('settled'),
    })

    assert.equal(succeeded, true)
    assert.deepEqual(events, ['busy:true', 'busy:false', 'settled'])
    assert.equal(toasts.length, 1)
    assert.equal(toasts[0].type, 'warning')
    assert.notEqual(toasts[0].title, 'Sell Retry Failed')
    assert.match(toasts[0].message, /accepted the request.*Unexpected token <.*Refresh/)
  })

  it('says a lost reply may have been applied when no status was read', async () => {
    const { runDashboardAction } = await loadAction()
    const toasts = []

    await runDashboardAction({
      setBusy: () => {},
      request: async () => ({ ok: false, status: 0, data: null, error: 'Failed to fetch' }),
      addToast: (toast) => toasts.push(toast),
      failureTitle: 'Order Sync Failed',
      failureMessage: 'Could not sync DCA orders',
    })

    assert.match(toasts[0].message, /^Failed to fetch\. The request may have reached the server/)
  })

  it('preserves success callbacks and always runs export cleanup', async () => {
    const { runDashboardAction } = await loadAction()
    const events = []

    const succeeded = await runDashboardAction({
      setBusy: (busy) => events.push(`busy:${busy}`),
      request: async () => ({ ok: true, status: 200, data: null, error: null }),
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
