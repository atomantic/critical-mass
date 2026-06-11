// @ts-check
const fs = require('fs');
const path = require('path');
const {
  normalizeConfig,
  getRunIdentifier,
  hasRunThisInterval
} = require('./interval-utils');
const { getExchangeDataDir, getFundDataDir, resolveFundDataDir } = require('./migration');

/**
 * @typedef {import('./types').BotState} BotState
 * @typedef {import('./types').TrackedOrder} TrackedOrder
 * @typedef {import('./types').ExchangeConfig} ExchangeConfig
 * @typedef {import('./types').AllocationInfo} AllocationInfo
 * @typedef {import('./types').BuyResult} BuyResult
 * @typedef {import('./types').SellOrder} SellOrder
 * @typedef {import('./types').FilledSellOrder} FilledSellOrder
 * @typedef {import('./types').IntervalType} IntervalType
 * @typedef {import('./types').FibonacciFillDetails} FibonacciFillDetails
 * @typedef {import('./types').FibonacciCycleInfo} FibonacciCycleInfo
 * @typedef {import('./types').RegimePositionState} RegimePositionState
 * @typedef {import('./types').RegimeState} RegimeState
 */

const { createInitialFibState, resetFibState, getAverageCostBasis } = require('./fibonacci-utils');
const { migrateFromLegacy, createInitialCelestialState } = require('./celestial-hierarchy');
const { loadRawConfig } = require('./config-utils');
const { DATA_DIR } = require('./paths');

/**
 * Fund lifecycle states. The operator drives transitions:
 *   ACTIVE → DRAINING (operator clicks Close): block new entries, leave TP in place
 *   DRAINING → CLOSED (TP fills): engine auto-stops
 *   CLOSED → ACTIVE (operator clicks Reopen): allows engine to start again
 */
const LIFECYCLE = Object.freeze({
  ACTIVE: 'active',
  DRAINING: 'draining',
  CLOSED: 'closed',
});

/**
 * Atomic write: write to .tmp then rename (POSIX-atomic).
 * Prevents truncated JSON on crash.
 * @param {string} filePath - Target file path
 * @param {string} data - Data to write
 */
const atomicWriteSync = (filePath, data) => {
  const tmpPath = filePath + '.tmp';
  fs.writeFileSync(tmpPath, data);
  fs.renameSync(tmpPath, filePath);
};

/** @type {Map<string, number>} In-memory save version per file */
const saveVersions = new Map();

/**
 * Get state file path for a fund (exchange + pair).
 * Read-only path resolution — does NOT create the directory. Callers that
 * write should ensure the directory exists themselves (via mkdirSync), or
 * use getFundDataDir which creates it as a side effect.
 * @param {string} exchange - Exchange name (default: coinbase)
 * @param {string} [pair] - Pair name; defaults to the exchange's default pair
 * @returns {string} Path to state file
 */
const getStateFile = (exchange = 'coinbase', pair) => {
  return path.join(resolveFundDataDir(exchange, pair), 'state.json');
};

/**
 * Create initial state structure
 * @param {ExchangeConfig} config - Configuration object
 * @returns {BotState} Initial state
 */
const createInitialState = (config) => ({
  initialAllocation: config.totalAllocation,
  totalAllocated: 0,
  totalIntervalsRun: 0,
  usdcFundSize: config.totalAllocation,
  assetReserves: 0,
  outstandingOrdersUSDC: 0,
  outstandingOrdersAsset: 0,
  totalFees: 0,
  totalRebates: 0,
  netFees: 0,
  lastRunId: null,
  lastRunTimestamp: null,
  orders: [],
});

/**
 * Migrate old state format to new format
 * @param {BotState} state - State object
 * @returns {BotState} Migrated state
 */
const migrateState = (state) => {
  // Migrate totalDaysRun -> totalIntervalsRun
  if (state.totalDaysRun !== undefined && state.totalIntervalsRun === undefined) {
    state.totalIntervalsRun = state.totalDaysRun;
    delete state.totalDaysRun;
  }
  // Migrate lastRunDate -> lastRunId
  if (state.lastRunDate && !state.lastRunId) {
    state.lastRunId = `daily-migrated-${state.lastRunDate}`;
    state.lastRunTimestamp = new Date(state.lastRunDate).getTime();
    delete state.lastRunDate;
  }
  // Ensure new fields exist
  if (state.totalIntervalsRun === undefined) state.totalIntervalsRun = 0;
  if (state.lastRunId === undefined) state.lastRunId = null;
  if (state.lastRunTimestamp === undefined) state.lastRunTimestamp = null;

  // Migrate BTC-named fields to asset-agnostic names (old state files on disk)
  // NOTE: old key names are constructed to avoid being renamed by refactoring scripts
  const _old = (prefix, suffix) => prefix + suffix;
  if (_old('btc', 'Reserves') in state) {
    state.assetReserves = state[_old('btc', 'Reserves')];
    delete state[_old('btc', 'Reserves')];
  }
  if (_old('outstandingOrders', 'BTC') in state) {
    state.outstandingOrdersAsset = state[_old('outstandingOrders', 'BTC')];
    delete state[_old('outstandingOrders', 'BTC')];
  }
  if (_old('fibCumulative', 'BTC') in state) {
    state.fibCumulativeAsset = state[_old('fibCumulative', 'BTC')];
    delete state[_old('fibCumulative', 'BTC')];
  }
  if (state.assetReserves === undefined) state.assetReserves = 0;
  if (state.outstandingOrdersAsset === undefined) state.outstandingOrdersAsset = 0;

  // Migrate order-level BTC fields
  if (state.orders) {
    for (const order of state.orders) {
      if (_old('buyQuantity', 'BTC') in order) {
        order.buyQuantity = order[_old('buyQuantity', 'BTC')];
        delete order[_old('buyQuantity', 'BTC')];
      }
      if (_old('sellQuantity', 'BTC') in order) {
        order.sellQuantity = order[_old('sellQuantity', 'BTC')];
        delete order[_old('sellQuantity', 'BTC')];
      }
      if (_old('holdback', 'BTC') in order) {
        order.holdbackAsset = order[_old('holdback', 'BTC')];
        delete order[_old('holdback', 'BTC')];
      }
    }
  }

  return state;
};

/**
 * Load state from file
 * @param {ExchangeConfig|null} [config] - Configuration for initial state if file doesn't exist
 * @param {string} [exchange] - Exchange name (default: coinbase)
 * @returns {BotState} Current state
 */
const loadState = (config = null, exchange = 'coinbase', pair) => {
  if (!config) {
    config = loadRawConfig();
    if (config.exchanges && config.exchanges[exchange]) {
      config = { ...config.global, ...config.exchanges[exchange] };
    }
  }

  const stateFile = getStateFile(exchange, pair);

  if (!fs.existsSync(stateFile)) {
    return createInitialState(config);
  }

  const data = fs.readFileSync(stateFile, 'utf8');
  let state = JSON.parse(data);

  // Migrate old state format if needed
  state = migrateState(state);

  // Sync usdcFundSize if totalAllocation changed in config
  if (config.totalAllocation !== state.initialAllocation) {
    const delta = config.totalAllocation - state.initialAllocation;
    state.usdcFundSize += delta;
    state.initialAllocation = config.totalAllocation;
    saveState(state, exchange, pair);
  }

  return state;
};

/**
 * Save state to file
 * @param {BotState} state - State to save
 * @param {string} [exchange] - Exchange name (default: coinbase)
 * @param {string} [pair] - Pair name; defaults to the exchange's default pair
 * @returns {void}
 */
const saveState = (state, exchange = 'coinbase', pair) => {
  const stateFile = getStateFile(exchange, pair);
  const dir = path.dirname(stateFile);
  fs.mkdirSync(dir, { recursive: true });
  atomicWriteSync(stateFile, JSON.stringify(state, null, 2));
};

/**
 * Check if there's allocation remaining
 * @param {BotState} state - Current state
 * @param {ExchangeConfig} config - Configuration
 * @returns {AllocationInfo}
 */
const checkAllocationRemaining = (state, config) => {
  const normalized = normalizeConfig(config);
  const remaining = normalized.totalAllocation - state.totalAllocated;
  const intervalAmount = Math.min(
    normalized.totalAllocation / normalized.intervalsToSpread,
    remaining
  );

  return { remaining, intervalAmount };
};

/**
 * Check if bot already ran this interval
 * @param {BotState} state - Current state
 * @param {IntervalType} intervalType - Interval type from config
 * @returns {boolean}
 */
const checkIfRanThisInterval = (state, intervalType) =>
  hasRunThisInterval(state.lastRunId, intervalType);

/**
 * Record a confirmed buy fill before any sell order exists.
 * Persisting this immediately after the fill — BEFORE sell placement —
 * guarantees a sell-placement failure cannot lose the buy: totalAllocated,
 * reserves, and lastRunId are all set here, so the next interval cannot
 * double-buy (issue #106).
 * @param {BotState} state - Current state
 * @param {BuyResult} buyDetails - Buy order details
 * @param {ExchangeConfig} config - Configuration
 * @returns {BotState} Updated state
 */
const recordBuyFill = (state, buyDetails, config) => {
  const normalized = normalizeConfig(config);
  const holdbackAsset = buyDetails.assetAmount * (config.holdbackPercent / 100);
  const sellQuantity = buyDetails.assetAmount - holdbackAsset;

  // Extract fee details (with defaults for backwards compatibility)
  const buyFees = buyDetails.fees || 0;
  const buyRebates = buyDetails.rebates || 0;
  const buyNetFees = buyDetails.netFees || 0;

  state.totalAllocated += buyDetails.usdcAmount;
  state.totalIntervalsRun += 1;
  // Actual cost includes net fees
  state.usdcFundSize -= (buyDetails.usdcAmount + buyNetFees);
  state.assetReserves += holdbackAsset;
  state.lastRunId = getRunIdentifier(normalized.intervalType);
  state.lastRunTimestamp = Date.now();

  // Update cumulative fee tracking
  state.totalFees = (state.totalFees || 0) + buyFees;
  state.totalRebates = (state.totalRebates || 0) + buyRebates;
  state.netFees = (state.netFees || 0) + buyNetFees;

  state.orders.push({
    orderId: null,
    buyOrderId: buyDetails.orderId,
    buyPrice: buyDetails.price,
    buyQuantity: buyDetails.assetAmount,
    buyUSDC: buyDetails.usdcAmount,
    buyFees: buyFees,
    buyRebates: buyRebates,
    buyNetFees: buyNetFees,
    buyCostBasis: buyDetails.usdcAmount + buyNetFees,
    sellPrice: null,
    sellQuantity: sellQuantity,
    holdbackAsset: holdbackAsset,
    status: 'awaiting_sell',
    createdAt: new Date().toISOString(),
  });

  return state;
};

/**
 * Find the order entry recorded by recordBuyFill that has no sell attached yet
 * @param {BotState} state - Current state
 * @param {string} buyOrderId - Buy order ID
 * @returns {TrackedOrder|undefined} Matching order entry
 */
const findAwaitingSellOrder = (state, buyOrderId) =>
  state.orders.find(o => o.buyOrderId === buyOrderId && o.status === 'awaiting_sell');

/**
 * Attach a successfully placed sell order to a previously recorded buy fill
 * @param {BotState} state - Current state
 * @param {string} buyOrderId - Buy order ID the sell covers
 * @param {SellOrder} sellOrder - Placed sell order details
 * @returns {BotState} Updated state
 */
const attachSellOrder = (state, buyOrderId, sellOrder) => {
  const order = findAwaitingSellOrder(state, buyOrderId);
  if (!order) return state;

  order.orderId = sellOrder.orderId;
  order.sellPrice = sellOrder.limitPrice;
  order.status = 'pending';
  state.outstandingOrdersAsset += order.sellQuantity;
  state.outstandingOrdersUSDC += order.sellQuantity * sellOrder.limitPrice;

  return state;
};

/**
 * Mark a recorded buy fill whose sell placement failed.
 * Excluded from pending-order checks (status filter) but kept visible in
 * state for operator follow-up — the buy's accounting is already recorded.
 * @param {BotState} state - Current state
 * @param {string} buyOrderId - Buy order ID
 * @param {string} reason - Failure reason
 * @returns {BotState} Updated state
 */
const markSellPlacementFailed = (state, buyOrderId, reason) => {
  const order = findAwaitingSellOrder(state, buyOrderId);
  if (!order) return state;

  order.status = 'sell_failed';
  order.sellFailedReason = reason;
  order.sellFailedAt = new Date().toISOString();

  return state;
};

/**
 * Update state after a buy order with the sell already placed (dry-run path
 * and any caller that has both halves up front). Composes recordBuyFill +
 * attachSellOrder so both paths share one accounting implementation.
 * @param {BotState} state - Current state
 * @param {BuyResult} buyDetails - Buy order details
 * @param {SellOrder} sellOrder - Sell order details
 * @param {ExchangeConfig} config - Configuration
 * @returns {BotState} Updated state
 */
const updateAfterBuy = (state, buyDetails, sellOrder, config) => {
  recordBuyFill(state, buyDetails, config);
  return attachSellOrder(state, buyDetails.orderId, sellOrder);
};

/**
 * Update state when a sell order fills (includes fee tracking)
 * @param {BotState} state - Current state
 * @param {FilledSellOrder} fillDetails - Fill details including fees/rebates
 * @returns {BotState} Updated state
 */
const updateAfterSellFill = (state, fillDetails) => {
  // Extract fee details (with defaults for backwards compatibility)
  const sellFees = fillDetails.fees || 0;
  const sellRebates = fillDetails.rebates || 0;
  const sellNetFees = fillDetails.netFees || 0;

  // Net proceeds after fees
  const netProceeds = fillDetails.netProceeds || (fillDetails.fillValue - sellNetFees);

  state.usdcFundSize += netProceeds;
  state.outstandingOrdersAsset -= fillDetails.filledSize;

  // Update cumulative fee tracking
  state.totalFees = (state.totalFees || 0) + sellFees;
  state.totalRebates = (state.totalRebates || 0) + sellRebates;
  state.netFees = (state.netFees || 0) + sellNetFees;

  // Find and update the order
  const orderIndex = state.orders.findIndex(o => o.orderId === fillDetails.orderId);
  if (orderIndex >= 0) {
    state.outstandingOrdersUSDC -= state.orders[orderIndex].sellQuantity * state.orders[orderIndex].sellPrice;
    state.orders[orderIndex].status = 'filled';
    state.orders[orderIndex].filledAt = new Date().toISOString();
    state.orders[orderIndex].actualFillValue = fillDetails.fillValue;
    state.orders[orderIndex].sellFees = sellFees;
    state.orders[orderIndex].sellRebates = sellRebates;
    state.orders[orderIndex].sellNetFees = sellNetFees;
    state.orders[orderIndex].netProceeds = netProceeds;
  }

  return state;
};

/**
 * Get all pending orders
 * @param {BotState} state - Current state
 * @returns {TrackedOrder[]} Pending orders
 */
const getPendingOrders = (state) => state.orders.filter(o => o.status === 'pending');

/**
 * Update state after consolidating orders
 * @param {BotState} state - Current state
 * @param {TrackedOrder[]} consolidatedOrders - Orders that were consolidated
 * @param {string} newOrderId - ID of the new consolidated order
 * @param {number} newSellPrice - Sell price of the consolidated order
 * @param {number} newSellQuantity - BTC quantity in the consolidated order
 * @returns {BotState} Updated state
 */
const updateAfterConsolidation = (state, consolidatedOrders, newOrderId, newSellPrice, newSellQuantity) => {
  const now = new Date().toISOString();
  const sourceOrderIds = consolidatedOrders.map(o => o.orderId);

  // Calculate aggregated buy data from consolidated orders
  let totalBuyCostBasis = 0;
  let totalBuyQuantityBTC = 0;
  let totalHoldbackBTC = 0;
  let totalBuyFees = 0;
  let totalBuyRebates = 0;
  let totalBuyNetFees = 0;

  for (const order of consolidatedOrders) {
    totalBuyCostBasis += order.buyCostBasis || (order.buyUSDC + (order.buyNetFees || 0));
    totalBuyQuantityBTC += order.buyQuantity;
    totalHoldbackBTC += order.holdbackAsset || 0;
    totalBuyFees += order.buyFees || 0;
    totalBuyRebates += order.buyRebates || 0;
    totalBuyNetFees += order.buyNetFees || 0;

    // Mark original order as consolidated
    const orderIndex = state.orders.findIndex(o => o.orderId === order.orderId);
    if (orderIndex >= 0) {
      state.orders[orderIndex].status = 'consolidated';
      state.orders[orderIndex].consolidatedInto = newOrderId;
      state.orders[orderIndex].consolidatedAt = now;
    }
  }

  // Calculate weighted average buy price
  const weightedBuyPrice = totalBuyQuantityBTC > 0
    ? totalBuyCostBasis / totalBuyQuantityBTC
    : 0;

  // Create new consolidated order entry
  const consolidatedOrder = {
    orderId: newOrderId,
    buyOrderId: `consolidated-${Date.now()}`,
    buyPrice: weightedBuyPrice,
    buyQuantity: totalBuyQuantityBTC,
    buyUSDC: totalBuyCostBasis - totalBuyNetFees,
    buyFees: totalBuyFees,
    buyRebates: totalBuyRebates,
    buyNetFees: totalBuyNetFees,
    buyCostBasis: totalBuyCostBasis,
    sellPrice: newSellPrice,
    sellQuantity: newSellQuantity,
    holdbackAsset: totalHoldbackBTC,
    status: 'pending',
    createdAt: now,
    isConsolidated: true,
    sourceOrderIds,
  };

  state.orders.push(consolidatedOrder);

  return state;
};

/**
 * Initialize Fibonacci state fields if not present
 * @param {BotState} state - Current state
 * @param {ExchangeConfig} config - Configuration
 * @returns {BotState} State with Fibonacci fields initialized
 */
const initFibonacciState = (state, config) => {
  if (config.dcaStrategy !== 'fibonacci') return state;

  // Initialize Fibonacci fields if they don't exist
  if (state.fibPosition === undefined) {
    const fibState = createInitialFibState();
    Object.assign(state, fibState);
  }

  return state;
};

/**
 * Update state after a Fibonacci buy order
 * @param {BotState} state - Current state
 * @param {BuyResult} buyDetails - Buy order details
 * @param {ExchangeConfig} config - Configuration
 * @returns {BotState} Updated state
 */
const updateAfterFibBuy = (state, buyDetails, config) => {
  const normalized = normalizeConfig(config);

  // Extract fee details
  const buyFees = buyDetails.fees || 0;
  const buyRebates = buyDetails.rebates || 0;
  const buyNetFees = buyDetails.netFees || 0;
  const costBasis = buyDetails.usdcAmount + buyNetFees;

  // Start cycle if this is the first buy
  if (state.fibCycleStartTime === null) {
    state.fibCycleStartTime = Date.now();
  }

  // Update cumulative tracking
  state.fibCumulativeCost = (state.fibCumulativeCost || 0) + costBasis;
  state.fibCumulativeAsset = (state.fibCumulativeAsset || 0) + buyDetails.assetAmount;

  // Increment position for next buy
  state.fibPosition = (state.fibPosition || 0) + 1;

  // Update standard tracking
  state.totalAllocated += buyDetails.usdcAmount;
  state.totalIntervalsRun += 1;
  state.usdcFundSize -= (buyDetails.usdcAmount + buyNetFees);
  state.lastRunId = getRunIdentifier(normalized.intervalType);
  state.lastRunTimestamp = Date.now();

  // Update cumulative fee tracking
  state.totalFees = (state.totalFees || 0) + buyFees;
  state.totalRebates = (state.totalRebates || 0) + buyRebates;
  state.netFees = (state.netFees || 0) + buyNetFees;

  return state;
};

/**
 * Update state after placing a Fibonacci sell order
 * @param {BotState} state - Current state
 * @param {SellOrder} sellOrder - Sell order details
 * @param {number} sellQuantity - BTC quantity in sell order
 * @param {number} holdbackAsset - BTC held back as reserves (tracked but not added to reserves until cycle completes)
 * @returns {BotState} Updated state
 */
const updateAfterFibSellOrder = (state, sellOrder, sellQuantity, holdbackAsset) => {
  state.fibActiveSellOrderId = sellOrder.orderId;
  // Track cumulative holdback for this cycle, but don't add to reserves yet
  // Reserves are only credited when the cycle sell fills (in updateAfterFibSellFill)
  state.fibPendingHoldback = holdbackAsset;
  state.outstandingOrdersAsset = sellQuantity; // Replace, not add (consolidated order)
  state.outstandingOrdersUSDC = sellQuantity * sellOrder.limitPrice;

  return state;
};

/**
 * Update state when a Fibonacci cycle sell fills
 * @param {BotState} state - Current state
 * @param {FibonacciFillDetails} fillDetails - Fill details
 * @returns {BotState} Updated state with cycle reset
 */
const updateAfterFibSellFill = (state, fillDetails) => {
  const sellFees = fillDetails.fees || 0;
  const sellRebates = fillDetails.rebates || 0;
  const sellNetFees = fillDetails.netFees || 0;
  const netProceeds = fillDetails.netProceeds || (fillDetails.fillValue - sellNetFees);

  // Return proceeds to fund
  state.usdcFundSize += netProceeds;
  state.outstandingOrdersAsset -= fillDetails.filledSize;
  state.outstandingOrdersUSDC = Math.max(0, state.outstandingOrdersUSDC - fillDetails.fillValue);

  // Credit holdback to reserves now that cycle is complete
  if (state.fibPendingHoldback > 0) {
    state.assetReserves += state.fibPendingHoldback;
  }

  // Update cumulative fee tracking
  state.totalFees = (state.totalFees || 0) + sellFees;
  state.totalRebates = (state.totalRebates || 0) + sellRebates;
  state.netFees = (state.netFees || 0) + sellNetFees;

  // Reset Fibonacci cycle state (including fibPendingHoldback)
  const fibReset = resetFibState();
  Object.assign(state, fibReset);

  return state;
};

/**
 * Get current Fibonacci cycle information
 * @param {BotState} state - Current state
 * @returns {FibonacciCycleInfo} Cycle information
 */
const getFibonacciCycleInfo = (state) => {
  const cumulativeCost = state.fibCumulativeCost || 0;
  const cumulativeAsset = state.fibCumulativeAsset || 0;

  return {
    position: state.fibPosition || 0,
    cumulativeCost,
    cumulativeAsset,
    avgCostBasis: getAverageCostBasis(cumulativeCost, cumulativeAsset),
    activeSellOrderId: state.fibActiveSellOrderId || null,
    cycleStartTime: state.fibCycleStartTime || null,
  };
};

// ============================================================================
// Regime State Management
// ============================================================================

/**
 * Get regime state file path for a fund (exchange + pair).
 * Read-only path resolution — does NOT create the directory.
 * @param {string} exchange - Exchange name
 * @param {string} [pair] - Pair name; defaults to the exchange's default pair
 * @returns {string} Path to regime state file
 */
const getRegimeStateFile = (exchange = 'coinbase', pair) => {
  return path.join(resolveFundDataDir(exchange, pair), 'regime-state.json');
};

/**
 * Create initial regime position state
 * @returns {RegimePositionState}
 */
const createInitialRegimePositionState = () => ({
  totalAsset: 0,
  totalCostBasis: 0,
  avgCostBasis: 0,
  cycleBuys: 0,
  lastEntryPrice: 0,
  lastEntryTime: 0,
  anchorPrice: 0,
  activeTpOrderId: null,
  lastTpPrice: 0,
  cyclesCompleted: 0,
  unrealizedPnL: 0,
  realizedPnL: 0,
  realizedAssetPnL: 0,
  assetOnOrder: 0,
  maxDrawdownSeen: 0,
  scalingDisabled: false,
  scalingDisabledReason: null,
  // APY tracking fields
  engineStartTime: null,
  initialCapital: 0,
  // Pending entry orders (persisted across restarts)
  pendingEntryOrders: [],
  // Ladder mode state
  ladderActive: false,
  ladderPlacedAt: null,
  ladderLowerBound: 0,
  pendingLadderOrders: [],  // [{orderId, price, sizeUsdc, ladderIndex}]
  // Legacy satellite fields removed — migrated into celestialState on load
  // Celestial Hierarchy state
  celestialBodies: [],          // CelestialBody[]
  celestialState: {
    bodiesCompleted: 0,
    bodiesRealizedPnL: 0,
    bodiesRealizedAssetPnL: 0,
    stateVersion: 1,
  },
  // Macro regime state (persisted for recovery)
  macroRegime: null,
  // Fund lifecycle — see LIFECYCLE constant exported from this module
  lifecycle: LIFECYCLE.ACTIVE,
  lifecycleChangedAt: null,
  lifecycleReason: null,
  lifecycleClosedCycle: null,
});

/**
 * Create initial regime state
 * @returns {RegimeState}
 */
const createInitialRegimeState = () => ({
  mode: 'HARVEST',
  since: Date.now(),
  transitionCount: 0,
  trendDirection: null,
  lastVolExpansion: 1.0,
  lastMomentumMag: 0,
  trendConfirmationCount: 0,
});

/**
 * Load regime state from file
 * @param {string} exchange - Exchange name
 * @param {string} [pair] - Pair name; defaults to the exchange's default pair
 * @returns {{position: RegimePositionState, regime: RegimeState, tpOptimizer?: Object, sizeOptimizer?: Object}}
 */
const loadRegimeState = (exchange = 'coinbase', pair) => {
  const stateFile = getRegimeStateFile(exchange, pair);

  if (!fs.existsSync(stateFile)) {
    return {
      position: createInitialRegimePositionState(),
      regime: createInitialRegimeState(),
      tpOptimizer: null,
      sizeOptimizer: null,
    };
  }

  const data = JSON.parse(fs.readFileSync(stateFile, 'utf8'));

  // Migrate ladderStep -> cycleBuys if needed
  if (data.position && data.position.ladderStep !== undefined && data.position.cycleBuys === undefined) {
    data.position.cycleBuys = data.position.ladderStep;
    delete data.position.ladderStep;
  }

  // Migrate BTC-named fields to asset-agnostic names (old regime-state.json on disk)
  // NOTE: old key names are constructed to avoid being renamed by refactoring scripts
  const _old = (prefix, suffix) => prefix + suffix;
  if (data.position) {
    const p = data.position;
    if (_old('total', 'BTC') in p) {
      p.totalAsset = p[_old('total', 'BTC')];
      delete p[_old('total', 'BTC')];
    }
    if (_old('realizedBtc', 'PnL') in p) {
      p.realizedAssetPnL = p[_old('realizedBtc', 'PnL')];
      delete p[_old('realizedBtc', 'PnL')];
    }
    if (_old('maxBtc', 'Exposure') in p) {
      p.maxAssetExposure = p[_old('maxBtc', 'Exposure')];
      delete p[_old('maxBtc', 'Exposure')];
    }
    if (_old('btcOn', 'Order') in p) {
      p.assetOnOrder = p[_old('btcOn', 'Order')];
      delete p[_old('btcOn', 'Order')];
    }
    // Migrate celestialState BTC fields
    const cs = p.celestialState;
    if (cs && _old('bodiesRealizedBtc', 'PnL') in cs) {
      cs.bodiesRealizedAssetPnL = cs[_old('bodiesRealizedBtc', 'PnL')];
      delete cs[_old('bodiesRealizedBtc', 'PnL')];
    }
    // Migrate celestialBodies BTC fields
    if (p.celestialBodies) {
      for (const body of p.celestialBodies) {
        if (_old('btc', 'Qty') in body) {
          body.assetQty = body[_old('btc', 'Qty')];
          delete body[_old('btc', 'Qty')];
        }
        if (_old('btcOn', 'Order') in body) {
          body.assetOnOrder = body[_old('btcOn', 'Order')];
          delete body[_old('btcOn', 'Order')];
        }
      }
    }
  }

  const position = { ...createInitialRegimePositionState(), ...data.position };

  // Sync in-memory save version from disk
  const diskVersion = (data.position && data.position._saveVersion) || 0;
  saveVersions.set(stateFile, diskVersion);

  // Fold legacy satellite* counters into celestialState (one-time migration)
  if (position.satellitesCompleted || position.satelliteRealizedPnL || position.satelliteRealizedBtcPnL) {
    const cs = position.celestialState || createInitialCelestialState();
    cs.bodiesCompleted = (cs.bodiesCompleted || 0) + (position.satellitesCompleted || 0);
    cs.bodiesRealizedPnL = (cs.bodiesRealizedPnL || 0) + (position.satelliteRealizedPnL || 0);
    cs.bodiesRealizedAssetPnL = (cs.bodiesRealizedAssetPnL || 0) + (position.satelliteRealizedBtcPnL || 0);
    position.celestialState = cs;
    delete position.satellitesCompleted;
    delete position.satelliteRealizedPnL;
    delete position.satelliteRealizedBtcPnL;
    console.log(`🔄 Folded legacy satellite counters into celestialState`);
  }

  // Migrate legacy core+satellite state to celestial bodies if needed
  if (!position.celestialBodies || position.celestialBodies.length === 0) {
    const hasCorePosition = position.totalAsset > 0 && position.totalCostBasis > 0;
    const hasSatellites = position.satelliteTpOrders && position.satelliteTpOrders.length > 0;

    if (hasCorePosition || hasSatellites) {
      const configUtils = require('./config-utils');
      const regimeConfig = configUtils.getRegimeConfig(exchange, pair);
      const maxUsdcDeployed = regimeConfig.maxUsdcDeployed || 10000;

      position.celestialBodies = migrateFromLegacy(position, maxUsdcDeployed);
      if (!position.celestialState) {
        position.celestialState = {
          bodiesCompleted: position.cyclesCompleted || 0,
          bodiesRealizedPnL: position.realizedPnL || 0,
          bodiesRealizedAssetPnL: position.realizedAssetPnL || 0,
          stateVersion: 1,
        };
      }

      const coreCount = hasCorePosition ? 1 : 0;
      const satCount = hasSatellites ? position.satelliteTpOrders.length : 0;
      console.log(`🔄 Migrated ${coreCount} core + ${satCount} satellites → ${position.celestialBodies.length} celestial bodies`);
    } else {
      position.celestialBodies = [];
      position.celestialState = position.celestialState || createInitialCelestialState();
    }
  }

  // Clean up legacy satellite fields from position (no longer used)
  delete position.satelliteTpOrders;
  delete position.satellitesCompleted;
  delete position.satelliteRealizedPnL;
  delete position.satelliteRealizedBtcPnL;

  return {
    position,
    regime: { ...createInitialRegimeState(), ...data.regime },
    tpOptimizer: data.tpOptimizer || null,
    sizeOptimizer: data.sizeOptimizer || null,
  };
};

/**
 * Save regime state to file
 * @param {RegimePositionState} position - Position state
 * @param {RegimeState} regime - Regime state
 * @param {string} exchange - Exchange name
 * @param {Object} [tpOptimizer] - Optional TP optimizer state
 * @param {Object} [sizeOptimizer] - Optional Size optimizer state
 * @param {string} [pair] - Pair name; defaults to the exchange's default pair
 */
/**
 * Protected fields that should be preserved from external edits
 * when an optimistic version conflict is detected.
 */
const PROTECTED_FIELDS = ['celestialBodies', 'celestialState', 'realizedPnL', 'realizedAssetPnL'];

const saveRegimeState = (position, regime, exchange = 'coinbase', tpOptimizer = null, sizeOptimizer = null, pair) => {
  const stateFile = getRegimeStateFile(exchange, pair);
  const dir = path.dirname(stateFile);

  fs.mkdirSync(dir, { recursive: true });

  // Optimistic version locking: detect external edits. A corrupt/unreadable
  // disk file must not crash background savers (this runs from timer paths).
  // But silently overwriting it would discard the operator's protected fields
  // (regime state holds live financial position) — so quarantine the bad file
  // aside for manual recovery before the fresh write below replaces it.
  const myVersion = saveVersions.get(stateFile) || 0;
  if (fs.existsSync(stateFile)) {
    let diskData = null;
    try {
      diskData = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    } catch (err) {
      const quarantinePath = `${stateFile}.corrupt-${Date.now()}`;
      fs.renameSync(stateFile, quarantinePath);
      console.log(`⚠️ Regime state unreadable (${err.message}) — quarantined to ${path.basename(quarantinePath)} before overwrite`);
    }
    const diskVersion = (diskData?.position && diskData.position._saveVersion) || 0;
    if (diskData && diskVersion > myVersion) {
      // External edit detected — merge protected fields from disk
      console.log(`🔀 Merge: disk version ${diskVersion} > memory ${myVersion}, preserving external edits on [${PROTECTED_FIELDS.join(', ')}]`);
      for (const field of PROTECTED_FIELDS) {
        if (diskData.position[field] !== undefined) {
          position[field] = diskData.position[field];
        }
      }
    }
  }

  const nextVersion = myVersion + 1;
  position._saveVersion = nextVersion;
  saveVersions.set(stateFile, nextVersion);

  const stateData = { position, regime };
  if (tpOptimizer) {
    stateData.tpOptimizer = tpOptimizer;
  }
  if (sizeOptimizer) {
    stateData.sizeOptimizer = sizeOptimizer;
  }

  atomicWriteSync(stateFile, JSON.stringify(stateData, null, 2));
};

/**
 * Update regime position state after entry
 * @param {RegimePositionState} state - Current state
 * @param {Object} entryDetails - Entry details
 * @param {number} entryDetails.assetAmount - BTC purchased
 * @param {number} entryDetails.costBasis - Cost including fees
 * @param {number} entryDetails.price - Entry price
 * @returns {RegimePositionState} Updated state
 */
const updateRegimeStateAfterEntry = (state, entryDetails) => {
  const { assetAmount, costBasis, price } = entryDetails;

  state.totalAsset += assetAmount;
  state.totalCostBasis += costBasis;
  state.avgCostBasis = state.totalAsset > 0 ? state.totalCostBasis / state.totalAsset : 0;
  state.cycleBuys += 1;
  state.lastEntryPrice = price;
  state.lastEntryTime = Date.now();
  state.anchorPrice = price;

  return state;
};

module.exports = {
  LIFECYCLE,
  loadState,
  saveState,
  createInitialState,
  migrateState,
  checkAllocationRemaining,
  checkIfRanThisInterval,
  recordBuyFill,
  attachSellOrder,
  markSellPlacementFailed,
  updateAfterBuy,
  updateAfterSellFill,
  updateAfterConsolidation,
  getPendingOrders,
  getStateFile,
  // Fibonacci state management
  initFibonacciState,
  updateAfterFibBuy,
  updateAfterFibSellOrder,
  updateAfterFibSellFill,
  getFibonacciCycleInfo,
  // Regime state management
  // (updateRegimeStateAfterTP was removed — used a `realizedPnL += pnl`
  // accumulator pattern that's been replaced by FIFO derivation in
  // refreshRealizedFromFifo. See docs/pnl-architecture.md R1.)
  getRegimeStateFile,
  createInitialRegimePositionState,
  createInitialRegimeState,
  loadRegimeState,
  saveRegimeState,
  updateRegimeStateAfterEntry,
  // Atomic write utility (exposed for fill-ledger and testing)
  atomicWriteSync,
};
