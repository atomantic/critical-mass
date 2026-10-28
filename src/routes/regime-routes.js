// @ts-check
/**
 * Regime Engine API Routes (Gateway Proxy)
 *
 * Forwards regime engine commands and queries to the Coinbase engine
 * process via IPC WebSocket. Config reads/writes stay local (file-based).
 */

const { prepareConfigUpdate, persistConfigUpdate, buildClientConfig } = require('./config-update');
const { resolvePlacementIntent } = require('../state-tracker');
const { buildStoppedRegimeStatus } = require('../regime-status');
const { createContextLogger } = require('../logger');
const { readBooleanFlag } = require('../shared-utils');
const { parseFillsQuery, parseAggregateQuery } = require('../transactions-regime-query');
const {
  createIPCResolver, withConfiguredPair, asyncRoute, engineError, ipcFailureKind, sendIpcFailure, parsePaging,
} = require('./route-utils');
const { IPC_CHANNELS } = require('../ipc/ipc-protocol');
const { LADDER_WAIT_MS, FILL_DRAIN_MS } = require('../engine-locks');

/**
 * IPC deadlines for commands whose engine-side work is a sequence of exchange
 * calls, far beyond the 10s request default (ipc-protocol.js). A deadline the
 * operation outlives is worse than a long wait: the gateway reports "Engine
 * unavailable" while the engine keeps working, so the operator retries and
 * the engine queues the same sweep a second time (withLadderLock).
 *
 * - Ladder sweeps (rebuild, cancel, reset-cycle) cancel every rung in turn —
 *   each with up to three verified cancel attempts and 1s polls — then place
 *   the new rungs. Their lock wait is bounded by LADDER_WAIT_MS; the sweep
 *   itself finishes well inside the same budget (engine-locks.js).
 * - Start runs startup reconciliation against the exchange for every open
 *   order; stop drains in-flight fills for up to FILL_DRAIN_MS, flushes state
 *   and ledger, then starts the standalone market-data consumer (candle fetch
 *   plus gap recovery). The 50s on top of the fill drain covers that handover
 *   on a paced exchange REST queue.
 */
const LADDER_SWEEP_TIMEOUT_MS = LADDER_WAIT_MS;
const LIFECYCLE_TIMEOUT_MS = FILL_DRAIN_MS + 50_000;

/**
 * Context logger for the regime routes. Every endpoint here is fund-scoped, so
 * exchange and pair are real context; `route` names the endpoint.
 * @param {string} [exchange] - Exchange the request targets
 * @param {string} [pair] - Fund pair the request targets
 * @param {string} [route] - Express route pattern being served
 * @returns {{info: (message: string, data?: Object) => void, warn: (message: string, data?: Object) => void, error: (message: string, data?: Object) => void}} Context logger
 */
const regimeLogger = (exchange, pair, route) => createContextLogger({
  module: 'regime-routes',
  exchange,
  pair,
  route,
});

/**
 * Read-only status synthesized from disk for when the engine IPC is dead.
 * Delegates to the shared stopped/offline status synthesizer (issue #357),
 * which re-derives P&L from the cached fill ledger and falls back to the
 * ledger's last fill price for `market.lastPrice` when there's no live
 * price to report — the same enrichment the engine's own IPC handler and
 * the realtime stream produce.
 *
 * Returns null when there's no persisted state to fall back on, so a true
 * IPC outage (e.g., first-time fund or broken connection with no saved
 * data) still surfaces as 503 rather than masking as a stopped engine.
 * `health.mode: 'ENGINE_DOWN'` (vs. the engine's own `'STOPPED'`) tells the
 * dashboard this is an unreachable engine, not a clean operator stop, so
 * the operator doesn't take an unsafe control action against a process
 * that may still be running.
 */
const buildOfflineStatus = (exchange, pair) => buildStoppedRegimeStatus(exchange, pair, {
  mode: 'ENGINE_DOWN',
  requireExistingState: true,
});

const REJECT = Symbol('rejectRequest');
/** Payload-builder result that answers 400 with `message` instead of calling the engine. */
const rejectRequest = (message) => ({ [REJECT]: message });

/**
 * @param {import('express').Express} app
 * @param {{exchangeIPCMap: Object}} deps
 */
module.exports = (app, deps) => {
  // Every regime route is fund-scoped. Wrap registrations once so a future
  // handler cannot accidentally forward an unvalidated query string to IPC,
  // and so a thrown/rejected handler (e.g. a synchronous state-tracker file
  // error, or an IPC lookup that isn't already funneled through `.catch`)
  // reaches the JSON error middleware via `next(err)` instead of Express's
  // built-in HTML error page (issue #530).
  const originalApp = app;
  app = Object.create(app);
  for (const method of ['get', 'post', 'put', 'delete']) {
    app[method] = (route, handler) => originalApp[method](route, withConfiguredPair(asyncRoute(handler)));
  }
  const { exchangeIPCMap } = deps;
  const getIPC = createIPCResolver(exchangeIPCMap);
  // Reads the pair already validated and attached by withConfiguredPair —
  // distinct from route-utils' resolvePairParam, which resolves one from
  // params/query before that validation happens.
  const getFundPair = (req) => req.fundPair;

  /**
   * Build the handler for a route that forwards one request to the engine over
   * IPC and relays the reply. A resolved `{success:false}` reply or a failed
   * request is answered through `sendIpcFailure` (503 unreachable, 500 engine
   * handler threw, else the reply's `statusCode` or 400).
   *
   * @param {string} channel - IPC_CHANNELS entry
   * @param {Object} [options]
   * @param {number} [options.timeoutMs] - IPC deadline; omitted keeps the client default
   * @param {(req: import('express').Request) => any} [options.payload] - Builds the IPC payload;
   *   return `rejectRequest(message)` to answer 400 without calling the engine
   * @param {(ctx: {exchange: string, pair: string}, payload: any) => void} [options.onSuccess] - Runs before the reply is sent
   */
  const proxyRegime = (channel, { timeoutMs, payload = () => ({}), onSuccess } = {}) => async (req, res) => {
    const { exchange } = req.params;
    const pair = getFundPair(req);
    const body = payload(req);
    if (body?.[REJECT]) return res.status(400).json({ success: false, error: body[REJECT] });
    const timeoutArgs = timeoutMs === undefined ? [] : [timeoutMs];
    const result = await getIPC(exchange).request(channel, body, exchange, pair, ...timeoutArgs).catch(engineError);
    if (!result.success) return sendIpcFailure(res, result);
    if (onSuccess) onSuccess({ exchange, pair }, body);
    res.json(result);
  };

  // ============ Config (file-based, stays in gateway) ============

  app.get('/api/:exchange/regime/config', (req, res) => {
    const { exchange } = req.params;
    const pair = getFundPair(req);
    const config = buildClientConfig(exchange, pair);
    res.json({ success: true, exchange, pair, config });
  });

  app.put('/api/:exchange/regime/config', async (req, res) => {
    const { exchange } = req.params;
    const pair = getFundPair(req);
    const logger = regimeLogger(exchange, pair, '/api/:exchange/regime/config');
    const rawUpdates = req.body;
    if (typeof rawUpdates !== 'object' || rawUpdates === null || Array.isArray(rawUpdates)) {
      return res.status(400).json({ success: false, errors: ['config update must be an object'] });
    }

    const prepared = prepareConfigUpdate({
      exchange, pair, updates: rawUpdates,
      onDroppedKeys: (droppedKeys) => {
        logger.warn(`⚠️ 🧹 [${exchange}/${pair}] Ignored unknown regime config keys: ${droppedKeys.join(', ')}`, {
          action: 'update-config', droppedKeys,
        });
      },
      onProductMismatch: ({ productId, incomingBase, pairBase }) => {
        logger.warn(`⚠️ 🛑 [${exchange}/${pair}] Rejected config save: productId "${productId}" trades ${incomingBase}, not ${pairBase}`, {
          action: 'update-config', productId, incomingBase, pairBase,
        });
      },
    });
    if (!prepared.valid) return res.status(400).json({ success: false, errors: prepared.errors });

    const result = await persistConfigUpdate(exchange, pair, prepared, getIPC(exchange), () => {
      const { fundUpdates, regimeUpdates } = prepared;
      logger.info(`ℹ️ 🔧 [${exchange}/${pair}] Config updated (fund: ${Object.keys(fundUpdates).join(',') || 'none'}, regime: ${Object.keys(regimeUpdates).join(',') || 'none'})`, {
        action: 'update-config',
        fundKeys: Object.keys(fundUpdates), regimeKeys: Object.keys(regimeUpdates),
      });
    });
    const { config } = result;
    if (!result.applied) {
      logger.error(`❌ 🚨 [${exchange}/${pair}] Regime config persisted but live engine update failed: ${result.error}`, {
        action: 'update-config', channel: IPC_CHANNELS.REGIME_UPDATE_CONFIG,
        persisted: true, applied: false, error: result.error,
      });
      return res.status(503).json({
        success: false, persisted: true, applied: false,
        error: `Config was saved but the live engine did not apply it: ${result.error}`,
        exchange, pair, config,
      });
    }

    res.json({ success: true, persisted: true, applied: true, exchange, pair, config });
  });

  // ============ Engine Commands (forwarded via IPC) ============

  app.get('/api/:exchange/regime/status', async (req, res) => {
    const { exchange } = req.params;
    const pair = getFundPair(req);
    const result = await getIPC(exchange).request(IPC_CHANNELS.REGIME_STATUS, {}, exchange, pair).catch(engineError);
    if (!result.success) {
      // Engine unreachable: serve a read-only status from disk so the dashboard
      // keeps showing persisted body TPs (and doesn't flag those bodies' buys
      // as orphans just because pendingOrders is empty).
      // Skip the fallback for request timeouts — the engine process is likely
      // still alive but slow, and reporting it as "stopped" would mislead the
      // operator. Only fall back when the IPC connection is actually broken.
      const isTimeout = ipcFailureKind(result) === 'timeout' || (result.error || '').toLowerCase().includes('request timeout');
      // A handler that threw inside a connected engine is not an outage either.
      const engineHandlerFailed = ipcFailureKind(result) === 'handler';
      // Admission refusal means a connected engine is busy, not stopped.
      const engineBusy = result.code === 'engine-busy';
      if (!isTimeout && !engineHandlerFailed && !engineBusy) {
        const offlineStatus = buildOfflineStatus(exchange, pair);
        if (offlineStatus) {
          return res.json({ success: true, status: offlineStatus, engineDown: true, engineError: result.error });
        }
      }
      return sendIpcFailure(res, result);
    }
    res.json(result);
  });

  app.post('/api/:exchange/regime/start', proxyRegime(IPC_CHANNELS.REGIME_START, { timeoutMs: LIFECYCLE_TIMEOUT_MS }));

  app.post('/api/:exchange/regime/stop', proxyRegime(IPC_CHANNELS.REGIME_STOP, { timeoutMs: LIFECYCLE_TIMEOUT_MS }));

  app.post('/api/:exchange/regime/pause', proxyRegime(IPC_CHANNELS.REGIME_PAUSE, { payload: (req) => ({ reason: req.body?.reason }) }));

  app.post('/api/:exchange/regime/resume', proxyRegime(IPC_CHANNELS.REGIME_RESUME));

  // Mark fund as draining: blocks new entries, lets the current TP cycle complete,
  // then auto-stops the engine and marks lifecycle 'closed'.
  app.post('/api/:exchange/regime/close', proxyRegime(IPC_CHANNELS.REGIME_CLOSE, {
    payload: (req) => ({ reason: typeof req.body?.reason === 'string' ? req.body.reason : undefined }),
    onSuccess: ({ exchange, pair }, payload) => {
      regimeLogger(exchange, pair, '/api/:exchange/regime/close').info(`ℹ️ 🚦 [${exchange}/${pair}] Fund close requested${payload.reason ? `: ${payload.reason}` : ''}`, {
        action: 'close-fund',
        reason: payload.reason,
      });
    },
  }));

  // Reopen a closed fund: lifecycle 'closed' → 'active'. Does not restart the engine.
  app.post('/api/:exchange/regime/reopen', proxyRegime(IPC_CHANNELS.REGIME_REOPEN, {
    onSuccess: ({ exchange, pair }) => {
      regimeLogger(exchange, pair, '/api/:exchange/regime/reopen').info(`ℹ️ 🔓 [${exchange}/${pair}] Fund reopened`, { action: 'reopen-fund' });
    },
  }));

  app.post('/api/:exchange/regime/force-regime', proxyRegime(IPC_CHANNELS.REGIME_FORCE_REGIME, {
    payload: (req) => {
      const { regime, reason } = req.body || {};
      const validRegimes = ['HARVEST', 'CAUTION', 'TREND'];
      if (typeof regime !== 'string' || !validRegimes.includes(regime.toUpperCase())) {
        return rejectRequest(`Invalid regime. Must be one of: ${validRegimes.join(', ')}`);
      }
      return { regime: regime.toUpperCase(), reason };
    },
  }));

  app.post('/api/:exchange/regime/resume-drawdown', proxyRegime(IPC_CHANNELS.REGIME_RESUME_DRAWDOWN));

  app.get('/api/:exchange/regime/preview-ladder', proxyRegime(IPC_CHANNELS.REGIME_PREVIEW_LADDER));

  app.post('/api/:exchange/regime/rebuild-ladder', proxyRegime(IPC_CHANNELS.REGIME_REBUILD_LADDER, { timeoutMs: LADDER_SWEEP_TIMEOUT_MS }));

  app.post('/api/:exchange/regime/cancel-ladder', proxyRegime(IPC_CHANNELS.REGIME_CANCEL_LADDER, { timeoutMs: LADDER_SWEEP_TIMEOUT_MS }));

  app.post('/api/:exchange/regime/rollup-body', proxyRegime(IPC_CHANNELS.REGIME_ROLLUP_BODY, {
    // Two verified cancellations plus placement can exceed the default 10s IPC deadline.
    timeoutMs: 60_000,
    payload: (req) => {
      const { bodyId } = req.body || {};
      return bodyId ? { bodyId } : rejectRequest('bodyId is required');
    },
  }));

  app.post('/api/:exchange/regime/rollup-all', proxyRegime(IPC_CHANNELS.REGIME_ROLLUP_ALL, { timeoutMs: 300_000 }));

  app.post('/api/:exchange/regime/reset-cycle', proxyRegime(IPC_CHANNELS.REGIME_RESET_CYCLE, { timeoutMs: LADDER_SWEEP_TIMEOUT_MS }));

  // Operator reconcile of an unresolved placement intent. While one exists, the
  // fund refuses every new placement (across restarts), so this is the only way
  // to release it — deliberately: nothing auto-clears an ambiguous placement on
  // a timer or on an empty lookup.
  app.post('/api/:exchange/regime/reconcile-placement-intent', async (req, res) => {
    const { exchange } = req.params;
    const pair = getFundPair(req);
    const { intentId, action } = req.body || {};
    if (!intentId || typeof intentId !== 'string') {
      return res.status(400).json({ success: false, error: 'intentId is required' });
    }
    if (action !== 'adopt' && action !== 'discard') {
      return res.status(400).json({ success: false, error: "action must be 'adopt' or 'discard'" });
    }

    const ipc = getIPC(exchange);
    let transportFailed = false;
    const result = await ipc
      .request(IPC_CHANNELS.REGIME_RECONCILE_PLACEMENT_INTENT, { intentId, action }, exchange, pair)
      .catch((err) => { transportFailed = true; return engineError(err); });
    const disconnected = transportFailed && (
      !Object.prototype.hasOwnProperty.call(exchangeIPCMap, exchange)
      || (typeof ipc.isConnected === 'function' && !ipc.isConnected())
    );

    if (!result.success) {
      // With the engine down there is no in-memory tracking to adopt into, but
      // a discard is purely a disk operation and must stay available — an
      // intent left by a crash is exactly the case where the engine is down.
      // An explicit engine refusal or a timeout on a connected socket does
      // not establish an offline engine; never bypass its intent ownership.
      if (action === 'discard' && disconnected) {
        const removed = resolvePlacementIntent(exchange, pair, intentId);
        if (removed) {
          regimeLogger(exchange, pair, '/api/:exchange/regime/reconcile-placement-intent').warn(
            `⚠️ 🧹 [${exchange}/${pair}] Operator discarded placement intent ${intentId} with the engine down`,
            { action: 'discard-placement-intent', intentId, engineDown: true },
          );
          return res.json({ success: true, engineDown: true, message: 'Discarded the placement intent; placements resume when the engine starts' });
        }
        return res.status(404).json({ success: false, error: `No pending placement intent ${intentId} on this fund` });
      }
      return sendIpcFailure(res, result);
    }

    regimeLogger(exchange, pair, '/api/:exchange/regime/reconcile-placement-intent').info(
      `ℹ️ 🧾 [${exchange}/${pair}] Placement intent ${intentId} reconciled (${action})`,
      { action: `${action}-placement-intent`, intentId },
    );
    res.json(result);
  });

  app.post('/api/:exchange/regime/set-body-tp', proxyRegime(IPC_CHANNELS.REGIME_SET_BODY_TP, {
    payload: (req) => {
      const { bodyId, tpPct } = req.body || {};
      if (!bodyId) return rejectRequest('bodyId is required');
      const pct = parseFloat(tpPct);
      if (isNaN(pct) || pct <= 0 || pct > 50) return rejectRequest('tpPct must be a number between 0 and 50');
      return { bodyId, tpPct: pct };
    },
  }));

  app.post('/api/:exchange/regime/set-body-tp-price', proxyRegime(IPC_CHANNELS.REGIME_SET_BODY_TP_PRICE, {
    payload: (req) => {
      const { bodyId, limitPrice } = req.body || {};
      if (!bodyId) return rejectRequest('bodyId is required');
      const price = parseFloat(limitPrice);
      if (isNaN(price) || price <= 0) return rejectRequest('limitPrice must be a positive number');
      return { bodyId, limitPrice: price };
    },
  }));

  // ============ Data Queries (forwarded via IPC) ============

  app.get('/api/:exchange/regime/chart-data', async (req, res) => {
    const { exchange } = req.params;
    const pair = getFundPair(req);
    const data = await getIPC(exchange).request(IPC_CHANNELS.REGIME_CHART_DATA, {}, exchange, pair).catch(() =>
      ({ priceHistory: [], atrHistory: [], regimeHistory: [], exchange, pair, timestamp: Date.now() })
    );
    res.json({ success: true, exchange, pair, data });
  });

  app.get('/api/:exchange/regime/fills', async (req, res) => {
    const { exchange } = req.params;
    const pair = getFundPair(req);
    const query = parseFillsQuery(req.query);
    if (query.success === false) return res.status(400).json(query);
    const result = await getIPC(exchange).request(IPC_CHANNELS.REGIME_FILLS, query, exchange, pair).catch(engineError);
    if (result.success === false) return sendIpcFailure(res, result);
    res.json({ success: true, exchange, pair, ...result });
  });

  app.get('/api/:exchange/regime/fills/cycles', async (req, res) => {
    const { exchange } = req.params;
    const pair = getFundPair(req);
    const query = parseAggregateQuery(req.query);
    if (query.success === false) return res.status(400).json(query);
    const result = await getIPC(exchange).request(IPC_CHANNELS.REGIME_FILLS_CYCLES, query, exchange, pair).catch(engineError);
    if (result.success === false) return sendIpcFailure(res, result);
    res.json({ success: true, exchange, pair, ...result });
  });

  app.get('/api/:exchange/regime/open-orders', async (req, res) => {
    const { exchange } = req.params;
    const pair = getFundPair(req);
    const result = await getIPC(exchange).request(IPC_CHANNELS.REGIME_OPEN_ORDERS, {}, exchange, pair).catch(engineError);
    if (result.success === false) return sendIpcFailure(res, result);
    res.json({ success: true, exchange, pair, ...result });
  });

  app.post('/api/:exchange/regime/recalculate', proxyRegime(IPC_CHANNELS.REGIME_RECALCULATE, {
    payload: (req) => {
      const applyFlag = readBooleanFlag(req.body || {}, 'apply', false);
      return applyFlag.error ? rejectRequest(applyFlag.error) : { apply: applyFlag.value };
    },
  }));

  app.post('/api/:exchange/regime/convert-dca', proxyRegime(IPC_CHANNELS.REGIME_CONVERT_DCA, {
    payload: (req) => {
      const body = req.body || {};
      const previewFlag = readBooleanFlag(body, 'preview', true);
      if (previewFlag.error) return rejectRequest(previewFlag.error);
      const mergeFlag = readBooleanFlag(body, 'merge', false);
      if (mergeFlag.error) return rejectRequest(mergeFlag.error);
      return { preview: previewFlag.value, merge: mergeFlag.value };
    },
  }));

  // ============ Manual Trade Tracking ============

  // Starts (or joins) an engine-owned scan and answers promptly (issue #966):
  // `pending: true` + `jobId` means poll the status route below; otherwise
  // the body is the complete result.
  app.get('/api/:exchange/regime/unaccounted-fills', proxyRegime(IPC_CHANNELS.REGIME_UNACCOUNTED_FILLS, {
    payload: (req) => {
      const { startDate } = req.query;
      return startDate ? { startDate } : rejectRequest('startDate query parameter is required');
    },
  }));

  app.get('/api/:exchange/regime/unaccounted-fills/jobs/:jobId', proxyRegime(IPC_CHANNELS.REGIME_UNACCOUNTED_FILLS_STATUS, { payload: (req) => ({ jobId: req.params.jobId }) }));

  app.get('/api/:exchange/regime/manual-trades', proxyRegime(IPC_CHANNELS.REGIME_MANUAL_TRADES));

  app.post('/api/:exchange/regime/manual-trade', proxyRegime(IPC_CHANNELS.REGIME_MANUAL_TRADE, { payload: (req) => req.body }));

  app.post('/api/:exchange/regime/manual-trade/:tradeId/check', proxyRegime(IPC_CHANNELS.REGIME_MANUAL_TRADE_CHECK, { payload: (req) => ({ tradeId: req.params.tradeId }) }));

  // Resume the selected durable body intent, without re-importing fills or
  // starting recovery work for any other manual trade.
  app.post('/api/:exchange/regime/manual-trade/:tradeId/resume', proxyRegime(IPC_CHANNELS.REGIME_MANUAL_TRADE_RESUME, {
    payload: (req) => {
      const { tradeId } = req.params;
      if (typeof tradeId !== 'string' || !tradeId.trim()) return rejectRequest('tradeId must be a non-blank string');
      return { tradeId };
    },
  }));

  // Continue a sell-first recovery whose buy is confirmed terminal (issue
  // #1034): place a buy for the uncovered remainder, or link a replacement.
  app.post('/api/:exchange/regime/manual-trade/:tradeId/retry', proxyRegime(IPC_CHANNELS.REGIME_MANUAL_TRADE_RETRY, {
    payload: (req) => {
      const { recoveryBuyPrice, existingBuyOrderId } = req.body || {};
      return { tradeId: req.params.tradeId, recoveryBuyPrice, existingBuyOrderId };
    },
  }));

  app.post('/api/:exchange/regime/manual-trade-buy', proxyRegime(IPC_CHANNELS.REGIME_MANUAL_TRADE_BUY, {
    payload: (req) => {
      const body = req.body || {};
      const createBodyFlag = readBooleanFlag(body, 'createBody', true);
      return createBodyFlag.error ? rejectRequest(createBodyFlag.error) : { ...body, createBody: createBodyFlag.value };
    },
  }));

  app.post('/api/:exchange/regime/manual-trade-pair', proxyRegime(IPC_CHANNELS.REGIME_MANUAL_TRADE_PAIR, { payload: (req) => req.body }));

  app.post('/api/:exchange/regime/dismiss-fills', proxyRegime(IPC_CHANNELS.REGIME_DISMISS_FILLS, {
    payload: (req) => {
      const { orderIds } = req.body || {};
      return Array.isArray(orderIds) && orderIds.length > 0 ? { orderIds } : rejectRequest('orderIds array is required');
    },
  }));

  // ============ Dry-Run Routes (forwarded via IPC) ============

  app.get('/api/:exchange/regime/dry-run/log', proxyRegime(IPC_CHANNELS.REGIME_DRY_RUN_LOG, {
    payload: (req) => ({ limit: parsePaging(req.query, 100).limit }),
  }));

  app.get('/api/:exchange/regime/dry-run/pnl', proxyRegime(IPC_CHANNELS.REGIME_DRY_RUN_PNL));

  app.post('/api/:exchange/regime/dry-run/reset', proxyRegime(IPC_CHANNELS.REGIME_DRY_RUN_RESET));

  app.get('/api/:exchange/regime/dry-run/state', proxyRegime(IPC_CHANNELS.REGIME_DRY_RUN_STATE));
};
