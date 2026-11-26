const { afterEach, it } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

// Exercise real persistence with a disposable data path. The checkout base is
// read-only; no exchange connection or live configuration is changed.
const paths = require('../../../src/paths')
const configUtils = require('../../../src/config-utils')
const { prepareConfigUpdate, persistConfigUpdate } = require('../../../src/routes/config-update')
const originalDataDir = paths.DATA_DIR
let tempRoot

afterEach(() => {
  paths.DATA_DIR = originalDataDir
  configUtils._resetConfigCacheForTests()
  if (tempRoot) fs.rmSync(tempRoot, { recursive: true, force: true })
  tempRoot = undefined
})

it('full UI saves retain stored depth values while explicit legacy API edits still work', async () => {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'depth-capability-'))
  paths.DATA_DIR = tempRoot
  configUtils._resetConfigCacheForTests()
  configUtils.updateFundConfig('coinbase', 'BTC-USDC', { productId: 'BTC-USDC',
    regime: { minDepthUsdc: 4321, depthPauseMs: 12345, maxSpreadBps: 40, flashMoveMult: 2 } })
  configUtils.updateFundConfig('coinbase', 'LTC-USDC', { productId: 'LTC-USDC', regime: { maxSpreadBps: 40 } })
  configUtils.updateFundConfig('coinbase', 'LTC-USDC', { regime: { maxSpreadBps: 35 } })
  const withoutDepth = configUtils.getFundConfig('coinbase', 'LTC-USDC').regime
  assert.ok(!('minDepthUsdc' in withoutDepth) && !('depthPauseMs' in withoutDepth), 'absent legacy keys are not invented')
  configUtils.updateNotificationConfig({ events: { depth_pause: false, spread_pause: true } })
  const prepared = prepareConfigUpdate({ exchange: 'coinbase', pair: 'BTC-USDC', fullConfig: true,
    updates: { productId: 'BTC-USDC' }, rawRegime: { maxSpreadBps: 35, flashMoveMult: 4 } })
  assert.equal(prepared.valid, true)
  assert.ok(!('minDepthUsdc' in prepared.engineUpdates))
  await persistConfigUpdate('coinbase', 'BTC-USDC', prepared, { request: async () => ({ success: true }) })
  configUtils._resetConfigCacheForTests()
  let saved = configUtils.getRegimeConfig('coinbase', 'BTC-USDC')
  assert.equal(saved.minDepthUsdc, 4321)
  assert.equal(saved.depthPauseMs, 12345)
  assert.equal(saved.maxSpreadBps, 35)
  assert.equal(saved.flashMoveMult, 4)
  configUtils.updateNotificationConfig({ events: { spread_pause: false } })
  assert.equal(configUtils.getNotificationConfig().events.depth_pause, false)
  const explicit = prepareConfigUpdate({ exchange: 'coinbase', pair: 'BTC-USDC', fullConfig: true,
    updates: {}, rawRegime: { minDepthUsdc: 9876, depthPauseMs: 0 } })
  assert.equal(explicit.valid, true)
  await persistConfigUpdate('coinbase', 'BTC-USDC', explicit, { request: async () => ({ success: true }) })
  saved = configUtils.getRegimeConfig('coinbase', 'BTC-USDC')
  assert.equal(saved.minDepthUsdc, 9876)
  assert.equal(saved.depthPauseMs, 0)
})
