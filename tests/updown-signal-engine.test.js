// @ts-check
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { resolveNoTradeZoneType } = require('../src/updown/signal-engine');

// issue #108 — NO_TRADE_ZONE must suppress entries near expiry but still
// surface an EXIT signal for a held position so the operator can avoid riding
// a losing position to settlement.
describe('resolveNoTradeZoneType (issue #108)', () => {
  it('passes the raw signal through when not in the no-trade zone', () => {
    assert.equal(resolveNoTradeZoneType('STRONG_BUY', false, null), 'STRONG_BUY');
    assert.equal(resolveNoTradeZoneType('SELL', false, { direction: 'up' }), 'SELL');
  });

  it('masks entry signals as NO_TRADE_ZONE when no position is held', () => {
    assert.equal(resolveNoTradeZoneType('STRONG_BUY', true, null), 'NO_TRADE_ZONE');
    assert.equal(resolveNoTradeZoneType('SELL', true, null), 'NO_TRADE_ZONE');
    assert.equal(resolveNoTradeZoneType('NEUTRAL', true, null), 'NO_TRADE_ZONE');
  });

  it('surfaces a SELL/STRONG_SELL exit for a held UP position in the zone', () => {
    assert.equal(resolveNoTradeZoneType('SELL', true, { direction: 'up' }), 'SELL');
    assert.equal(resolveNoTradeZoneType('STRONG_SELL', true, { direction: 'up' }), 'STRONG_SELL');
  });

  it('surfaces a BUY/STRONG_BUY exit for a held DOWN position in the zone', () => {
    assert.equal(resolveNoTradeZoneType('BUY', true, { direction: 'down' }), 'BUY');
    assert.equal(resolveNoTradeZoneType('STRONG_BUY', true, { direction: 'down' }), 'STRONG_BUY');
  });

  it('still masks a signal that points WITH the held position (would be an entry, not an exit)', () => {
    // Holding UP and seeing BUY is not an exit — stay masked.
    assert.equal(resolveNoTradeZoneType('STRONG_BUY', true, { direction: 'up' }), 'NO_TRADE_ZONE');
    // Holding DOWN and seeing SELL is not an exit — stay masked.
    assert.equal(resolveNoTradeZoneType('STRONG_SELL', true, { direction: 'down' }), 'NO_TRADE_ZONE');
  });
});
