// @ts-check
/**
 * DCA-to-Regime Engine Converter
 *
 * Converts DCA order history into regime fill-ledger entries,
 * preserves existing sell orders as celestial bodies, and
 * prepares the regime engine state for a seamless start.
 */

const fs = require('fs');
const path = require('path');
const { loadState, saveState, loadRegimeState, saveRegimeState } = require('./state-tracker');
const { createFillLedger, isCompletedCycle } = require('./fill-ledger');
const { createNewBody, classifyTier, syncPositionState } = require('./celestial-hierarchy');
const { setFundEnabled: setConfigFundEnabled, setExchangeEnabled, getRegimeConfig, getFundConfig } = require('./config-utils');
const { resolveFundDataDir } = require('./migration');
const { runDcaImportTransaction, recoverDcaImport, hasPendingDcaImport } = require('./dca-conversion-transaction');
const { log } = require('./logger');

const CONVERSION_FILES = ['state.json', 'fill-ledger.json', 'regime-state.json'];

/**
 * Log label for a fund. Conversion logs must name the pair — an
 * exchange-only label is ambiguous on a multi-fund exchange.
 * @param {string} exchange
 * @param {string} [pair]
 * @returns {string}
 */
const fundLabel = (exchange, pair) => (pair ? `${exchange}/${pair}` : exchange);

/**
 * Enable/disable the fund being converted. `setExchangeEnabled`'s alias form
 * targets the exchange's DEFAULT fund, which is the wrong fund whenever a
 * non-default pair is being converted — so forward the pair to
 * `setFundEnabled` when we have one.
 * @param {string} exchange
 * @param {string|undefined} pair
 * @param {boolean} enabled
 */
const setFundEnabled = (exchange, pair, enabled) => (
  pair ? setConfigFundEnabled(exchange, pair, enabled) : setExchangeEnabled(exchange, enabled)
);

/**
 * Back up the state files involved in a DCA conversion.
 *
 * Resolves the per-fund directory with the SAME resolver the conversion's
 * writes use (resolveFundDataDir, via getStateFile / getFillLedgerPath /
 * getRegimeStateFile), so the backup and the mutation can never target
 * different directories. Backing up `data/<exchange>/` instead silently
 * copied nothing on every install that had run migrateExchangeToPairs,
 * while the writes still landed in `data/<exchange>/<pair>/`.
 *
 * Throws when nothing was backed up: rewriting the fill ledger (the
 * documented source of truth for realized P&L) with no rollback point is
 * not a conversion worth starting. Callers must invoke this BEFORE any
 * mutation so the throw leaves state untouched.
 *
 * @param {string} exchange
 * @param {string} [pair] - Fund pair; defaults to the exchange's default pair
 * @returns {{ backupSuffix: string, backedUpFiles: string[] }}
 */
const backupConversionFiles = (exchange, pair) => {
  const dataDir = resolveFundDataDir(exchange, pair);
  const backupSuffix = `.backup-dca-convert-${Date.now()}`;
  const backedUpFiles = [];

  for (const file of CONVERSION_FILES) {
    const src = path.join(dataDir, file);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, path.join(dataDir, file + backupSuffix));
      backedUpFiles.push(file);
    }
  }

  if (backedUpFiles.length === 0) {
    throw new Error(
      `No DCA conversion state found for ${fundLabel(exchange, pair)} — refusing to convert without a rollback backup`,
    );
  }

  return { backupSuffix, backedUpFiles };
};

/**
 * Categorize DCA orders into pending (open sells), filled (completed), and consolidated
 * @param {import('./types').TrackedOrder[]} orders
 * @returns {{ pending: import('./types').TrackedOrder[], filled: import('./types').TrackedOrder[], skipped: number }}
 */
const categorizeOrders = (orders) => {
  const pending = [];
  const filled = [];
  let skipped = 0;

  for (const order of orders) {
    // Skip source orders that were consumed by consolidation
    if (order.consolidatedInto) {
      skipped++;
      continue;
    }

    // 'awaiting_sell' / 'sell_failed' represent a REAL filled buy whose sell is
    // not yet (or never) placed — the asset is held with an open obligation,
    // exactly like a 'pending' open-sell. Bucket them as pending so the
    // conversion migrates their buy cost/qty instead of silently dropping a
    // real position (issue #106 follow-up).
    if (order.status === 'pending' || order.status === 'awaiting_sell' || order.status === 'sell_failed') {
      pending.push(order);
    } else if (order.status === 'filled') {
      filled.push(order);
    } else {
      skipped++;
    }
  }

  return { pending, filled, skipped };
};

/**
 * Preview DCA-to-Regime conversion without making changes
 * @param {string} exchange
 * @param {string} [pair] - Fund pair; defaults to the exchange's default pair
 * @returns {{ pending: number, filled: number, skipped: number, totalBaseQty: number, totalCostBasis: number, pendingBaseQty: number, pendingCostBasis: number, sellOrderIds: string[], productId: string, assetReserves: number }}
 */
const previewConversion = (exchange, pair) => {
  const state = loadState(null, exchange, pair);
  const exchangeConfig = getFundConfig(exchange, pair);
  const orders = state.orders || [];
  const { pending, filled, skipped } = categorizeOrders(orders);

  const totalBaseQty = filled.reduce((sum, o) => sum + (o.buyQuantity || 0), 0);
  const totalCostBasis = filled.reduce((sum, o) => sum + (o.buyCostBasis || o.buyUSDC || 0), 0);
  const pendingBaseQty = pending.reduce((sum, o) => sum + (o.buyQuantity || 0), 0);
  const pendingCostBasis = pending.reduce((sum, o) => sum + (o.buyCostBasis || o.buyUSDC || 0), 0);

  // Check if existing regime state has celestial bodies (merge mode)
  const existingRegime = loadRegimeState(exchange, pair);
  const existingBodies = existingRegime?.position?.celestialBodies?.length || 0;
  const existingAsset = existingRegime?.position?.totalAsset || 0;
  const existingCostBasis = existingRegime?.position?.totalCostBasis || 0;

  return {
    pending: pending.length,
    filled: filled.length,
    skipped,
    totalBaseQty,
    totalCostBasis,
    pendingBaseQty,
    pendingCostBasis,
    sellOrderIds: pending.map(o => o.orderId),
    totalAllocated: state.totalAllocated || 0,
    assetReserves: state.assetReserves || 0,
    productId: exchangeConfig.productId,
    merge: existingBodies > 0,
    existingBodies,
    existingAsset,
    existingCostBasis,
  };
};

/**
 * Ground-truth "is any buy in this cycle still genuinely open" check —
 * the SAME buy→sell pairing computeRealizedFromCyclePairs uses (a buy is
 * open when its sellOrderId is absent, or names a sell that isn't actually
 * in the ledger), not a sell/buy SIZE ratio. isCompletedCycle's ratio
 * heuristic misjudges a fully-closed but legitimately high-holdback trade
 * (config.holdbackPercent > 50, so sold size < half bought size) as
 * "incomplete" — which matters here because a merge candidate cycle
 * inferred from load()'s own heuristic (no persisted position.activeCycleId
 * to trust outright) could be exactly such an already-closed trade, from
 * THIS import or an earlier one.
 *
 * Known limitation, deliberately accepted: like computeRealizedFromCyclePairs
 * itself (see its "sellOrderId is stamped at TP placement... a stamp alone
 * doesn't mean the buy closed" note), presence of ANY sell fill for a buy's
 * sellOrderId counts it as paired — a buy whose TP is still genuinely
 * mid-fill (not a designed holdback, just not fully executed yet) can read
 * as "closed" here too. Distinguishing that case would require live
 * exchange order state this offline import has no access to; the fallback
 * this guards is already narrow (only reached with no persisted
 * position.activeCycleId at all — effectively pre-#675 state files), and
 * misjudging it costs a cycle-grouping nicety, not P&L correctness
 * (computeRealizedFromCyclePairs stays correct regardless of cycle
 * grouping).
 * @param {Array<Object>} cycleFills - fills already assigned to the candidate cycle
 * @param {Array<Object>} allFills - every fill in the ledger (sellOrderId may point outside the cycle)
 * @returns {boolean}
 */
const cycleHasOpenBuy = (cycleFills, allFills) => {
  const sellOrderIdsPresent = new Set(
    allFills.filter((f) => f.side === 'sell' && f.orderId).map((f) => f.orderId),
  );
  return cycleFills.some((f) => f.side === 'buy' && (!f.sellOrderId || !sellOrderIdsPresent.has(f.sellOrderId)));
};

/**
 * Ingest DCA "filled" and "pending" orders into a fill ledger as synthetic
 * fills. Shared by executeConversion and mergeToRegime so the two loops
 * cannot drift apart again (issue #692) — before this helper existed,
 * mergeToRegime never stamped sellOrderId on a filled order's buy fill and
 * never opened a fresh cycle for the pending block, so a completed DCA
 * trade's buy and sell landed in the SAME cycle as the still-open pending
 * buys. Per CLAUDE.md's P&L model, cycles are atomic buy(n)->sell(1): mixing
 * a closed pair into the live cycle left the sell unpaired (realized P&L
 * zeroed) and the cycle's low sell ratio meant recalculateCycles() restored
 * it as the active cycle on the next engine start.
 *
 * @param {ReturnType<typeof createFillLedger>} fillLedger
 * @param {Array<Object>} filled - completed DCA buy+sell order pairs
 * @param {Array<Object>} pending - still-open DCA buys
 * @param {{ linkPendingSells: boolean, mergeActiveCycleId?: string|null }} options
 *   `linkPendingSells: true` (executeConversion, always a fresh ledger):
 *   stamp each pending buy's sellOrderId with its still-open exchange sell
 *   order, and always start a brand-new cycle for the pending block.
 *   `linkPendingSells: false` (mergeToRegime, an existing regime run):
 *   leave sellOrderId unset — the caller annotates isBodyOwned/bodyId once
 *   celestial bodies exist — and reuse the fund's genuine live cycle for
 *   the pending block while that cycle is not yet completed (per
 *   isCompletedCycle's sell-ratio threshold, not merely "zero sells so
 *   far", and NEVER a cycle this same call just created for a completed
 *   DCA pair — see below), so open positions merged in land in the
 *   engine's real in-progress cycle — including one with a partial TP
 *   fill already on it — instead of a new cycle that would orphan it.
 *   The live cycle is `mergeActiveCycleId` (#675's positionState.
 *   activeCycleId) when the caller has one, else whichever cycle the
 *   ledger itself already considered live before this call touched
 *   anything (older state files without the persisted marker fall back
 *   to the ledger's own heuristic, mirroring restorePersistedCycleId in
 *   regime-engine.js). Restoring `mergeActiveCycleId` also reserves its
 *   cycle NUMBER (setCurrentCycleId bumps nextCycleNumber), so the filled
 *   loop above can never coincidentally reassign that same reserved-but-
 *   fill-less cycle ID to an unrelated completed DCA pair.
 * @returns {{ filledIngested: number, pendingIngested: number }}
 */
const ingestDcaOrdersIntoLedger = (fillLedger, filled, pending, { linkPendingSells, mergeActiveCycleId = null }) => {
  // Capture whatever cycle the ledger considered "live" BEFORE this import
  // touches anything — either restored from genuine pre-existing fills on
  // disk (real regime-engine trading activity), or null on a fresh/just-
  // reset ledger. This is the merge-mode fallback candidate below for when
  // there is no persisted position.activeCycleId to restore. It MUST be
  // captured now, before the filled loop runs: every completed order in
  // that loop calls its own startNewCycle(), and a cycle it creates must
  // never be mistaken for a pre-existing live one.
  const originalActiveCycleId = fillLedger.getCurrentCycleId();

  // Reserve the persisted live cycle's NUMBER (if any) before assigning any
  // cycle to the imported orders, so nextCycleNumber can never let the
  // filled loop's own startNewCycle() calls below coincidentally reissue
  // that same reserved-but-fill-less cycle ID to an unrelated completed
  // DCA pair — see the options doc above.
  if (mergeActiveCycleId) {
    fillLedger.setCurrentCycleId(mergeActiveCycleId);
  }

  let filledIngested = 0;
  for (const order of filled) {
    fillLedger.startNewCycle();

    // Synthetic buy fill
    const buyTradeId = `dca-convert-buy-${order.buyOrderId}`;
    const buyResult = fillLedger.ingestFill({
      tradeId: buyTradeId,
      orderId: order.buyOrderId,
      side: 'buy',
      price: order.buyPrice,
      size: order.buyQuantity,
      totalCommission: order.buyFees || 0,
      rebate: order.buyRebates || 0,
      liquidityIndicator: 'TAKER',
      tradeTime: order.createdAt,
    });

    // Synthetic sell fill
    const sellTradeId = `dca-convert-sell-${order.orderId}`;
    fillLedger.ingestFill({
      tradeId: sellTradeId,
      orderId: order.orderId,
      side: 'sell',
      price: order.sellPrice,
      size: order.sellQuantity,
      totalCommission: order.sellFees || 0,
      rebate: order.sellRebates || 0,
      liquidityIndicator: 'MAKER',
      tradeTime: order.filledAt || order.createdAt,
    });

    // Link the buy to its sell so computeRealizedFromCyclePairs pairs them
    // directly instead of relying on a later recalculateCycles() auto-link
    // pass (which only links buys within cycles it judges "completed" —
    // never guaranteed to run, e.g. mergeToRegime doesn't call it at all).
    // A no-op if the buy trade wasn't actually appended (duplicate re-run).
    fillLedger.annotateFillsByOrderId(order.buyOrderId, { sellOrderId: order.orderId });

    if (buyResult.ingested) filledIngested++;
  }

  // Open (or reuse) the cycle that will hold the still-open pending buys.
  if (linkPendingSells) {
    // executeConversion always starts from a clean cycle boundary — it just
    // (re)built the ledger, so there is no pre-existing active cycle worth
    // preserving.
    fillLedger.startNewCycle();
  } else {
    // mergeToRegime preserves an existing regime run. Decide which
    // pre-existing cycle (if any) is the fund's genuine live boundary for
    // the pending block — prefer the persisted boundary
    // (mergeActiveCycleId / position.activeCycleId, #675) when present;
    // otherwise fall back to originalActiveCycleId, the cycle the ledger
    // itself considered live BEFORE this import touched anything (older
    // state files without the persisted marker fall back to the ledger's
    // own heuristic, exactly as restorePersistedCycleId in regime-engine.js
    // does). Restore that candidate (not "wherever the filled loop above
    // happened to leave the cursor" — each completed order there calls its
    // own startNewCycle()) and reuse it only while NOT yet completed, per
    // the SAME completion test (isCompletedCycle / CYCLE_COMPLETE_SELL_RATIO)
    // recalculateCycles() and every other cycle-boundary decision in the
    // engine uses.
    //
    // Never fall back to "whatever cycle the filled loop just created" —
    // a completed DCA order can legitimately hold back more than half its
    // bought asset (config.holdbackPercent > 50), which would read as
    // "incomplete" under the 0.5 sell-ratio threshold despite being a
    // fully closed trade; mistaking it for a live cycle here would mix the
    // pending buys into it and reintroduce this issue's original bug.
    //
    // A partially-filled TP (sell ratio below the completion threshold) on
    // a genuine pre-existing/persisted boundary still leaves that cycle
    // "live": positionState.activeCycleId keeps naming it, and the engine
    // restores that same boundary on restart. Starting a new cycle here
    // anyway would silently orphan that boundary from the buys just merged
    // in — a brand-new cycle is only warranted once the boundary has
    // actually closed, or there was no pre-existing boundary at all.
    //
    // Trust level differs by source: `mergeActiveCycleId` is an EXPLICIT
    // boundary the engine itself persisted (including a freshly reserved,
    // still-empty one right after an operator cycle reset) — reuse it via
    // the same lenient ratio test the rest of the engine uses, unless its
    // own fills already show it closed. `originalActiveCycleId` is only
    // load()'s own INFERRED guess (no persisted marker to trust outright),
    // which can land on an already-closed high-holdback trade the ratio
    // test alone would misjudge as open (isCompletedCycle above, and see
    // cycleHasOpenBuy's docstring) — require ground-truth buy/sell pairing
    // for that guess instead of trusting the ratio.
    const candidateCycleId = mergeActiveCycleId || originalActiveCycleId;
    if (candidateCycleId) {
      fillLedger.setCurrentCycleId(candidateCycleId);
      const candidateFills = fillLedger.getCurrentCycleFills();
      const candidateStillOpen = mergeActiveCycleId
        ? !isCompletedCycle(candidateFills)
        : cycleHasOpenBuy(candidateFills, fillLedger.getAllFills());
      if (!candidateStillOpen) {
        fillLedger.startNewCycle();
      }
    } else {
      fillLedger.startNewCycle();
    }
  }

  let pendingIngested = 0;
  for (const order of pending) {
    // Synthetic buy fill for the open position
    const buyTradeId = `dca-convert-buy-${order.buyOrderId}`;
    const buyResult = fillLedger.ingestFill({
      tradeId: buyTradeId,
      orderId: order.buyOrderId,
      side: 'buy',
      price: order.buyPrice,
      size: order.buyQuantity,
      totalCommission: order.buyFees || 0,
      rebate: order.buyRebates || 0,
      liquidityIndicator: 'TAKER',
      tradeTime: order.createdAt,
    });

    if (linkPendingSells && buyResult.ingested && buyResult.fill) {
      // Link the buy fill to its still-open sell order on the exchange.
      // markDirty after direct field mutation: ingestFill auto-persisted
      // and cleared the dirty flag, so a trailing persist() would
      // otherwise no-op and lose this sellOrderId on restart.
      buyResult.fill.sellOrderId = order.orderId;
      fillLedger.markDirty();
    }

    if (buyResult.ingested) pendingIngested++;
  }

  return { filledIngested, pendingIngested };
};

/**
 * Load the fund's DCA source state and its still-importable orders.
 * @param {string} exchange
 * @param {string} [pair]
 */
const loadEligibleOrders = (exchange, pair) => {
  // Same refusal as backupConversionFiles: with no conversion state at all
  // there is nothing to import and nothing to roll back to.
  const dataDir = resolveFundDataDir(exchange, pair);
  if (!CONVERSION_FILES.some((file) => fs.existsSync(path.join(dataDir, file)))) {
    throw new Error(
      `No DCA conversion state found for ${fundLabel(exchange, pair)} — refusing to convert without a rollback backup`,
    );
  }
  const state = loadState(null, exchange, pair);
  return { state, ...categorizeOrders(state.orders || []) };
};

/**
 * Consume every imported DCA order (and the consolidation sources folded into
 * them) in the SAME source-state object the import read, tagged with the
 * import that consumed it. Called inside the staged transaction, so this
 * consumption publishes together with the bodies and capital it produced.
 * @param {Object} state - DCA state loaded at the start of the staged import
 * @param {Array<Object>} imported - the pending + filled orders being imported
 * @param {string} importId
 * @returns {number} orders marked
 */
const consumeSourceOrders = (state, imported, importId) => {
  const importedSet = new Set(imported);
  let migratedCount = 0;
  for (const order of state.orders || []) {
    if (importedSet.has(order) || order.consolidatedInto) {
      order.status = 'migrated_to_regime';
      order.migratedImportId = importId;
      migratedCount++;
    }
  }
  return migratedCount;
};

/**
 * Cross-file check on a staged import: every importable source order must be
 * consumed, so a completed import can never be applied again.
 * @param {Record<string, any>} docs
 */
const validateStagedImport = (docs) => {
  const sourceState = docs['state.json'];
  if (!sourceState) throw new Error('Staged DCA import has no source state');
  const { pending, filled } = categorizeOrders(sourceState.orders);
  if (pending.length + filled.length > 0) {
    throw new Error(`Staged DCA import left ${pending.length + filled.length} source order(s) importable`);
  }
  if (!docs['regime-state.json']) throw new Error('Staged DCA import has no regime state');
};

/**
 * Recover an interrupted earlier import before reading anything — a
 * rolled-forward import consumes source orders this call must not re-import.
 * @param {string} exchange
 * @param {string} [pair]
 */
const recoverBeforeImport = (exchange, pair) => {
  try {
    recoverDcaImport(exchange, pair);
  } catch (err) {
    log('ERROR', `❌ [${fundLabel(exchange, pair)}] Interrupted DCA import could not be recovered: ${err.message}`);
    throw new Error(`An interrupted DCA import for ${fundLabel(exchange, pair)} could not be recovered — see engine logs for details`);
  }
};

/**
 * Result for a request with nothing left to import (e.g. a repeated, already
 * completed import). It must not append bodies or attribute capital again.
 * @param {Object} [extra]
 */
const noopImportResult = (extra = {}) => ({
  success: true,
  noop: true,
  backupDir: null,
  backedUpFiles: [],
  summary: { filledOrders: 0, pendingOrders: 0, celestialBodies: 0, capitalAttributed: 0, ...extra },
});

/**
 * Stable source identities recorded in the import journal.
 * @param {Array<Object>} orders
 */
const sourceIdentities = (orders) => orders.map((o) => ({ orderId: o.orderId, buyOrderId: o.buyOrderId }));

/**
 * Execute DCA-to-Regime conversion
 *
 * Runs as one recoverable transaction (issue #860, src/dca-conversion-
 * transaction.js): the ledger, the regime position and the consumed DCA
 * source state are staged and validated together, then published, so a
 * failure can never leave a mixed generation behind.
 * @param {string} exchange
 * @param {string} [pair] - Fund pair; defaults to the exchange's default pair
 * @returns {{ success: boolean, backupDir: string|null, summary: Object }}
 */
const executeConversion = (exchange, pair) => {
  recoverBeforeImport(exchange, pair);

  // Nothing importable (e.g. the conversion already completed): a no-op. A
  // replay must not rebuild — and so wipe — the regime state it produced.
  const eligible = loadEligibleOrders(exchange, pair);
  if (eligible.pending.length + eligible.filled.length === 0) {
    log('INFO', `ℹ️ [${fundLabel(exchange, pair)}] DCA conversion: no importable DCA orders — nothing to do`);
    return noopImportResult();
  }

  // 1. Backup existing state files. Throws (before anything is mutated and
  // before the DCA engine is disabled) when there is nothing to roll back to.
  const { backupSuffix, backedUpFiles } = backupConversionFiles(exchange, pair);
  log('INFO', `💾 [${fundLabel(exchange, pair)}] DCA conversion backup: ${backedUpFiles.join(', ')} → ${backupSuffix}`);

  // 2. Disable DCA engine, remembering its setting so an aborted conversion
  // restores exactly what the operator had (never enables a disabled fund).
  const wasEnabled = getFundConfig(exchange, pair)?.enabled === true;
  setFundEnabled(exchange, pair, false);
  log('INFO', `⏹️ [${fundLabel(exchange, pair)}] DCA engine disabled`);

  let staged;
  try {
    staged = runDcaImportTransaction({
      exchange,
      pair,
      kind: 'convert',
      sourceOrders: sourceIdentities([...eligible.filled, ...eligible.pending]),
      validate: validateStagedImport,
      stage: ({ importId }) => stageConversion(exchange, pair, importId),
    });
  } catch (err) {
    // Restore the DCA setting only when nothing was published. A retained
    // journal means the conversion WILL complete on recovery, and the DCA
    // engine must then stay disabled.
    if (wasEnabled && !hasPendingDcaImport(exchange, pair)) {
      setFundEnabled(exchange, pair, true);
      log('ERROR', `❌ [${fundLabel(exchange, pair)}] DCA conversion aborted: ${err.message} — DCA engine re-enabled`);
    }
    throw err;
  }

  return { success: true, backupDir: backupSuffix, backedUpFiles, summary: staged.summary };
};

/**
 * The conversion itself, run against the staged copy of the fund's files.
 * @param {string} exchange
 * @param {string|undefined} pair
 * @param {string} importId
 */
const stageConversion = (exchange, pair, importId) => {
  // 3. Load DCA state and categorize orders
  const state = loadState(null, exchange, pair);
  const { pending, filled } = categorizeOrders(state.orders || []);

  // 4. Create fill ledger and ingest synthetic fills. A cold-start throw
  // against a corrupt fill-ledger.json aborts the whole transaction (nothing
  // is published) and the caller restores the DCA engine's setting.
  let fillLedger;
  try {
    // `pair` doubles as the productId (fund keys are product ids) — it only
    // drives the ledger's log labels, but a wrong one mislabels every line.
    fillLedger = createFillLedger(exchange, pair, pair);
  } catch (err) {
    log('ERROR', `❌ [${fundLabel(exchange, pair)}] Fill ledger init failed during conversion: ${err.message} — conversion aborted`);
    // Throw a sanitized message: the IPC handler at coinbase-engine.js:
    // regime:convert-dca surfaces this back to the client. Keeping the
    // absolute ledger path / parser internals out of the API surface
    // mirrors the regime:start sanitization. Full detail stays in the
    // ERROR log above for the operator to investigate.
    throw new Error(`Fill ledger init failed for ${fundLabel(exchange, pair)} during DCA conversion — see engine logs for details`);
  }

  // Ingest filled (completed) DCA orders as completed cycles, then start a
  // fresh cycle for the still-open pending orders and link each pending
  // buy to its still-resting exchange sell order (shared with mergeToRegime
  // via ingestDcaOrdersIntoLedger — see its docstring, issue #692).
  const { filledIngested, pendingIngested } = ingestDcaOrdersIntoLedger(fillLedger, filled, pending, {
    linkPendingSells: true,
  });

  fillLedger.persist();
  log('INFO', `📝 [${fundLabel(exchange, pair)}] Fill ledger: ${filledIngested} filled + ${pendingIngested} pending orders ingested`);

  // 5. Build regime state
  const recalcResult = fillLedger.recalculateCycles();
  const currentCycleFills = fillLedger.getCurrentCycleFills();
  const currentPosition = fillLedger.rebuildPositionFromFills(currentCycleFills);
  fillLedger.persist();

  // Create celestial bodies from pending DCA orders
  const regimeConfig = getRegimeConfig(exchange, pair);
  const maxUsdcDeployed = regimeConfig.maxUsdcDeployed || 500;
  const celestialBodies = [];

  for (const order of pending) {
    const costBasis = order.buyCostBasis || (order.buyUSDC + (order.buyFees || 0));
    const body = createNewBody({
      totalSize: order.buyQuantity,
      totalValue: order.buyUSDC,
      totalFees: order.buyFees || 0,
      avgPrice: order.buyPrice,
    }, order.buyOrderId);

    // Don't copy DCA sell order ID — regime engine will re-place TPs with proper pricing.
    // Old DCA order IDs may not be valid for exchange lookup (e.g. crypto.com returns 40003).
    // NOTE: Old DCA sell orders may still be active on the exchange and should be cancelled
    // manually before starting the regime engine to avoid duplicate sells.
    body.tpOrderId = null;
    body.tpPrice = order.sellPrice;
    body.assetOnOrder = 0; // No tracked sell order — regime engine will place new TPs
    body.createdAt = Date.parse(order.createdAt) || Date.now();

    // Classify tier based on cost basis
    const tier = classifyTier(costBasis, maxUsdcDeployed);
    body.tier = tier.name;

    celestialBodies.push(body);
  }

  // Find earliest order for engine start time
  const allOrders = [...filled, ...pending];
  const earliestTime = allOrders.reduce((min, o) => {
    const t = Date.parse(o.createdAt);
    return t && t < min ? t : min;
  }, Date.now());

  // realizedPnL / realizedAssetPnL are derived from FIFO replay over the fill ledger
  // by the regime engine itself (refreshRealizedFromFifo). Don't seed them here —
  // and don't fold DCA assetReserves into realizedAssetPnL: the migrated DCA fills
  // already feed the FIFO computation, which yields true reserves at runtime.
  const allocation = state.totalAllocated || 0;
  const position = {
    ...currentPosition,
    cyclesCompleted: recalcResult.cyclesCompleted,
    realizedPnL: 0,
    realizedAssetPnL: 0,
    celestialBodies,
    celestialState: {
      totalBodiesCreated: celestialBodies.length,
      totalBodiesSold: 0,
      bodiesRealizedPnL: 0,
      bodiesRealizedAssetPnL: 0,
    },
    engineStartTime: earliestTime,
    depositedCapital: allocation,
    // Capital-attribution watermark (issue #860): the DCA allocation this
    // position already counts. A later merge only attributes growth past it.
    dcaImportedAllocation: allocation,
  };

  const regime = {
    currentRegime: 'unknown',
    regimeStartTime: Date.now(),
    volatilityHistory: [],
    entryThreshold: null,
    lastVolatilityCheck: null,
  };

  // Read the prior regime state first so saveRegimeState's optimistic
  // version check sees this as an in-process save, not an external edit:
  // otherwise a prior file's _saveVersion makes it restore the OLD protected
  // fields (celestialBodies, celestialState, realized P&L) over the freshly
  // built position. An unreadable prior file is simply replaced.
  try {
    loadRegimeState(exchange, pair);
  } catch (_) {
    // saveRegimeState quarantines an unreadable file; the staged-file check
    // then aborts the import rather than publishing past it.
  }
  saveRegimeState(position, regime, exchange, null, null, pair);
  log('INFO', `🚀 [${fundLabel(exchange, pair)}] Regime state created: ${celestialBodies.length} celestial bodies, ${recalcResult.cyclesCompleted} completed cycles`);

  // 6. Consume the converted orders in the same staged generation.
  const migratedCount = consumeSourceOrders(state, allOrders, importId);
  saveState(state, exchange, pair);
  log('INFO', `🧹 [${fundLabel(exchange, pair)}] DCA state cleanup: ${migratedCount} orders marked as migrated_to_regime`);

  return {
    summary: {
      filledOrders: filledIngested,
      pendingOrders: pendingIngested,
      celestialBodies: celestialBodies.length,
      cyclesCompleted: recalcResult.cyclesCompleted,
      realizedPnL: position.realizedPnL,
      realizedAssetPnL: position.realizedAssetPnL,
      depositedCapital: position.depositedCapital,
      capitalAttributed: allocation,
      engineStartTime: earliestTime,
    },
  };
};

/**
 * Buy order IDs that already back a celestial body — a live body, or a
 * synthetic DCA buy the ledger records as body-owned (the body may since have
 * been sold). Such orders were imported before and must not get a second body.
 * @param {Object} position
 * @param {ReturnType<typeof createFillLedger>} fillLedger
 * @param {Array<Object>} pending
 * @returns {Set<string>}
 */
const findAlreadyImportedBuys = (position, fillLedger, pending) => {
  const imported = new Set();
  for (const body of position?.celestialBodies || []) {
    for (const id of body?.sourceOrderIds || []) imported.add(id);
    for (const buy of body?.buyOrders || []) if (buy?.orderId) imported.add(buy.orderId);
  }
  for (const order of pending) {
    if (!order.buyOrderId || imported.has(order.buyOrderId)) continue;
    const owned = fillLedger.getFillsForOrder(order.buyOrderId)
      .some((f) => f.tradeId === `dca-convert-buy-${order.buyOrderId}` && f.bodyId);
    if (owned) imported.add(order.buyOrderId);
  }
  return imported;
};

/**
 * Merge DCA positions into an existing regime state (non-destructive)
 * Unlike executeConversion, this preserves existing celestial bodies, regime state, and optimizers.
 *
 * Runs as one recoverable transaction (issue #860): ledger, position and the
 * consumed source orders publish together, a replay with nothing importable
 * is a no-op, buys that already back a body never get a second one, and the
 * DCA allocation is attributed to depositedCapital at most once.
 * @param {string} exchange
 * @param {string} [pair] - Fund pair; defaults to the exchange's default pair
 * @returns {{ success: boolean, backupDir: string|null, summary: Object }}
 */
const mergeToRegime = (exchange, pair) => {
  recoverBeforeImport(exchange, pair);

  const eligible = loadEligibleOrders(exchange, pair);
  if (eligible.pending.length + eligible.filled.length === 0) {
    const position = loadRegimeState(exchange, pair)?.position || {};
    log('INFO', `ℹ️ [${fundLabel(exchange, pair)}] DCA merge: no importable DCA orders — nothing to do`);
    return noopImportResult({
      totalBodies: (position.celestialBodies || []).length,
      totalAsset: position.totalAsset,
      totalCostBasis: position.totalCostBasis,
      depositedCapital: position.depositedCapital,
    });
  }

  // 1. Backup existing state files. Throws before anything is mutated when
  // there is nothing to roll back to.
  const { backupSuffix, backedUpFiles } = backupConversionFiles(exchange, pair);
  log('INFO', `💾 [${fundLabel(exchange, pair)}] DCA merge backup: ${backedUpFiles.join(', ')} → ${backupSuffix}`);

  const staged = runDcaImportTransaction({
    exchange,
    pair,
    kind: 'merge',
    sourceOrders: sourceIdentities([...eligible.filled, ...eligible.pending]),
    validate: validateStagedImport,
    stage: ({ importId }) => stageMerge(exchange, pair, importId),
  });

  return { success: true, backupDir: backupSuffix, backedUpFiles, summary: staged.summary };
};

/**
 * The merge itself, run against the staged copy of the fund's files.
 * @param {string} exchange
 * @param {string|undefined} pair
 * @param {string} importId
 */
const stageMerge = (exchange, pair, importId) => {
  // 2. Load existing regime state and DCA state
  const existingState = loadRegimeState(exchange, pair);
  const position = existingState.position;
  const state = loadState(null, exchange, pair);
  const orders = state.orders || [];
  const { pending, filled } = categorizeOrders(orders);

  // 3. Load existing fill ledger and ingest fills.
  // Wrap createFillLedger so a cold-start corrupt ledger throw is rewritten
  // with merge-specific context; the throw aborts the transaction before
  // anything is published, and the IPC handler returns a structured
  // {success:false} response instead of leaking the raw filesystem message.
  let fillLedger;
  try {
    // `pair` doubles as the productId — see stageConversion above.
    fillLedger = createFillLedger(exchange, pair, pair);
  } catch (err) {
    log('ERROR', `❌ [${fundLabel(exchange, pair)}] Fill ledger init failed during DCA merge: ${err.message}`);
    // Sanitized message — see stageConversion's catch above for rationale.
    throw new Error(`Fill ledger init failed for ${fundLabel(exchange, pair)} during DCA merge — see engine logs for details`);
  }

  // Buys already backing a body (an earlier import) — computed before this
  // call's ingestion/annotation so they are recognized by prior state only.
  const alreadyImported = findAlreadyImportedBuys(position, fillLedger, pending);

  // Ingest filled (completed) DCA orders as their own closed cycles, then
  // ingest the still-open pending buys into the ledger's live active cycle
  // (reused when open, per ingestDcaOrdersIntoLedger's merge-mode branch)
  // instead of the filled orders' cycle — keeps cycles atomic (buy(n)->
  // sell(1), per CLAUDE.md) so a completed DCA trade's realized P&L is
  // never zeroed by an unrelated open position sharing its cycle (#692).
  // isBodyOwned/bodyId for the pending buys is annotated below in step 4b,
  // once their celestial bodies exist.
  //
  // Pass the persisted live-cycle boundary (#675's positionState.
  // activeCycleId) through: a fresh fillLedger instance here only knows the
  // live cycle from fills already on disk, so without this a just-reserved
  // (fill-less) boundary — e.g. right after an operator cycle reset — is
  // invisible to it, and the import could coincidentally reassign that
  // exact cycle ID to an unrelated completed DCA pair.
  const persistedCycleId = position?.activeCycleId;
  const mergeActiveCycleId = typeof persistedCycleId === 'string' && /^cycle-\d+$/.test(persistedCycleId)
    ? persistedCycleId
    : null;
  const { filledIngested, pendingIngested } = ingestDcaOrdersIntoLedger(fillLedger, filled, pending, {
    linkPendingSells: false,
    mergeActiveCycleId,
  });

  // Re-point the persisted boundary at wherever the ledger's live cycle
  // actually ended up (mirrors syncActiveCycleIdAfterRecalc in
  // regime-engine.js): the import above may have started a fresh cycle
  // (no persisted boundary to restore, or the restored one turned out to
  // already be completed) or reused the persisted one as-is. Leaving
  // position.activeCycleId stale would point the next engine restart's
  // restorePersistedCycleId at the wrong — or now-completed — cycle.
  const liveCycleId = fillLedger.getCurrentCycleId();
  if (liveCycleId && liveCycleId !== position.activeCycleId) {
    position.activeCycleId = liveCycleId;
    // Keep the start time paired with the ID (#705): a freshly started cycle
    // reports its creation time, a reused/inferred one reports null (unknown
    // — recalculateCycles then bounds it by its own earliest fill).
    position.activeCycleStartedAt = fillLedger.getCurrentCycleStartedAt();
    // Save the corrected boundary alongside the ledger write. This lands in
    // the staged generation; the import transaction publishes ledger and
    // regime state together, so no reader ever sees one without the other.
    saveRegimeState(position, existingState.regime, exchange, existingState.tpOptimizer, existingState.sizeOptimizer, pair);
  }

  fillLedger.persist();
  log('INFO', `📝 [${fundLabel(exchange, pair)}] Fill ledger merge: ${filledIngested} filled + ${pendingIngested} pending orders ingested`);

  // 4. Create celestial bodies from pending DCA orders that do not already
  // back one (one body per imported buy, even on a replayed import).
  const regimeConfig = getRegimeConfig(exchange, pair);
  const maxUsdcDeployed = regimeConfig.maxUsdcDeployed || 500;
  const newBodies = [];
  let skippedExisting = 0;

  for (const order of pending) {
    if (order.buyOrderId && alreadyImported.has(order.buyOrderId)) {
      skippedExisting++;
      continue;
    }
    const costBasis = order.buyCostBasis || (order.buyUSDC + (order.buyFees || 0));
    const body = createNewBody({
      totalSize: order.buyQuantity,
      totalValue: order.buyUSDC,
      totalFees: order.buyFees || 0,
      avgPrice: order.buyPrice,
    }, order.buyOrderId);

    // Sell orders were canceled — regime engine will place new ones on start
    body.tpOrderId = null;
    body.tpPrice = 0;
    body.assetOnOrder = 0;
    body.createdAt = Date.parse(order.createdAt) || Date.now();

    const tier = classifyTier(costBasis, maxUsdcDeployed);
    body.tier = tier.name;

    newBodies.push({ order, body });
  }
  if (skippedExisting > 0) {
    log('WARN', `⚠️ [${fundLabel(exchange, pair)}] DCA merge: ${skippedExisting} pending order(s) already back a celestial body — not creating duplicates`);
  }

  // 4b. Annotate buy fills with bodyId now that bodies exist
  for (const { order, body } of newBodies) {
    fillLedger.annotateFillsByOrderId(order.buyOrderId, {
      isBodyOwned: true,
      bodyId: body.id,
      bodyTier: body.tier,
    });
  }
  fillLedger.persist();

  // 5. Append new bodies to existing position
  position.celestialBodies = [...(position.celestialBodies || []), ...newBodies.map((n) => n.body)];

  // 6. Update aggregates from all bodies
  syncPositionState(position, position.celestialBodies);

  // 7. Update celestialState counters
  const cs = position.celestialState || { bodiesCompleted: 0, bodiesRealizedPnL: 0, bodiesRealizedAssetPnL: 0, stateVersion: 1 };
  cs.totalBodiesCreated = (cs.totalBodiesCreated || 0) + newBodies.length;
  position.celestialState = cs;

  // realizedAssetPnL is derived from FIFO replay; the migrated DCA fills already
  // feed that computation, so do not fold state.assetReserves in here.

  // 9. Attribute DCA capital exactly once (issue #860). totalAllocated is the
  // DCA fund's cumulative allocation; the position records how much of it is
  // already counted (dcaImportedAllocation) and only the growth past that
  // watermark is added. The watermark publishes in the same transaction as
  // the source consumption below.
  const allocation = state.totalAllocated || 0;
  const alreadyAttributed = Number.isFinite(position.dcaImportedAllocation) ? position.dcaImportedAllocation : 0;
  const capitalAttributed = Math.max(0, allocation - alreadyAttributed);
  position.depositedCapital = (position.depositedCapital || 0) + capitalAttributed;
  position.dcaImportedAllocation = Math.max(alreadyAttributed, allocation);

  // 10. Save regime state (preserving existing regime, tpOptimizer, sizeOptimizer)
  saveRegimeState(position, existingState.regime, exchange, existingState.tpOptimizer, existingState.sizeOptimizer, pair);
  log('INFO', `🔗 [${fundLabel(exchange, pair)}] Regime state merged: +${newBodies.length} celestial bodies (total: ${position.celestialBodies.length})`);

  // 11. Consume the imported orders in the same staged generation.
  const migratedCount = consumeSourceOrders(state, [...pending, ...filled], importId);
  saveState(state, exchange, pair);
  log('INFO', `🧹 [${fundLabel(exchange, pair)}] DCA state cleanup: ${migratedCount} orders marked as migrated_to_regime`);

  return {
    summary: {
      filledOrders: filledIngested,
      pendingOrders: pendingIngested,
      celestialBodies: newBodies.length,
      totalBodies: position.celestialBodies.length,
      totalAsset: position.totalAsset,
      totalCostBasis: position.totalCostBasis,
      realizedAssetPnL: position.realizedAssetPnL,
      depositedCapital: position.depositedCapital,
      capitalAttributed,
    },
  };
};

module.exports = {
  backupConversionFiles,
  categorizeOrders,
  previewConversion,
  executeConversion,
  mergeToRegime,
};
