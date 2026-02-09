// @ts-check
const fs = require('fs');
const path = require('path');
const {
  normalizeConfig,
  getRunIdentifier,
  hasRunThisInterval
} = require('./interval-utils');
const { getExchangeDataDir } = require('./migration');

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

const DATA_DIR = path.join(__dirname, '..', 'data');
const CONFIG_FILE = path.join(__dirname, '..', 'config.json');

/**
 * Get state file path for an exchange
 * @param {string} exchange - Exchange name (default: coinbase)
 * @returns {string} Path to state file
 */
const getStateFile = (exchange = 'coinbase') => {
  const dir = getExchangeDataDir(exchange);
  return path.join(dir, 'state.json');
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
  btcReserves: 0,
  outstandingOrdersUSDC: 0,
  outstandingOrdersBTC: 0,
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
  return state;
};

/**
 * Load state from file
 * @param {ExchangeConfig|null} [config] - Configuration for initial state if file doesn't exist
 * @param {string} [exchange] - Exchange name (default: coinbase)
 * @returns {BotState} Current state
 */
const loadState = (config = null, exchange = 'coinbase') => {
  if (!config) {
    config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    // If multi-exchange config, get the specific exchange config
    if (config.exchanges && config.exchanges[exchange]) {
      config = { ...config.global, ...config.exchanges[exchange] };
    }
  }

  const stateFile = getStateFile(exchange);

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
    saveState(state, exchange);
  }

  return state;
};

/**
 * Save state to file
 * @param {BotState} state - State to save
 * @param {string} [exchange] - Exchange name (default: coinbase)
 * @returns {void}
 */
const saveState = (state, exchange = 'coinbase') => {
  const stateFile = getStateFile(exchange);
  const dir = path.dirname(stateFile);

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
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
 * Update state after a buy order
 * @param {BotState} state - Current state
 * @param {BuyResult} buyDetails - Buy order details
 * @param {SellOrder} sellOrder - Sell order details
 * @param {ExchangeConfig} config - Configuration
 * @returns {BotState} Updated state
 */
const updateAfterBuy = (state, buyDetails, sellOrder, config) => {
  const normalized = normalizeConfig(config);
  const holdbackBTC = buyDetails.btcAmount * (config.holdbackPercent / 100);
  const sellQuantityBTC = buyDetails.btcAmount - holdbackBTC;
  const expectedSellUSDC = sellQuantityBTC * sellOrder.limitPrice;

  // Extract fee details (with defaults for backwards compatibility)
  const buyFees = buyDetails.fees || 0;
  const buyRebates = buyDetails.rebates || 0;
  const buyNetFees = buyDetails.netFees || 0;

  state.totalAllocated += buyDetails.usdcAmount;
  state.totalIntervalsRun += 1;
  // Actual cost includes net fees
  state.usdcFundSize -= (buyDetails.usdcAmount + buyNetFees);
  state.btcReserves += holdbackBTC;
  state.outstandingOrdersBTC += sellQuantityBTC;
  state.outstandingOrdersUSDC += expectedSellUSDC;
  state.lastRunId = getRunIdentifier(normalized.intervalType);
  state.lastRunTimestamp = Date.now();

  // Update cumulative fee tracking
  state.totalFees = (state.totalFees || 0) + buyFees;
  state.totalRebates = (state.totalRebates || 0) + buyRebates;
  state.netFees = (state.netFees || 0) + buyNetFees;

  state.orders.push({
    orderId: sellOrder.orderId,
    buyOrderId: buyDetails.orderId,
    buyPrice: buyDetails.price,
    buyQuantityBTC: buyDetails.btcAmount,
    buyUSDC: buyDetails.usdcAmount,
    buyFees: buyFees,
    buyRebates: buyRebates,
    buyNetFees: buyNetFees,
    buyCostBasis: buyDetails.usdcAmount + buyNetFees,
    sellPrice: sellOrder.limitPrice,
    sellQuantityBTC: sellQuantityBTC,
    holdbackBTC: holdbackBTC,
    status: 'pending',
    createdAt: new Date().toISOString(),
  });

  return state;
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
  state.outstandingOrdersBTC -= fillDetails.filledSize;

  // Update cumulative fee tracking
  state.totalFees = (state.totalFees || 0) + sellFees;
  state.totalRebates = (state.totalRebates || 0) + sellRebates;
  state.netFees = (state.netFees || 0) + sellNetFees;

  // Find and update the order
  const orderIndex = state.orders.findIndex(o => o.orderId === fillDetails.orderId);
  if (orderIndex >= 0) {
    state.outstandingOrdersUSDC -= state.orders[orderIndex].sellQuantityBTC * state.orders[orderIndex].sellPrice;
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
    totalBuyQuantityBTC += order.buyQuantityBTC;
    totalHoldbackBTC += order.holdbackBTC || 0;
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
    buyQuantityBTC: totalBuyQuantityBTC,
    buyUSDC: totalBuyCostBasis - totalBuyNetFees,
    buyFees: totalBuyFees,
    buyRebates: totalBuyRebates,
    buyNetFees: totalBuyNetFees,
    buyCostBasis: totalBuyCostBasis,
    sellPrice: newSellPrice,
    sellQuantityBTC: newSellQuantity,
    holdbackBTC: totalHoldbackBTC,
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
  state.fibCumulativeBTC = (state.fibCumulativeBTC || 0) + buyDetails.btcAmount;

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
 * @param {number} sellQuantityBTC - BTC quantity in sell order
 * @param {number} holdbackBTC - BTC held back as reserves (tracked but not added to reserves until cycle completes)
 * @returns {BotState} Updated state
 */
const updateAfterFibSellOrder = (state, sellOrder, sellQuantityBTC, holdbackBTC) => {
  state.fibActiveSellOrderId = sellOrder.orderId;
  // Track cumulative holdback for this cycle, but don't add to reserves yet
  // Reserves are only credited when the cycle sell fills (in updateAfterFibSellFill)
  state.fibPendingHoldback = holdbackBTC;
  state.outstandingOrdersBTC = sellQuantityBTC; // Replace, not add (consolidated order)
  state.outstandingOrdersUSDC = sellQuantityBTC * sellOrder.limitPrice;

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
  state.outstandingOrdersBTC -= fillDetails.filledSize;
  state.outstandingOrdersUSDC = Math.max(0, state.outstandingOrdersUSDC - fillDetails.fillValue);

  // Credit holdback to reserves now that cycle is complete
  if (state.fibPendingHoldback > 0) {
    state.btcReserves += state.fibPendingHoldback;
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
  const cumulativeBTC = state.fibCumulativeBTC || 0;

  return {
    position: state.fibPosition || 0,
    cumulativeCost,
    cumulativeBTC,
    avgCostBasis: getAverageCostBasis(cumulativeCost, cumulativeBTC),
    activeSellOrderId: state.fibActiveSellOrderId || null,
    cycleStartTime: state.fibCycleStartTime || null,
  };
};

// ============================================================================
// Regime State Management
// ============================================================================

/**
 * Get regime state file path
 * @param {string} exchange - Exchange name
 * @returns {string} Path to regime state file
 */
const getRegimeStateFile = (exchange = 'coinbase') => {
  const dir = getExchangeDataDir(exchange);
  return path.join(dir, 'regime-state.json');
};

/**
 * Create initial regime position state
 * @returns {RegimePositionState}
 */
const createInitialRegimePositionState = () => ({
  totalBTC: 0,
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
  realizedBtcPnL: 0,
  btcOnOrder: 0,
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
  // Satellite TP state (legacy — use celestialBodies)
  satelliteTpOrders: [],        // [{orderId, btcQty, costBasis, avgPrice, tpOrderId, tpPrice, btcOnOrder, placedAt}]
  satellitesCompleted: 0,
  satelliteRealizedPnL: 0,
  satelliteRealizedBtcPnL: 0,
  // Celestial Hierarchy state
  celestialBodies: [],          // CelestialBody[]
  celestialState: {
    bodiesCompleted: 0,
    bodiesRealizedPnL: 0,
    bodiesRealizedBtcPnL: 0,
    stateVersion: 1,
  },
  // Macro regime state (persisted for recovery)
  macroRegime: null,
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
 * @returns {{position: RegimePositionState, regime: RegimeState, tpOptimizer?: Object, sizeOptimizer?: Object}}
 */
const loadRegimeState = (exchange = 'coinbase') => {
  const stateFile = getRegimeStateFile(exchange);

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

  const position = { ...createInitialRegimePositionState(), ...data.position };

  // Migrate legacy core+satellite state to celestial bodies if needed
  if (!position.celestialBodies || position.celestialBodies.length === 0) {
    const hasCorePosition = position.totalBTC > 0 && position.totalCostBasis > 0;
    const hasSatellites = position.satelliteTpOrders && position.satelliteTpOrders.length > 0;

    if (hasCorePosition || hasSatellites) {
      // Get maxUsdcDeployed from config for percentage-based tier classification
      const configUtils = require('./config-utils');
      const regimeConfig = configUtils.getRegimeConfig(exchange);
      const maxUsdcDeployed = regimeConfig.maxUsdcDeployed || 10000;

      position.celestialBodies = migrateFromLegacy(position, maxUsdcDeployed);
      position.celestialState = {
        bodiesCompleted: (position.cyclesCompleted || 0) + (position.satellitesCompleted || 0),
        bodiesRealizedPnL: (position.realizedPnL || 0),
        bodiesRealizedBtcPnL: (position.realizedBtcPnL || 0),
        stateVersion: 1,
      };

      const coreCount = hasCorePosition ? 1 : 0;
      const satCount = hasSatellites ? position.satelliteTpOrders.length : 0;
      console.log(`🔄 Migrated ${coreCount} core + ${satCount} satellites → ${position.celestialBodies.length} celestial bodies`);
    } else {
      position.celestialBodies = [];
      position.celestialState = position.celestialState || createInitialCelestialState();
    }
  }

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
 */
const saveRegimeState = (position, regime, exchange = 'coinbase', tpOptimizer = null, sizeOptimizer = null) => {
  const stateFile = getRegimeStateFile(exchange);
  const dir = path.dirname(stateFile);

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const stateData = { position, regime };
  if (tpOptimizer) {
    stateData.tpOptimizer = tpOptimizer;
  }
  if (sizeOptimizer) {
    stateData.sizeOptimizer = sizeOptimizer;
  }

  fs.writeFileSync(stateFile, JSON.stringify(stateData, null, 2));
};

/**
 * Update regime position state after entry
 * @param {RegimePositionState} state - Current state
 * @param {Object} entryDetails - Entry details
 * @param {number} entryDetails.btcAmount - BTC purchased
 * @param {number} entryDetails.costBasis - Cost including fees
 * @param {number} entryDetails.price - Entry price
 * @returns {RegimePositionState} Updated state
 */
const updateRegimeStateAfterEntry = (state, entryDetails) => {
  const { btcAmount, costBasis, price } = entryDetails;

  state.totalBTC += btcAmount;
  state.totalCostBasis += costBasis;
  state.avgCostBasis = state.totalBTC > 0 ? state.totalCostBasis / state.totalBTC : 0;
  state.cycleBuys += 1;
  state.lastEntryPrice = price;
  state.lastEntryTime = Date.now();
  state.anchorPrice = price;

  return state;
};

/**
 * Update regime position state after TP fill
 * @param {RegimePositionState} state - Current state
 * @param {Object} fillDetails - Fill details
 * @param {number} fillDetails.btcAmount - BTC sold
 * @param {number} fillDetails.proceeds - Net proceeds
 * @param {number} fillDetails.pnl - Realized P&L
 * @returns {RegimePositionState} Updated state
 */
const updateRegimeStateAfterTP = (state, fillDetails) => {
  const { pnl } = fillDetails;

  state.realizedPnL += pnl;
  state.cyclesCompleted += 1;

  // Reset cycle
  state.totalBTC = 0;
  state.totalCostBasis = 0;
  state.avgCostBasis = 0;
  state.cycleBuys = 0;
  state.activeTpOrderId = null;
  state.lastTpPrice = 0;
  state.anchorPrice = 0;
  state.scalingDisabled = false;
  state.scalingDisabledReason = null;

  return state;
};

module.exports = {
  loadState,
  saveState,
  createInitialState,
  migrateState,
  checkAllocationRemaining,
  checkIfRanThisInterval,
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
  getRegimeStateFile,
  createInitialRegimePositionState,
  createInitialRegimeState,
  loadRegimeState,
  saveRegimeState,
  updateRegimeStateAfterEntry,
  updateRegimeStateAfterTP,
};
