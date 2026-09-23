// @ts-check
// Regression coverage for issue #682: Crypto.com EXPIRED orders must
// normalize to a terminal status, not fall through to UNKNOWN.
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createCryptocomAdapter } = require('../src/adapters/cryptocom/api');
const { isTerminalStatus, isCancelledStatus } = require('../src/shared-utils');

let keysPath;
let originalFetch;

beforeEach(() => {
  keysPath = path.join(os.tmpdir(), `cryptocom-status-keys-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(keysPath, JSON.stringify({ apiKey: 'test-api-key-123', apiSecret: 'test-api-secret-456' }));
  originalFetch = global.fetch;
});

afterEach(() => {
  global.fetch = originalFetch;
  fs.rmSync(keysPath, { force: true });
});

const stubGetOrderDetail = (orderPayload) => {
  global.fetch = async () => ({
    ok: true,
    text: async () => JSON.stringify({
      code: 0,
      result: { order_info: orderPayload },
    }),
  });
};

describe('Crypto.com order status normalization (issue #682)', () => {
  it('getOrder normalizes an EXPIRED order to a terminal, cancelled status', async () => {
    const adapter = createCryptocomAdapter(keysPath);
    stubGetOrderDetail({
      order_id: '12345678901234567',
      status: 'EXPIRED',
      quantity: '1000',
      cumulative_quantity: '400',
    });

    const order = await adapter.getOrder('12345678901234567');

    assert.equal(order.status, 'EXPIRED');
    assert.equal(order.filledSize, 400);
    assert.equal(isTerminalStatus(order), true);
    assert.equal(isCancelledStatus(order), true);
  });

  it('findOrderByClientOrderId normalizes an EXPIRED order the same way', async () => {
    const adapter = createCryptocomAdapter(keysPath);
    stubGetOrderDetail({
      order_id: '12345678901234567',
      status: 'EXPIRED',
      quantity: '1000',
      cumulative_quantity: '400',
    });

    const order = await adapter.findOrderByClientOrderId('some-client-oid');

    assert.equal(order.status, 'EXPIRED');
    assert.equal(isTerminalStatus(order), true);
    assert.equal(isCancelledStatus(order), true);
  });

  it('still reports a genuinely unrecognised status as UNKNOWN (non-terminal)', async () => {
    const adapter = createCryptocomAdapter(keysPath);
    stubGetOrderDetail({
      order_id: '12345678901234567',
      status: 'SOME_FUTURE_STATUS',
      quantity: '1000',
      cumulative_quantity: '0',
    });

    const order = await adapter.getOrder('12345678901234567');

    assert.equal(order.status, 'UNKNOWN');
    assert.equal(isTerminalStatus(order), false);
    assert.equal(isCancelledStatus(order), false);
  });
});
