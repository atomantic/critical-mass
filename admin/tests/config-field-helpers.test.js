// @vitest-environment node
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import { fieldValue } from '../src/utils/regimeFieldValue.mjs'
import { buildSavePayload } from '../src/utils/configSavePayload.mjs'

// Moved from tests/config-editor-write-gate.test.js (#868, #1983).
const { REGIME_DEFAULTS } = createRequire(import.meta.url)('../../src/config-utils')

describe('regime field helpers', () => {
  it('fieldValue shows a saved 0 or false as saved and an absent field as the server default', () => {
    const defaults = { harvestScale: 1, trendScale: 0.5, celestialEnabled: true, kFactor: 0.65 }
    expect(fieldValue({ harvestScale: 0 }, defaults, 'harvestScale')).toBe(0)
    expect(fieldValue({ celestialEnabled: false }, defaults, 'celestialEnabled')).toBe(false)
    expect(fieldValue({}, defaults, 'kFactor')).toBe(0.65)
    expect(fieldValue(undefined, defaults, 'trendScale')).toBe(0.5)
    expect(fieldValue({ kFactor: null }, defaults, 'kFactor')).toBe(0.65)
    expect(fieldValue({}, undefined, 'kFactor')).toBeUndefined()
  })

  it('an untouched form diffs to an empty save payload, with defaults shown for absent fields', () => {
    const baseline = { productId: 'BTC-USDC', dryRun: true, regime: { baseSizeUsdc: 0, harvestScale: 0 } }
    const draft = structuredClone(baseline)
    expect(buildSavePayload(draft, baseline)).toEqual({})
    expect(fieldValue(draft.regime, REGIME_DEFAULTS, 'harvestScale')).toBe(0)
    expect(fieldValue(draft.regime, REGIME_DEFAULTS, 'kFactor')).toBe(REGIME_DEFAULTS.kFactor)
  })
})
