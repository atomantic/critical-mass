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
 */

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
};
