// @ts-check
// Characterize public startup ordering and retention before extracting its steps (#1006).
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');

const { createIsolatedDataDir } = require('./test-data-dir');
const isolatedData = createIsolatedDataDir('cm-startup-recovery-steps-test');

// The size optimizer persists per-pair into the SHARED data/config.json, so a
// throwaway pair would register itself as a real fund. Neutralize BEFORE
// regime-engine is required — it destructures updateRegimeConfig at load.
const configUtils = require('../src/config-utils');
const originalUpdateRegimeConfig = configUtils.updateRegimeConfig;
configUtils.updateRegimeConfig = () => {};

// regime-engine's connectWebSocket() calls a REAL createWebSocketFeed(...) —
// stub it BEFORE requiring regime-engine (which destructures it at load) so
// start() never attempts a real network connection.
const websocketFeedModule = require('../src/websocket-feed');
const originalCreateWebSocketFeed = websocketFeedModule.createWebSocketFeed;
websocketFeedModule.createWebSocketFeed = () => ({ connect: () => {}, disconnect: () => {} });

const { createRegimeEngine } = require('../src/regime-engine');

const engines = [];
after(async () => {
  // start() schedules production setInterval timers (state save, metrics,
  // reconcile) that _test.clearTimers() does not touch (it only clears the
  // ttlTimers dedup set) — only stop() clears those, in its finally block.
  // Without this the process never goes idle and the run hangs.
  for (const eng of engines) {
    await eng.stop().catch(() => {});
    eng._test.clearTimers();
  }
  configUtils.updateRegimeConfig = originalUpdateRegimeConfig;
  websocketFeedModule.createWebSocketFeed = originalCreateWebSocketFeed;
  isolatedData.cleanup();
});

/**
 * Minimal adapter covering everything a clean (no position, no open orders)
 * engine start() touches, plus the per-test overrides that drive the
 * terminal-saved-entry catch-up path under test.
 * @param {Object} over
 * @returns {Object}
 */
const makeAdapter = (over = {}) => ({
  getProductDetails: async () => ({ baseMinSize: '0.0001', baseIncrement: '0.00000001', quoteIncrement: '0.01' }),
  getCurrentPrice: async () => 2000,
  getOpenOrders: async () => [],
  getAccountBalance: async () => ({ available: 0, hold: 0 }),
  getOrder: async () => ({ status: 'OPEN', filledSize: 0 }),
  getOrderFills: async () => [],
  loadCredentials: () => ({ apiKey: 'test', apiSecret: 'test' }),
  ...over,
});

const makeEngine = (pair, adapter, executor = {}) => {
  const eng = createRegimeEngine('coinbase', pair, { dryRun: false, productId: pair }, {});
  eng._test.setAdapter(makeAdapter(adapter));
  eng._test.setOrderExecutor({
    setPriceIncrement: () => {},
    getPendingCounts: () => ({ total: 0 }),
    getOrderPlacedAt: () => null,
    isLadderOrder: () => false,
    restorePendingOrder: () => {},
    markSettled: () => {},
    checkPendingOrderFills: async () => ({ polled: 0, filled: 0, cancelled: 0 }),
    handleOrderFill: () => {},
    cancelBodyTpOrder: async () => ({ cancelled: true }),
    placeBodyTpOrder: async () => ({ success: true, orderId: 'tp-1' }),
    removeBodyTracking: () => {},
    exportState: () => ({}),
    cancelAllEntries: async () => {},
    cancelAllLadderOrders: async () => {},
    cancelTpOrder: async () => ({ cancelled: true }),
    handleOrderCancel: () => {},
    ...executor,
  });
  // No prior saved state — recovery starts from a clean slate; the target
  // saved entry is injected onto positionState directly below.
  eng._test.setRecoveryModule({
    recoverState: async () => ({
      position: { totalAsset: 0, totalCostBasis: 0, avgCostBasis: 0, cycleBuys: 0, lastEntryPrice: 0, lastEntryTime: 0 },
      openOrders: new Map(),
      discrepancies: [],
    }),
  });
  engines.push(eng);
  return eng;
};

const fs = require('node:fs');
const path = require('node:path');
const { tradeEvents } = require('../src/trade-events');
const savedRow = (orderId, extra = {}) => ({
  orderId, price: 2000, assetQty: 0.01, sizeUsdc: 20, placedAt: Date.now() - 60000, ...extra,
});
const openRow = (orderId, filledSize = 0) => ({
  ...savedRow(orderId), side: 'BUY', status: 'OPEN', size: 0.01 - filledSize,
  originalSize: 0.01, filledSize, filledValue: filledSize * 2000, averageFilledPrice: 2000,
});
const persistedPosition = (pair) => JSON.parse(fs.readFileSync(
  path.join(isolatedData.fundDir('coinbase', pair), 'regime-state.json'), 'utf8',
)).position;

describe('startup recovery step boundaries (#1006)', () => {
  it('restores and books a mixed snapshot sequentially before restoring its ladder', async () => {
    const pair = '__startup_steps_mixed__';
    const calls = [];
    const openOrders = [openRow('saved', 0.004), openRow('corrective'), openRow('manual'),
      openRow('ladder'), openRow('partial-orphan', 0.003), openRow('clean-orphan')];
    const eng = makeEngine(pair, {
      getOpenOrders: async () => { calls.push('open'); return openOrders; },
      getOrderFills: async (id) => {
        calls.push(`fills:${id}`);
        return [{ tradeId: `${id}-fill`, orderId: id, side: 'buy',
          size: id === 'saved' ? 0.004 : 0.003, price: 2000, netFee: 0,
          tradeTime: new Date().toISOString() }];
      },
      cancelOrder: async (id) => { calls.push(`cancel:${id}`); return { success: true }; },
    }, {
      restorePendingOrder: (id, opts) => calls.push(`restore:${opts.type}:${id}`),
      handleOrderFill: (id) => calls.push(`book:${id}`),
    });
    const dir = isolatedData.fundDir('coinbase', pair);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'pending-corrective-buys.json'), JSON.stringify([
      { buyOrderId: 'corrective' }, { buyOrderId: 'clean-orphan', filled: true },
    ]));
    fs.writeFileSync(path.join(dir, 'manual-trades.json'), JSON.stringify({ trades: [
      { buyOrderId: 'manual', status: 'buy_pending' },
      { buyOrderId: 'clean-orphan', status: 'completed' },
    ] }));
    const pos = eng._getPositionState();
    pos.pendingEntryOrders = [savedRow('saved')];
    pos.pendingLadderOrders = [savedRow('ladder', { ladderIndex: 0 })];
    pos.ladderActive = true;
    const onTrade = event => {
      if (event.type === 'buy_filled') calls.push(`book:${event.data.assetAmount}`);
    };
    tradeEvents.on('trade', onTrade);
    try {
      assert.equal((await eng.start()).success, true);
    } finally {
      tradeEvents.off('trade', onTrade);
    }
    assert.deepEqual(calls, ['open', 'open', 'restore:entry:saved', 'fills:saved', 'book:0.004',
      'restore:entry:partial-orphan', 'fills:partial-orphan', 'book:0.003',
      'cancel:clean-orphan', 'restore:ladder_entry:ladder']);
    const live = eng._getPositionState();
    assert.deepEqual(live.pendingEntryOrders.map(e => e.orderId), ['saved', 'partial-orphan']);
    for (const position of [live, persistedPosition(pair)]) {
      const pending = position.pendingEntryOrders;
      assert.ok(Math.abs(pending[0].assetQty - 0.006) < 1e-9);
      assert.equal(pending[0].sizeUsdc, 12);
      assert.ok(Math.abs(pending[1].assetQty - 0.007) < 1e-9);
      assert.equal(pending[1].sizeUsdc, 14);
      assert.deepEqual(position.pendingLadderOrders.map(o => o.orderId), ['ladder']);
      const bookedIds = position.celestialBodies.flatMap(b => b.sourceOrderIds);
      assert.deepEqual([...new Set(bookedIds)].sort(), ['partial-orphan', 'saved']);
    }
  });

  for (const invalidFile of [null, 'pending-corrective-buys.json', 'manual-trades.json']) {
    it(`continues independent exclusion reads when ${invalidFile || 'both files are missing'}`, async () => {
      const pair = `__startup_steps_files_${invalidFile || 'missing'}__`;
      const cancelled = [];
      const eng = makeEngine(pair, {
        getOpenOrders: async () => [openRow('corrective'), openRow('manual')],
        cancelOrder: async id => { cancelled.push(id); return { success: true }; },
      });
      const dir = isolatedData.fundDir('coinbase', pair);
      fs.mkdirSync(dir, { recursive: true });
      if (invalidFile) {
        fs.writeFileSync(path.join(dir, 'pending-corrective-buys.json'),
          invalidFile === 'pending-corrective-buys.json' ? '{broken' : '[{"buyOrderId":"corrective"}]');
        fs.writeFileSync(path.join(dir, 'manual-trades.json'),
          invalidFile === 'manual-trades.json' ? '{broken' : '{"trades":[{"buyOrderId":"manual","status":"buy_pending"}]}');
      }
      assert.equal((await eng.start()).success, true);
      assert.deepEqual(cancelled, invalidFile === 'pending-corrective-buys.json' ? ['corrective']
        : invalidFile === 'manual-trades.json' ? ['manual'] : ['corrective', 'manual']);
    });
  }

  it('prefetches saved status concurrently and preserves entry-versus-ladder unknown retention', async () => {
    const pair = '__startup_steps_unknown__';
    const reads = [];
    const waits = [];
    const eng = makeEngine(pair, {
      getOrder: id => {
        reads.push(id);
        return new Promise((resolve, reject) => {
          const release = () => {
            if (id.endsWith('reject')) reject(new Error('lookup unavailable'));
            else resolve(id.endsWith('null') ? null : { status: 'OPEN', filledSize: 0 });
          };
          // Bound a failed characterization too: sequential or missing status
          // reads must fail the assertion without stranding start()/cleanup.
          const timeout = setTimeout(release, 1000);
          waits.push(() => { clearTimeout(timeout); release(); });
        });
      },
    });
    const pos = eng._getPositionState();
    pos.pendingEntryOrders = ['entry-reject', 'entry-null', 'entry-open'].map(id => savedRow(id));
    pos.pendingLadderOrders = ['ladder-reject', 'ladder-null', 'ladder-open'].map((id, i) => savedRow(id, { ladderIndex: i }));
    pos.ladderActive = true;
    const started = eng.start();
    // Drain each concurrent batch only after all three lookups were initiated.
    for (const expected of [['entry-reject', 'entry-null', 'entry-open'], ['ladder-reject', 'ladder-null', 'ladder-open']]) {
      for (let tick = 0; waits.length < 3 && tick < 100; tick++) {
        await new Promise(resolve => setImmediate(resolve));
      }
      assert.equal(waits.length, 3, 'all status reads start before any booking continues');
      assert.deepEqual(reads.slice(-3), expected);
      waits.splice(0).forEach(release => release());
    }
    assert.equal((await started).success, true);
    for (const position of [eng._getPositionState(), persistedPosition(pair)]) {
      assert.deepEqual(position.pendingEntryOrders, []);
      assert.deepEqual(position.pendingLadderOrders.map(o => o.orderId), ['ladder-reject', 'ladder-null', 'ladder-open']);
      assert.equal(position.ladderActive, true);
    }
  });

  it('subtracts only a committed open-entry tranche after booking throws', async () => {
    const pair = '__startup_steps_postcommit__';
    const eng = makeEngine(pair, {
      getOpenOrders: async () => [openRow('saved', 0.004)],
      getOrderFills: async () => [{ tradeId: 'saved-fill', orderId: 'saved', side: 'buy',
        size: 0.004, price: 2000, netFee: 0, tradeTime: new Date().toISOString() }],
    });
    eng._getPositionState().pendingEntryOrders = [savedRow('saved')];
    let threwAfterCommit = false;
    const onTrade = event => {
      if (event.type !== 'buy_filled') return;
      threwAfterCommit = true;
      throw new Error('trade notification failed after commitment');
    };
    tradeEvents.on('trade', onTrade);
    try {
      assert.equal((await eng.start()).success, true);
    } finally {
      tradeEvents.off('trade', onTrade);
    }
    assert.equal(threwAfterCommit, true);
    for (const position of [eng._getPositionState(), persistedPosition(pair)]) {
      assert.ok(Math.abs(position.pendingEntryOrders[0].assetQty - 0.006) < 1e-9);
      assert.equal(position.pendingEntryOrders[0].sizeUsdc, 12);
      assert.ok(Math.abs(position.celestialBodies[0].assetQty - 0.004) < 1e-9);
    }
  });
});
