const fs = require('fs');
const path = require('path');

const STATE_FILE = path.join(__dirname, '..', 'data', 'state.json');

/**
 * Get today's date in YYYY-MM-DD format
 * @returns {string}
 */
const today = () => new Date().toISOString().split('T')[0];

/**
 * Create initial state structure
 * @param {Object} config - Configuration object
 * @returns {Object} Initial state
 */
const createInitialState = (config) => ({
  initialAllocation: config.totalAllocation,
  totalAllocated: 0,
  totalDaysRun: 0,
  usdcFundSize: config.totalAllocation,
  btcReserves: 0,
  outstandingOrdersUSDC: 0,
  outstandingOrdersBTC: 0,
  // Fee tracking
  totalFees: 0,
  totalRebates: 0,
  netFees: 0,
  lastRunDate: null,
  orders: [],
});

/**
 * Load state from file
 * @param {Object} config - Configuration for initial state if file doesn't exist
 * @returns {Object} Current state
 */
const loadState = (config = null) => {
  if (!fs.existsSync(STATE_FILE)) {
    if (!config) {
      config = require('../config.json');
    }
    return createInitialState(config);
  }

  const data = fs.readFileSync(STATE_FILE, 'utf8');
  return JSON.parse(data);
};

/**
 * Save state to file
 * @param {Object} state - State to save
 */
const saveState = (state) => {
  const dir = path.dirname(STATE_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
};

/**
 * Check if there's allocation remaining
 * @param {Object} state - Current state
 * @param {Object} config - Configuration
 * @returns {{remaining: number, dailyAmount: number}}
 */
const checkAllocationRemaining = (state, config) => {
  const remaining = config.totalAllocation - state.totalAllocated;
  const dailyAmount = Math.min(
    config.totalAllocation / config.daysToSpread,
    remaining
  );

  return { remaining, dailyAmount };
};

/**
 * Check if bot already ran today
 * @param {Object} state - Current state
 * @returns {boolean}
 */
const checkIfRanToday = (state) => state.lastRunDate === today();

/**
 * Update state after a buy order
 * @param {Object} state - Current state
 * @param {Object} buyDetails - Buy order details
 * @param {Object} sellOrder - Sell order details
 * @param {Object} config - Configuration
 * @returns {Object} Updated state
 */
const updateAfterBuy = (state, buyDetails, sellOrder, config) => {
  const holdbackBTC = buyDetails.btcAmount * (config.holdbackPercent / 100);
  const sellQuantityBTC = buyDetails.btcAmount - holdbackBTC;
  const expectedSellUSDC = sellQuantityBTC * sellOrder.limitPrice;

  // Extract fee details (with defaults for backwards compatibility)
  const buyFees = buyDetails.fees || 0;
  const buyRebates = buyDetails.rebates || 0;
  const buyNetFees = buyDetails.netFees || 0;

  state.totalAllocated += buyDetails.usdcAmount;
  state.totalDaysRun += 1;
  // Actual cost includes net fees
  state.usdcFundSize -= (buyDetails.usdcAmount + buyNetFees);
  state.btcReserves += holdbackBTC;
  state.outstandingOrdersBTC += sellQuantityBTC;
  state.outstandingOrdersUSDC += expectedSellUSDC;
  state.lastRunDate = today();

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
 * @param {Object} state - Current state
 * @param {Object} fillDetails - Fill details including fees/rebates
 * @returns {Object} Updated state
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
 * @param {Object} state - Current state
 * @returns {Array} Pending orders
 */
const getPendingOrders = (state) => state.orders.filter(o => o.status === 'pending');

module.exports = {
  today,
  loadState,
  saveState,
  createInitialState,
  checkAllocationRemaining,
  checkIfRanToday,
  updateAfterBuy,
  updateAfterSellFill,
  getPendingOrders,
};
