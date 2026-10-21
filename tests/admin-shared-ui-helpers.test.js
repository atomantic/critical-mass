const { describe, it, before } = require('node:test')
const assert = require('node:assert/strict')

let formatCountdown, TF_ORDER

before(async () => {
  ;({ formatCountdown } = await import('../admin/src/utils/countdown.mjs'))
  ;({ TF_ORDER } = await import('../admin/src/utils/timeframes.mjs'))
})

describe('formatCountdown', () => {
  it('compact style spans days, hours, minutes and seconds', () => {
    assert.equal(formatCountdown(0), 'now')
    assert.equal(formatCountdown(-5), 'now')
    assert.equal(formatCountdown(NaN), 'now')
    assert.equal(formatCountdown(5000), '5s')
    assert.equal(formatCountdown(65000), '1m 5s')
    assert.equal(formatCountdown(3725000), '1h 2m 5s')
    assert.equal(formatCountdown(((26 * 60) + 4) * 60000), '1d 2h 4m')
  })

  it('clock style is zero-padded HH:MM:SS', () => {
    assert.equal(formatCountdown(0, 'clock'), '00:00:00')
    assert.equal(formatCountdown(3725000, 'clock'), '01:02:05')
  })

  it('minutes style is M:SS', () => {
    assert.equal(formatCountdown(undefined, 'minutes'), '0:00')
    assert.equal(formatCountdown(65000, 'minutes'), '1:05')
    assert.equal(formatCountdown(3725000, 'minutes'), '62:05')
  })
})

describe('TF_ORDER', () => {
  it('lists every timeframe longest first', () => {
    assert.deepEqual(TF_ORDER, ['1w', '1d', '4h', '2h', '1h', '30m', '15m', '10m', '5m', '3m', '1m'])
  })
})
