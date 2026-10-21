const { before, describe, it } = require('node:test')
const assert = require('node:assert/strict')

let buildSavePayload
before(async () => {
  ;({ buildSavePayload } = await import('../admin/src/utils/configSavePayload.mjs'))
})

describe('buildSavePayload (#1395)', () => {
  const baseline = { productId: 'BTC-USDC', dryRun: true, amount: 25,
    regime: { baseSizeUsdc: 50, maxUsdcDeployed: 1000, ladder: [1, 2], minDepthUsdc: 10 } }

  it('sends nothing for an unchanged draft', () => {
    assert.deepEqual(buildSavePayload(structuredClone(baseline), baseline), {})
  })

  it('sends only changed fund and regime fields, comparing nested values by content', () => {
    const draft = structuredClone(baseline)
    draft.dryRun = false
    draft.regime.baseSizeUsdc = 0
    draft.regime.ladder = [1, 3]
    assert.deepEqual(buildSavePayload(draft, baseline), { dryRun: false, regime: { baseSizeUsdc: 0, ladder: [1, 3] } })
  })

  it('sends keys new to the draft and never sends depth controls', () => {
    const draft = structuredClone(baseline)
    draft.regime.tpMult = 2
    draft.regime.minDepthUsdc = 99
    draft.regime.depthPauseMs = 5
    assert.deepEqual(buildSavePayload(draft, baseline), { regime: { tpMult: 2 } })
  })
})
