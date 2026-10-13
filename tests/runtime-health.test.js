// @ts-check
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { buildRuntimeHealth, interpretFundReply } = require('../src/runtime-health');
const { createFundStartSupervisor } = require('../src/fund-start-supervisor');

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
  it('keeps startup diagnostics when the engine reports a state-read failure', () => {
    const startup = { state: 'blocked', error: 'Repair state', nextRetryAt: null };
    const result = interpretFundReply({ success: false, status: null, error: 'Unreadable state', startup });
    assert.equal(result.status, 'error');
    assert.equal(result.reason, 'Unreadable state');
    assert.deepEqual(result.startup, startup);
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
    h = await run({ coinbase: makeIPC(() => ({ ...envelope('STOPPED', {}, false),
      startup: { state: 'stopped', error: null, nextRetryAt: null } })) });
    assert.equal(h.status, 'ok', 'a supervised intentional stop is still healthy');
  });

  it('reports unfinished startup even when an engine object exposes ACTIVE health', async () => {
    const reply = { ...envelope('ACTIVE', {}, false), startup: { state: 'starting', error: null, nextRetryAt: null } };
    const h = await run({ coinbase: makeIPC(() => reply) });
    assert.equal(h.status, 'degraded');
    assert.equal(h.engines.coinbase.status, 'error');
    assert.equal(h.engines.coinbase.isRunning, false);
    assert.match(h.engines.coinbase.reason, /starting/);
    assert.deepEqual(h.funds.coinbase['BTC-USDC'].startup, reply.startup);
  });

  for (const retryable of [true, false]) {
    it(`surfaces real supervisor ${retryable ? 'retrying' : 'blocked'} state and recovers`, async () => {
      const exchange = 'coinbase';
      const pair = 'ETH-USDC';
      const key = `${exchange}/${pair}`;
      const engines = new Map();
      let succeed = false;
      let retry;
      const supervisor = createFundStartSupervisor({
        startAttempt: async () => {
          if (!succeed) return { success: false, error: 'Dependency unavailable', retryable, needsOperator: !retryable };
          engines.set(key, {});
          return { success: true };
        },
        fundKey: (e, p) => `${e}/${p}`, resolvePair: (_e, p) => p,
        regimeEngines: engines, saveRegimeRunningFlag: () => {},
        logger: () => ({ error() {} }), isPaused: () => false,
        setTimer: (callback) => { retry = callback; return { unref() {} }; }, clearTimer: () => {},
      });
      await supervisor.autoResumeFund(exchange, pair);
      // Same envelope as the engine's regime:status handler: no engine
      // synthesizes STOPPED, while startup supervision travels separately.
      const ipc = makeIPC((_c, _p, _e, requestedPair) => requestedPair === pair ? {
        ...envelope(engines.has(key) ? 'ACTIVE' : 'STOPPED', {}, engines.has(key)),
        startup: supervisor.getStatus(exchange, pair),
      } : envelope('ACTIVE'));
      const funds = [{ exchange, pair: 'BTC-USDC' }, { exchange, pair }];
      let h = await run({ coinbase: ipc }, { funds });
      const failed = h.funds[exchange][pair];
      assert.equal(h.status, 'degraded');
      assert.equal(h.engines[exchange].status, 'error');
      assert.equal(failed.status, 'error');
      assert.equal(failed.isRunning, false);
      assert.match(failed.reason, /Dependency unavailable/);
      assert.equal(failed.startup.state, retryable ? 'retrying' : 'blocked');
      assert.equal(h.engines[exchange].startup.state, failed.startup.state);
      if (retryable) assert.ok(failed.startup.nextRetryAt > Date.now());
      else assert.equal(failed.startup.nextRetryAt, null);

      const down = await run({ coinbase: ipc }, { funds: [funds[1]], updown: { running: false }, sentinel: { running: false } });
      assert.equal(down.status, 'critical', 'no ready service remains');

      h = await run({ coinbase: ipc }, { funds, enabled: [funds[0]] });
      assert.equal(h.status, 'ok', 'disabled fund cannot degrade enabled funds');
      assert.equal(h.funds[exchange][pair].status, 'error', 'disabled failure remains visible');

      succeed = true;
      if (retryable) { retry(); await supervisor.settle(); }
      else await supervisor.startFund({}, exchange, pair);
      h = await run({ coinbase: ipc }, { funds });
      assert.equal(h.status, 'ok');
      assert.equal(h.funds[exchange][pair].status, 'ok');
      assert.equal(h.funds[exchange][pair].startup.state, 'running');
      assert.equal(h.funds[exchange][pair].startup.error, null);
    });
  }

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
