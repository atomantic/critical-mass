// Issue #863: a rejected stopped-fund TP lookup must be unavailable, not empty.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { lookupStoppedFundTpOrder } = require('../src/stopped-fund-tp-lookup');

const position = { activeTpOrderId: 'tp1', lastTpPrice: 100, assetOnOrder: 0.5 };
const mkLogger = () => { const calls = []; return { calls, error: (m, d) => calls.push({ m, d }) }; };
const run = (getOrder, logger = mkLogger()) =>
  lookupStoppedFundTpOrder({ adapter: { getOrder }, position, exchange: 'coinbase', pair: 'BTC-USD', logger });

describe('lookupStoppedFundTpOrder', () => {
  it('rejection returns unavailable and logs context', async () => {
    const logger = mkLogger();
    const err = Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' });
    const r = await run(async () => { throw err; }, logger);
    assert.equal(r.ok, false);
    assert.match(r.error, /unavailable/);
    assert.equal(logger.calls.length, 1);
    assert.equal(logger.calls[0].d.orderId, 'tp1');
    assert.equal(logger.calls[0].d.errorCode, 'ETIMEDOUT');
    assert.ok(logger.calls[0].d.stack);
  });
  it('OPEN result yields the TP order', async () => {
    const r = await run(async () => ({ status: 'OPEN' }));
    assert.equal(r.ok, true);
    assert.equal(r.order.orderId, 'tp1');
    assert.equal(r.order.size, 0.5);
  });
  it('terminal result is a genuine empty', async () => {
    const r = await run(async () => ({ status: 'FILLED' }));
    assert.deepEqual(r, { ok: true, order: null });
  });
  it('recovers after a prior failure', async () => {
    let n = 0;
    const g = async () => { if (n++ === 0) throw new Error('x'); return { status: 'OPEN' }; };
    assert.equal((await run(g)).ok, false);
    assert.equal((await run(g)).ok, true);
  });
});
