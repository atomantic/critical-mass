// @ts-check
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { buildRuntimeHealth, interpretFundReply } = require('../src/runtime-health');

const envelope = (mode, extra = {}, running = true) => ({
  success: true, exchange: 'coinbase', pair: 'BTC-USDC', running,
  status: { isRunning: running, health: { mode, reason: extra.reason ?? null }, uptime: 12 },
});

const makeIPC = (handler, connected = true) => {
  const calls = [];
  return {
    calls,
    isConnected: () => connected,
    request: async (...args) => { calls.push(args); return handler(...args); },
  };
};

const run = (ipcs, { funds, enabled, updown, sentinel } = {}) => {
  const all = funds || [{ exchange: 'coinbase', pair: 'BTC-USDC' }];
  return buildRuntimeHealth({
    exchangeIPCMap: ipcs,
    getConfiguredFunds: () => all,
    getEnabledFunds: () => enabled || all,
    getUpDownStatus: () => updown || { running: true, priceFresh: true, priceAgeMs: 100, lastPrice: 1 },
    getSentinelStatus: () => sentinel || { running: true, feedState: 'healthy' },
    timeoutMs: 50,
  });
};

describe('interpretFundReply', () => {
  it('maps production envelopes', () => {
    assert.equal(interpretFundReply(envelope('ACTIVE')).status, 'ok');
    assert.equal(interpretFundReply(envelope('SAFE', { reason: 'ws' })).status, 'safe');
    assert.equal(interpretFundReply(envelope('SAFE', { reason: 'ws' })).reason, 'ws');
    assert.equal(interpretFundReply(envelope('AUTH_DENIED')).status, 'auth_denied');
    assert.equal(interpretFundReply(envelope('PAUSED')).status, 'paused');
    const stopped = interpretFundReply(envelope('STOPPED', {}, false));
    assert.equal(stopped.status, 'stopped');
    assert.equal(stopped.isRunning, false);
    assert.equal(interpretFundReply(envelope('ACTIVE')).isRunning, true);
  });
  it('flags failure, missing status and malformed replies', () => {
    assert.equal(interpretFundReply({ success: false, status: null, error: 'bad state' }).status, 'error');
    assert.equal(interpretFundReply({ success: false, status: null, error: 'bad state' }).reason, 'bad state');
    assert.equal(interpretFundReply({ success: true, running: true }).status, 'error');
    assert.equal(interpretFundReply(null).status, 'error');
    assert.equal(interpretFundReply('x').status, 'error');
    assert.equal(interpretFundReply({ success: true, status: { health: {} } }).status, 'error');
    assert.equal(interpretFundReply({ success: true, status: { health: { mode: 'WAT' } } }).status, 'error');
  });
});

describe('buildRuntimeHealth', () => {
  it('probes each fund with an explicit pair and timeout', async () => {
    const ipc = makeIPC(() => envelope('ACTIVE'));
    const funds = [{ exchange: 'coinbase', pair: 'BTC-USDC' }, { exchange: 'coinbase', pair: 'ETH-USDC' }];
    const h = await run({ coinbase: ipc }, { funds });
    assert.deepEqual(ipc.calls.map((c) => [c[0], c[2], c[3], c[4]]),
      [['regime:status', 'coinbase', 'BTC-USDC', 50], ['regime:status', 'coinbase', 'ETH-USDC', 50]]);
    assert.equal(h.status, 'ok');
    assert.equal(h.engines.coinbase.status, 'ok');
    assert.equal(h.engines.coinbase.isRunning, true);
    assert.equal(h.funds.coinbase['ETH-USDC'].mode, 'ACTIVE');
  });

  for (const [mode, expected] of [['SAFE', 'safe'], ['AUTH_DENIED', 'auth_denied']]) {
    it(`${mode} degrades overall health and exposes mode`, async () => {
      const h = await run({ coinbase: makeIPC(() => envelope(mode, { reason: 'why' })) });
      assert.equal(h.status, 'degraded');
      assert.equal(h.engines.coinbase.status, expected);
      assert.equal(h.engines.coinbase.mode, mode);
      assert.equal(h.engines.coinbase.reason, 'why');
      assert.equal(h.funds.coinbase['BTC-USDC'].exchange, 'coinbase');
    });
  }

  it('failing non-default fund degrades its exchange and overall', async () => {
    const ipc = makeIPC((_c, _p, _e, pair) => (pair === 'ETH-USDC' ? envelope('SAFE') : envelope('ACTIVE')));
    const funds = [{ exchange: 'coinbase', pair: 'BTC-USDC' }, { exchange: 'coinbase', pair: 'ETH-USDC' }];
    const h = await run({ coinbase: ipc }, { funds });
    assert.equal(h.status, 'degraded');
    assert.equal(h.engines.coinbase.status, 'safe');
    assert.equal(h.funds.coinbase['BTC-USDC'].status, 'ok');
    assert.equal(h.funds.coinbase['ETH-USDC'].status, 'safe');
  });

  it('success:false, malformed, rejection and timeout all degrade', async () => {
    const cases = [
      [() => ({ success: false, status: null, error: 'unreadable' }), 'error'],
      [() => ({ success: true }), 'error'],
      [() => 'junk', 'error'],
      [() => { throw new Error('boom'); }, 'error'],
      [() => { throw new Error('IPC request timeout: regime:status (coinbase)'); }, 'timeout'],
    ];
    for (const [handler, status] of cases) {
      const h = await run({ coinbase: makeIPC(handler) });
      assert.equal(h.engines.coinbase.status, status);
      assert.equal(h.status, 'degraded');
    }
  });

  it('intentional pause/stop is visible but not an outage', async () => {
    let h = await run({ coinbase: makeIPC(() => envelope('PAUSED')) });
    assert.equal(h.status, 'ok');
    assert.equal(h.engines.coinbase.status, 'paused');
    h = await run({ coinbase: makeIPC(() => envelope('STOPPED', {}, false)) });
    assert.equal(h.status, 'ok');
    assert.equal(h.engines.coinbase.status, 'stopped');
    assert.equal(h.engines.coinbase.isRunning, false);
  });

  it('unconfigured exchange and disabled-fund failures are not outages', async () => {
    const gemini = makeIPC(() => { throw new Error('should not probe'); }, false);
    const h = await run({ coinbase: makeIPC(() => envelope('ACTIVE')), gemini });
    assert.equal(h.status, 'ok');
    assert.equal(h.engines.gemini.status, 'unconfigured');
    assert.equal(gemini.calls.length, 0);

    const funds = [{ exchange: 'coinbase', pair: 'BTC-USDC' }, { exchange: 'gemini', pair: 'BTC-USD' }];
    const h2 = await run({ coinbase: makeIPC(() => envelope('ACTIVE')), gemini: makeIPC(() => {}, false) },
      { funds, enabled: [funds[0]] });
    assert.equal(h2.status, 'ok');
    assert.equal(h2.engines.gemini.status, 'unreachable');
    assert.equal(h2.engines.gemini.required, false);
  });

  it('unreachable enabled engine degrades; all down is critical', async () => {
    const h = await run({ coinbase: makeIPC(() => {}, false) }, { updown: { running: false }, sentinel: { running: false } });
    assert.equal(h.engines.coinbase.status, 'unreachable');
    assert.equal(h.status, 'critical');
    const h2 = await run({ coinbase: makeIPC(() => {}, false) });
    assert.equal(h2.status, 'degraded');
  });

  it('stale UpDown prices degrade and recover', async () => {
    const ipc = makeIPC(() => envelope('ACTIVE'));
    let h = await run({ coinbase: ipc }, { updown: { running: true, priceFresh: false, priceAgeMs: 90000, lastPrice: null } });
    assert.equal(h.status, 'degraded');
    assert.equal(h.engines.updown.status, 'degraded');
    assert.equal(h.engines.updown.priceAgeMs, 90000);
    h = await run({ coinbase: ipc }, { updown: { running: true, priceFresh: true, priceAgeMs: 10, lastPrice: 5 } });
    assert.equal(h.status, 'ok');
    assert.equal(h.engines.updown.status, 'ok');
    h = await run({ coinbase: ipc }, { updown: { running: false, priceFresh: false } });
    assert.equal(h.engines.updown.status, 'stopped');
    assert.equal(h.status, 'ok');
  });
});
