const { describe, it, afterEach } = require('node:test')
const assert = require('node:assert/strict')

const realFetch = global.fetch
afterEach(() => { global.fetch = realFetch })

describe('apiRequest raw uploads', () => {
  it('sends a file as-is under its own content type instead of JSON', async () => {
    const { apiRequest } = await import('../admin/src/utils/apiClient.js')
    let seen
    global.fetch = async (url, init) => {
      seen = { url, init }
      return { ok: true, status: 200, json: async () => ({ success: true, extracted: { target: 1 } }) }
    }
    const file = { type: 'image/png', size: 3 }
    const result = await apiRequest('POST', '/api/updown/screenshot', { rawBody: file, contentType: file.type })
    assert.equal(result.ok, true)
    assert.equal(seen.init.body, file)
    assert.deepEqual(seen.init.headers, { 'Content-Type': 'image/png' })
  })
})
