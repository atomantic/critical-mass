// Browser-local regression runner: inject the real React renderer/components
// from a Vite test entry, then call this function. Every fetch is replaced
// before mounting; no gateway, credentials, backups or trading state is used.
export async function runGlobalSettingsBrowserRegressions({ React, createRoot, NotificationsConfig, BackupRestore }) {
  const results = []
  const assert = (value, message) => { if (!value) throw new Error(message) }
  const waitFor = async predicate => {
    for (let i = 0; i < 200; i++) {
      if (predicate()) return
      await new Promise(resolve => setTimeout(resolve, 5))
    }
    throw new Error('Fixture did not settle')
  }
  const config = name => name === 'notifications'
    ? { enabled: true, telegram: { botToken: 'masked...0000', chatId: 'fixture-chat' }, rateLimitMs: 5000, dailySummaryHour: 20, quietHours: { enabled: false, start: 23, end: 7 }, events: {} }
    : { enabled: true, intervalMs: 86400000, fundStateIntervalMs: 3600000, maxBackups: 7, fundStateMaxBackups: 24, includePriceCache: false }
  const respond = (data, status = 200) => ({ ok: status < 400, status, json: async () => data })
  const originalFetch = window.fetch
  const host = document.createElement('div')
  document.body.append(host)
  let root
  try {
    for (const name of ['notifications', 'backups']) {
      const requests = [], pending = []
      let saving = false, holdRead = false, archives = []
      let stored = config(name)
      const readUrl = name === 'notifications' ? '/api/notifications/config' : '/api/backups'
      const writeUrl = name === 'notifications' ? readUrl : '/api/backups/config'
      const readData = () => name === 'notifications' ? stored : { config: stored, backups: archives, fundStateBackups: [] }
      window.fetch = (url, options = {}) => {
        const method = options.method || 'GET'
        requests.push({ url, method, body: options.body && JSON.parse(options.body) })
        if (method === 'PUT' && url === writeUrl) {
          saving = true
          return new Promise((resolve, reject) => pending.push({ kind: 'write', resolve, reject, body: JSON.parse(options.body) }))
        }
        if (url === readUrl && method === 'GET') {
          if (holdRead) return new Promise((resolve, reject) => pending.push({ kind: 'read', resolve, reject }))
          return Promise.resolve(respond(readData()))
        }
        if (url === '/api/notifications/stats') return Promise.resolve(respond({ sent: 0, errors: 0, queueDepth: 0 }))
        if (url === '/api/backups' && method === 'POST') {
          archives = [{ filename: 'synthetic.zip', createdAt: new Date().toISOString(), sizeBytes: 10 }]
          return Promise.resolve(respond({ success: true, filename: 'synthetic.zip', sizeBytes: 10 }))
        }
        if (url === '/api/backups/synthetic.zip' && method === 'DELETE') {
          archives = []
          return Promise.resolve(respond({ success: true }))
        }
        throw new Error(`Unexpected fixture request ${method} ${url}`)
      }
      root = createRoot(host)
      root.render(React.createElement(name === 'notifications' ? NotificationsConfig : BackupRestore))
      const id = name === 'notifications' ? 'rate-limit-ms' : 'backup-max-count'
      await waitFor(() => host.querySelector(`#${id}`))
      const field = () => host.querySelector(`#${id}`)
      const button = text => [...host.querySelectorAll('button')].find(node => node.textContent === text)
      const edit = (id, value) => {
        const input = host.querySelector(`#${id}`)
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, value)
        input.dispatchEvent(new Event('input', { bubbles: true }))
      }
      const desired = name === 'notifications' ? '6000' : '9'
      edit(id, desired)
      await waitFor(() => field().value === desired)
      const saveLabel = name === 'notifications' ? 'Save' : 'Save Settings'
      button(saveLabel).click()
      await waitFor(() => saving && field().matches(':disabled'))
      assert(button('Saving...').disabled, `${name}: repeated save was not blocked`)
      field().focus()
      assert(document.activeElement !== field(), `${name}: pending input remained focusable`)
      const write = pending.shift()
      assert(String(write.body[name === 'notifications' ? 'rateLimitMs' : 'maxBackups']) === desired, `${name}: wrong submitted draft`)
      stored = { ...stored, ...write.body }
      holdRead = name === 'notifications'
      write.resolve(respond(name === 'notifications' ? { success: true } : { success: true, config: stored }))
      if (name === 'notifications') {
        await waitFor(() => pending.some(item => item.kind === 'read'))
        assert(field().matches(':disabled'), 'notifications: unlocked before reconciliation')
        holdRead = false
        pending.shift().resolve(respond(stored))
      }
      await waitFor(() => !field().matches(':disabled'))
      assert(field().value === desired, `${name}: save discarded the submitted value`)
      results.push(`${name}: deferred save locks native inputs and Save until reconciliation`)

      if (name === 'backups') {
        edit(id, '11')
        await waitFor(() => field().value === '11')
        button('Create Backup Now').click()
        await waitFor(() => host.textContent.includes('synthetic.zip') && button('Delete'))
        assert(field().value === '11', 'backup create discarded dirty retention')
        button('Delete').click()
        await waitFor(() => button('Delete Backup'))
        button('Delete Backup').click()
        await waitFor(() => host.textContent.includes('Deleted synthetic.zip') && !button('Delete'))
        assert(field().value === '11', 'backup delete discarded dirty retention')
        results.push('backups: create/delete refresh archive lists while preserving dirty settings')
      }
      // HTTP and transport failures preserve the unsaved draft and token.
      for (const failure of ['http', 'network']) {
        edit(id, name === 'notifications' ? '7000' : '12')
        if (name === 'notifications') edit('bot-token', 'synthetic-token-draft')
        button(saveLabel).click()
        await waitFor(() => pending.some(item => item.kind === 'write'))
        const failedWrite = pending.shift()
        if (failure === 'http') failedWrite.resolve(respond({}, 503))
        else failedWrite.reject(new Error('Synthetic transport failure'))
        await waitFor(() => !field().matches(':disabled'))
        assert(field().value === (name === 'notifications' ? '7000' : '12'), `${name}: ${failure} lost draft`)
        if (name === 'notifications') assert(host.querySelector('#bot-token').value === 'synthetic-token-draft', `${failure}: token cleared without successful save`)
      }
      results.push(`${name}: HTTP/network save failure releases controls and preserves drafts`)
      if (name === 'notifications') {
        button(saveLabel).click()
        await waitFor(() => pending.some(item => item.kind === 'write'))
        const savedWrite = pending.shift()
        stored = { ...stored, ...savedWrite.body, telegram: { ...savedWrite.body.telegram, botToken: 'masked...1111' } }
        holdRead = true
        savedWrite.resolve(respond({ success: true }))
        await waitFor(() => pending.some(item => item.kind === 'read'))
        pending.shift().resolve(respond({}, 503))
        await waitFor(() => !field().matches(':disabled'))
        assert(host.querySelector('#bot-token').value === '', 'successful token write did not clear draft')
        assert(host.querySelector('#bot-token').placeholder === '••••••••', 'failed readback exposed token')
        assert(host.textContent.includes('Notification settings saved!') && host.textContent.includes('Settings may be out of date:'), 'readback failure replaced successful save result')
        button('Refresh').click()
        await waitFor(() => pending.some(item => item.kind === 'read'))
        const obsolete = pending.shift()
        edit(id, '8000')
        edit('bot-token', 'synthetic-next-token')
        button(saveLabel).click()
        await waitFor(() => pending.some(item => item.kind === 'write'))
        const nextWrite = pending.shift()
        stored = { ...stored, ...nextWrite.body, telegram: { ...nextWrite.body.telegram, botToken: 'masked...2222' } }
        nextWrite.resolve(respond({ success: true }))
        await waitFor(() => pending.some(item => item.kind === 'read'))
        pending.shift().resolve(respond(stored))
        await waitFor(() => !field().matches(':disabled'))
        obsolete.resolve(respond(config(name)))
        await new Promise(resolve => setTimeout(resolve, 20))
        assert(field().value === '8000', 'obsolete read replaced later confirmed save')
        assert(host.querySelector('#bot-token').placeholder === 'masked...2222', 'obsolete read replaced later token mask')
        results.push('notifications: readback failure preserves success, clears owned token and obsolete reads cannot overwrite a later save')
      }
      root.unmount()
      root = null
    }
    return results
  } finally {
    root?.unmount()
    host.remove()
    window.fetch = originalFetch
  }
}
