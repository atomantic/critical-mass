// @ts-check
// The restore preflight applies the accounting readers' own refusal rules
// (issue #1811); this pins the shared pure validator.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  LEDGER_FORMAT_VERSION,
  classifyPayloadPath,
  findIncompatiblePayloadReason,
  validatePersistedPayload,
} = require('../src/persisted-payload-validation');

const row = (overrides = {}) => ({ tradeId: 't1', side: 'buy', size: 1, price: 10, quoteAmount: 10, netFee: 0, timestamp: 1, ...overrides });

describe('classifyPayloadPath', () => {
  it('recognizes fund-level and root accounting files only', () => {
    assert.equal(classifyPayloadPath('coinbase/BTC-USDC/fill-ledger.json'), 'ledger');
    assert.equal(classifyPayloadPath('coinbase/fill-ledger.json'), 'ledger');
    assert.equal(classifyPayloadPath('coinbase/BTC-USDC/state.json'), 'fund-state');
    assert.equal(classifyPayloadPath('coinbase/BTC-USDC/regime-state.json'), 'fund-state');
    assert.equal(classifyPayloadPath('updown-state.json'), 'updown-state');
    assert.equal(classifyPayloadPath('backups/fund-state/x/coinbase/BTC-USDC/fill-ledger.json'), null);
    assert.equal(classifyPayloadPath('backups/fill-ledger.json'), null);
    assert.equal(classifyPayloadPath('updown/scorecard/state.json'), null);
    assert.equal(classifyPayloadPath('coinbase/BTC-USDC/closed-trades.json'), null);
  });
});

describe('findIncompatiblePayloadReason', () => {
  it('accepts unversioned, fee-only and current-format ledgers', () => {
    assert.equal(findIncompatiblePayloadReason('ledger', []), null);
    assert.equal(findIncompatiblePayloadReason('ledger', [row()]), null);
    const { netFee, ...legacy } = row();
    assert.equal(findIncompatiblePayloadReason('ledger', [{ ...legacy, fee: 0.1 }]), null);
    assert.equal(findIncompatiblePayloadReason('ledger', [row({ formatVersion: LEDGER_FORMAT_VERSION })]), null);
  });

  it('refuses non-arrays, newer formats and malformed rows', () => {
    assert.match(String(findIncompatiblePayloadReason('ledger', { fills: [] })), /not an array/);
    assert.match(String(findIncompatiblePayloadReason('ledger', null)), /got null/);
    assert.match(String(findIncompatiblePayloadReason('ledger', [row({ formatVersion: LEDGER_FORMAT_VERSION + 1 })])), /newer build/);
    assert.match(String(findIncompatiblePayloadReason('ledger', [row(), row()])), /duplicate tradeId/);
    assert.match(String(findIncompatiblePayloadReason('ledger', [null])), /non-object entry/);
  });

  it('requires state files to be objects and gates the UpDown format', () => {
    assert.equal(findIncompatiblePayloadReason('fund-state', { anything: 1 }), null);
    assert.match(String(findIncompatiblePayloadReason('fund-state', [])), /object/);
    assert.match(String(findIncompatiblePayloadReason('fund-state', null)), /object/);
    assert.equal(findIncompatiblePayloadReason('updown-state', { contract: {} }), null);
    assert.match(String(findIncompatiblePayloadReason('updown-state', { formatVersion: 99 })), /newer build/);
  });
});

describe('validatePersistedPayload', () => {
  it('parses text, names the file and ignores unclassified paths', () => {
    assert.deepEqual(validatePersistedPayload('coinbase/BTC-USDC/fill-ledger.json', '[]'), { ok: true });
    assert.deepEqual(validatePersistedPayload('coinbase/BTC-USDC/closed-trades.json', 'not json'), { ok: true });
    const bad = /** @type {{ok: false, error: string}} */ (validatePersistedPayload('coinbase/BTC-USDC/fill-ledger.json', '{nope'));
    assert.equal(bad.ok, false);
    assert.match(bad.error, /^coinbase\/BTC-USDC\/fill-ledger.json is corrupted or unreadable/);
    assert.equal(validatePersistedPayload('coinbase/BTC-USDC/fill-ledger.json', Buffer.from('{}')).ok, false);
  });
});
