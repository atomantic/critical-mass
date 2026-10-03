const { before, describe, it } = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const vm = require('node:vm')
const { createRequire } = require('node:module')
const { pathToFileURL } = require('node:url')

const adminRequire = createRequire(path.join(__dirname, '..', 'admin/package.json'))
const React = adminRequire('react')
const compiled = new Map()
const notificationConfig = () => ({ enabled: true, telegram: { botToken: 'masked...0000', chatId: 'fixture-chat' }, rateLimitMs: 5000, dailySummaryHour: 20, quietHours: { enabled: false, start: 23, end: 7 }, events: {} })
const backupConfig = () => ({ enabled: true, intervalMs: 86400000, fundStateIntervalMs: 3600000, maxBackups: 7, fundStateMaxBackups: 24, includePriceCache: false })
const response = (data, status = 200) => ({ ok: status < 400, status, json: async () => data })
const deferred = () => {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const flush = () => new Promise(resolve => setImmediate(resolve))

before(async () => {
  const { rolldown } = await import(pathToFileURL(adminRequire.resolve('rolldown')).href)
  for (const name of ['NotificationsConfig', 'BackupRestore']) {
    const bundle = await rolldown({ input: path.join(__dirname, `../admin/src/components/${name}.jsx`), external: () => true, transform: { jsx: 'react' } })
    try { compiled.set(name, (await bundle.generate({ format: 'cjs' })).output[0].code) }
    finally { await bundle.close() }
  }
})

// Render the actual components and execute their actual handlers, with only hook
// ownership and network IO replaced. Deferred responses cover ordering, rather
// than asserting against source text. All mutations remain inside this fixture.
function createView(name) {
  const values = [], effects = [], requests = [], queued = []
  let index = 0, mounted = false
  const slot = initial => {
    const key = index++
    if (!(key in values)) values[key] = typeof initial === 'function' ? initial() : initial
    return key
  }
  const hooks = { ...React,
    useState(initial) { const key = slot(initial); return [values[key], value => { values[key] = typeof value === 'function' ? value(values[key]) : value }] },
    useRef(initial) { return values[slot(() => ({ current: initial }))] },
    useEffect(effect) { if (!mounted) effects.push(effect) },
  }
  const fetch = async (url, options = {}) => {
    const method = options.method || 'GET'
    requests.push({ url, method, body: options.body && JSON.parse(options.body) })
    const next = queued.findIndex(item => item.url === url && item.method === method)
    if (next >= 0) return queued.splice(next, 1)[0].result
    if (url === '/api/notifications/config') return response(notificationConfig())
    if (url === '/api/notifications/stats') return response({ sent: 0, errors: 0, queueDepth: 0 })
    if (url === '/api/backups') return response({ config: backupConfig(), backups: [], fundStateBackups: [] })
    throw new Error(`Unexpected fixture request ${method} ${url}`)
  }
  const exports = {}
  const context = vm.createContext({ exports, module: { exports }, React: hooks, fetch,
    setInterval: () => 1, clearInterval() {},
    require: name => {
      if (name === 'react') return hooks
      if (name === './ModalDialog') return ({ children }) => children
      throw new Error(`Unexpected fixture import ${name}`)
    },
  })
  vm.runInContext(compiled.get(name), context)
  const render = () => { index = 0; const tree = context.module.exports(); mounted = true; return tree }
  return { render, requests,
    queue(url, method, result) { queued.push({ url, method, result }) },
    async mount() { render(); effects.forEach(effect => effect()); await flush(); return render() },
  }
}
function elements(tree) { return Array.isArray(tree) ? tree.flatMap(elements) : React.isValidElement(tree) ? [tree, ...elements(tree.props.children)] : [] }
function text(tree) { return Array.isArray(tree) ? tree.map(text).join('') : React.isValidElement(tree) ? text(tree.props.children) : typeof tree === 'string' ? tree : '' }
function find(tree, predicate) { const node = elements(tree).find(predicate); assert.ok(node, 'expected rendered control'); return node }
const field = (tree, id) => find(tree, node => node.props.id === id)
const button = (tree, label) => find(tree, node => node.type === 'button' && text(node) === label)
const locked = tree => find(tree, node => node.type === 'fieldset').props.disabled
const edit = (view, id, value) => field(view.render(), id).props.onChange({ target: { value } })

for (const [name, url, fieldId, saveLabel] of [
  ['NotificationsConfig', '/api/notifications/config', 'rate-limit-ms', 'Save'],
  ['BackupRestore', '/api/backups/config', 'backup-max-count', 'Save Settings'],
]) describe(`${name} owned settings transaction (#948)`, () => {
  it('synchronously blocks duplicate saves and edits until the write and reconciliation settle', async () => {
    const view = createView(name)
    await view.mount()
    const write = deferred(), read = deferred()
    view.queue(url, 'PUT', write.promise)
    if (name === 'NotificationsConfig') view.queue(url, 'GET', read.promise)
    const save = button(view.render(), saveLabel).props.onClick
    const pending = save()
    await save() // A second call before React rerenders cannot launch a write.
    assert.equal(view.requests.filter(r => r.method === 'PUT').length, 1)
    assert.equal(locked(view.render()), true)
    edit(view, fieldId, '9') // Even a stale handler cannot mutate while locked.
    assert.equal(field(view.render(), fieldId).props.value, name === 'NotificationsConfig' ? 5000 : 7)
    if (name === 'NotificationsConfig') {
      write.resolve(response({ success: true }))
      await flush()
      assert.equal(locked(view.render()), true, 'masked config readback is part of the save')
      assert.equal(button(view.render(), 'Saving...').props.disabled, true)
      read.resolve(response({ ...notificationConfig(), rateLimitMs: 5500 }))
    } else {
      const body = deferred()
      write.resolve({ ok: true, json: () => body.promise })
      await flush()
      assert.equal(locked(view.render()), true, 'authoritative body remains part of the save')
      body.resolve({ success: true, config: { ...backupConfig(), maxBackups: 8 } })
    }
    await pending
    assert.equal(locked(view.render()), false)
    assert.equal(field(view.render(), fieldId).props.value, name === 'NotificationsConfig' ? 5500 : 8)
  })

  for (const failure of ['http', 'network']) it(`preserves unsaved settings on ${failure} failure and releases the save gate`, async () => {
    const view = createView(name)
    await view.mount()
    edit(view, fieldId, name === 'NotificationsConfig' ? '6000' : '9')
    if (name === 'NotificationsConfig') edit(view, 'bot-token', 'synthetic-new-token')
    const write = deferred()
    view.queue(url, 'PUT', write.promise)
    const pending = button(view.render(), saveLabel).props.onClick()
    if (failure === 'http') write.resolve(response({}, 503))
    else write.reject(new Error('Synthetic transport failure'))
    await pending
    assert.equal(locked(view.render()), false)
    assert.equal(field(view.render(), fieldId).props.value, name === 'NotificationsConfig' ? 6000 : 9)
    assert.ok(text(view.render()).includes(failure === 'http' ? 'Failed to save settings' : 'Synthetic transport failure'))
    if (name === 'NotificationsConfig') assert.equal(field(view.render(), 'bot-token').props.value, 'synthetic-new-token')
  })
})

describe('notification reconciliation and token ownership', () => {
  it('clears only a successfully saved token, retains a masked display and releases controls on readback failure', async () => {
    const view = createView('NotificationsConfig')
    await view.mount()
    edit(view, 'bot-token', 'synthetic-new-token')
    view.queue('/api/notifications/config', 'PUT', response({ success: true }))
    view.queue('/api/notifications/config', 'GET', response({}, 503))
    await button(view.render(), 'Save').props.onClick()
    assert.equal(field(view.render(), 'bot-token').props.value, '')
    assert.equal(field(view.render(), 'bot-token').props.placeholder, '••••••••')
    assert.equal(locked(view.render()), false)
    assert.ok(text(view.render()).includes('Notification settings saved!'))
    assert.ok(text(view.render()).includes('Settings may be out of date: Failed to load notifications config (HTTP 503)'))
    // A later read cannot replace a draft edited during that read.
    const read = deferred()
    view.queue('/api/notifications/config', 'GET', read.promise)
    const refresh = button(view.render(), 'Refresh').props.onClick()
    edit(view, 'rate-limit-ms', '6000')
    edit(view, 'bot-token', 'synthetic-next-token')
    read.resolve(response(notificationConfig()))
    await refresh
    assert.equal(field(view.render(), 'rate-limit-ms').props.value, 6000)
    assert.equal(field(view.render(), 'bot-token').props.value, 'synthetic-next-token')
  })

  it('ignores an older read and never sends a stored mask in the next save', async () => {
    const view = createView('NotificationsConfig')
    await view.mount()
    view.queue('/api/notifications/config', 'PUT', response({ success: true }))
    view.queue('/api/notifications/config', 'GET', response({}, 503))
    await button(view.render(), 'Save').props.onClick()
    const stale = deferred()
    view.queue('/api/notifications/config', 'GET', stale.promise)
    const refresh = button(view.render(), 'Refresh').props.onClick()
    edit(view, 'rate-limit-ms', '6000')
    view.queue('/api/notifications/config', 'PUT', response({ success: true }))
    view.queue('/api/notifications/config', 'GET', response({ ...notificationConfig(), rateLimitMs: 6000 }))
    await button(view.render(), 'Save').props.onClick()
    stale.resolve(response(notificationConfig()))
    await refresh
    assert.equal(field(view.render(), 'rate-limit-ms').props.value, 6000)
    assert.equal(view.requests.filter(r => r.method === 'PUT').at(-1).body.telegram.botToken, undefined)
  })

  it('shows a network readback failure separately from the successful save', async () => {
    const view = createView('NotificationsConfig')
    await view.mount()
    view.queue('/api/notifications/config', 'PUT', response({ success: true }))
    const read = deferred()
    view.queue('/api/notifications/config', 'GET', read.promise)
    const pending = button(view.render(), 'Save').props.onClick()
    await flush()
    read.reject(new Error('Synthetic refresh failure'))
    await pending
    assert.equal(locked(view.render()), false)
    assert.ok(text(view.render()).includes('Notification settings saved!'))
    assert.ok(text(view.render()).includes('Settings may be out of date: Synthetic refresh failure'))
  })
})

describe('backup list refreshes', () => {
  it('keeps a dirty settings draft when creating a backup updates the list', async () => {
    const view = createView('BackupRestore')
    await view.mount()
    edit(view, 'backup-max-count', '9')
    view.queue('/api/backups', 'POST', response({ filename: 'fixture.zip', sizeBytes: 10 }))
    const read = deferred()
    view.queue('/api/backups', 'GET', read.promise)
    await button(view.render(), 'Create Backup Now').props.onClick()
    read.resolve(response({ config: backupConfig(), backups: [{ filename: 'fixture.zip', timestamp: Date.now(), sizeBytes: 10 }], fundStateBackups: [] }))
    await flush()
    assert.equal(field(view.render(), 'backup-max-count').props.value, 9)
    assert.ok(text(view.render()).includes('fixture.zip'))
    assert.ok(text(view.render()).includes('Backup created:'))
  })

  it('updates lists from an earlier read without replacing a later authoritative save', async () => {
    const view = createView('BackupRestore')
    await view.mount()
    view.queue('/api/backups', 'POST', response({ filename: 'fixture.zip', sizeBytes: 10 }))
    const read = deferred()
    view.queue('/api/backups', 'GET', read.promise)
    await button(view.render(), 'Create Backup Now').props.onClick()
    edit(view, 'backup-max-count', '9')
    view.queue('/api/backups/config', 'PUT', response({ success: true, config: { ...backupConfig(), maxBackups: 9 } }))
    await button(view.render(), 'Save Settings').props.onClick()
    read.resolve(response({ config: backupConfig(), backups: [{ filename: 'fixture.zip', createdAt: new Date().toISOString(), sizeBytes: 10 }], fundStateBackups: [] }))
    await flush()
    assert.equal(field(view.render(), 'backup-max-count').props.value, 9)
    assert.ok(text(view.render()).includes('fixture.zip'))
    assert.ok(text(view.render()).includes('Backup settings saved!'))
  })

  it('keeps unsaved retention while deleting a backup refreshes the archive list', async () => {
    const view = createView('BackupRestore')
    view.queue('/api/backups', 'GET', response({ config: backupConfig(), backups: [{ filename: 'fixture.zip', createdAt: new Date().toISOString(), sizeBytes: 10 }], fundStateBackups: [] }))
    await view.mount()
    edit(view, 'backup-max-count', '9')
    button(view.render(), 'Delete').props.onClick()
    view.queue('/api/backups/fixture.zip', 'DELETE', response({ success: true }))
    view.queue('/api/backups', 'GET', response({ config: backupConfig(), backups: [], fundStateBackups: [] }))
    await button(view.render(), 'Delete Backup').props.onClick()
    await flush()
    assert.equal(field(view.render(), 'backup-max-count').props.value, 9)
    assert.ok(text(view.render()).includes('Deleted fixture.zip'))
    assert.equal(elements(view.render()).some(node => node.type === 'button' && text(node) === 'Delete'), false)
  })

  it('keeps the draft and action result when list refresh fails', async () => {
    const view = createView('BackupRestore')
    await view.mount()
    edit(view, 'backup-max-count', '9')
    view.queue('/api/backups', 'POST', response({ filename: 'fixture.zip', sizeBytes: 10 }))
    view.queue('/api/backups', 'GET', response({}, 503))
    await button(view.render(), 'Create Backup Now').props.onClick()
    await flush()
    assert.equal(field(view.render(), 'backup-max-count').props.value, 9)
    assert.ok(text(view.render()).includes('Backup created:'))
    assert.ok(text(view.render()).includes('Backup list may be out of date: Failed to load backups (HTTP 503)'))
  })
})
