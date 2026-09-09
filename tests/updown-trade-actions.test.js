const assert = require('node:assert/strict')
const { describe, it } = require('node:test')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const source = fs.readFileSync(path.join(__dirname, '../admin/src/components/updown/TradeHistory.jsx'), 'utf8')
const start = source.indexOf('const INVALID_AMOUNT_MESSAGE')
const end = source.indexOf('  const pnlColor', start)
assert.ok(start >= 0 && end > start, 'locate the actual component logic before its JSX')
// Execute the production component closure with persistent hook state and fake
// effects. No copied handlers, browser, server, or live trade data are involved.
const componentSource = source.slice(start, end).replace('export default ', '') + `
  return { busy, trades, showForm, editId, form, validationErrors,
    handleSubmit, handleEdit, handleDelete, setForm, setShowForm }
}
TradeHistory`

const trade = { id: 7, date: '2026-09-09', cost: 500, returnAmount: 650, note: 'test', direction: 'up' }
const input = { date: trade.date, cost: '200+300', returnAmount: '650', note: 'attempted edit', direction: 'up' }
const response = (ok, data) => ({ ok, json: async () => data })
const flush = () => new Promise(resolve => setImmediate(resolve))

const setup = async (method, request) => {
  const { runDashboardAction } = await import('../admin/src/utils/dashboardAction.mjs')
  const { parseTradeAmountExpression } = await import('../admin/src/components/updown/tradeAmountExpression.js')
  const state = []
  const changes = []
  const calls = []
  const toasts = []
  let cursor = 0
  let mounted = false
  const component = vm.runInNewContext(componentSource, {
    useState: initial => {
      const index = cursor++
      if (!(index in state)) state[index] = initial
      return [state[index], value => {
        state[index] = typeof value === 'function' ? value(state[index]) : value
        changes.push(state[index])
      }]
    },
    useCallback: fn => fn,
    useEffect: fn => { if (!mounted) fn() },
    useToast: () => ({ addToast: toast => toasts.push(toast) }),
    runDashboardAction,
    parseTradeAmountExpression,
    fetch: async (url, options) => {
      calls.push({ url, ...options })
      return options ? request() : response(true, { success: true, trades: [trade], summary: null })
    },
  })
  const render = () => { cursor = 0; const result = component(); mounted = true; return result }
  render()
  await flush()
  if (method === 'PUT') render().handleEdit(trade)
  else render().setShowForm(true)
  render().setForm({ ...input })
  changes.length = 0
  calls.length = 0
  return {
    render, calls, toasts, changes,
    invoke: () => method === 'DELETE'
      ? render().handleDelete(trade.id)
      : render().handleSubmit({ preventDefault() {} }),
  }
}

const assertRetained = h => {
  assert.deepEqual({ ...h.render().form }, input)
  assert.equal(h.render().showForm, true)
  assert.equal(h.render().busy, false)
  assert.equal(h.calls.length, 1, 'no success refresh after failure')
  assert.equal(h.toasts.length, 1)
  assert.equal(h.toasts[0].type, 'error')
  assert.equal(h.render().trades.length, 1)
}

describe('Trade History mutation integration (#336)', () => {
  for (const [method, status, error] of [['POST', 500, 'Save rejected'], ['PUT', 404, 'Trade not found'], ['DELETE', 500, 'Delete rejected']]) {
    it(`${method} HTTP ${status} failure preserves the editor and rows with feedback`, async () => {
      const h = await setup(method, () => ({ ...response(false, { error }), status }))
      await h.invoke()
      assertRetained(h)
      assert.equal(h.render().editId, method === 'PUT' ? trade.id : null)
      assert.equal(h.toasts[0].message, error)
      assert.equal(h.toasts[0].title, `${method === 'PUT' ? 'Update' : method === 'DELETE' ? 'Delete' : 'Save'} trade failed`)
      assert.equal(h.calls[0].method, method)
      assert.equal(h.calls[0].url, method === 'POST' ? '/api/updown/trades' : '/api/updown/trades/7')
    })

    it(`${method} network rejection releases busy state and retains input`, async () => {
      const h = await setup(method, () => { throw new Error('Disconnected') })
      await h.invoke()
      assertRetained(h)
      assert.equal(h.toasts[0].message, 'Disconnected')
      assert.deepEqual(h.changes, [true, false])
    })

    it(`${method} success refreshes once and releases pending controls`, async () => {
      let resolve
      const pending = new Promise(done => { resolve = done })
      const h = await setup(method, () => pending)
      const action = h.invoke()
      assert.equal(h.render().busy, true)
      await h.invoke()
      await h.render().handleDelete(trade.id)
      h.render().handleEdit({ ...trade, id: 99 })
      assert.equal(h.calls.length, 1, 'pending mutations cannot start conflicting actions')
      assert.deepEqual({ ...h.render().form }, input)
      resolve(response(true, {}))
      await action
      assert.equal(h.render().busy, false)
      assert.equal(h.calls.length, 2)
      assert.equal(h.calls[1].method, undefined, 'one GET refresh')
      assert.equal(h.toasts.length, 0)
      if (method === 'DELETE') {
        assert.equal(h.render().showForm, true)
        assert.deepEqual({ ...h.render().form }, input)
      } else {
        assert.equal(h.render().showForm, false)
        assert.equal(h.render().editId, null)
        assert.equal(h.render().form.cost, '')
        assert.equal(h.changes.filter(value => value?.cost === '').length, 1, 'reset once')
        assert.deepEqual(JSON.parse(h.calls[0].body), { ...input, cost: 500, returnAmount: 650 })
      }
    })
  }

  it('keeps invalid amounts local without starting a mutation', async () => {
    const h = await setup('POST', () => { throw new Error('must not request') })
    h.render().setForm({ ...input, cost: '12abc' })
    await h.invoke()
    assert.equal(h.calls.length, 0)
    assert.equal(h.render().busy, false)
    assert.ok(h.render().validationErrors.cost)
    assert.equal(h.render().showForm, true)
  })

  it('binds every form and row control to mutation busy state', () => {
    const controls = source.match(/<(?:button|input)\b[^>]*>/g)
    assert.ok(controls.length > 0)
    for (const control of controls) assert.match(control, /disabled=\{busy\}/)
    assert.match(source, /import \{ runDashboardAction \} from '\.\.\/\.\.\/utils\/dashboardAction\.mjs'/)
    assert.match(source, /import \{ useToast \} from '\.\.\/Toast'/)
  })
})
