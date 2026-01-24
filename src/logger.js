const fs = require('fs');
const path = require('path');
const { getExchangeDataDir } = require('./migration');

/**
 * Get log file path for an exchange
 * @param {string} exchange - Exchange name (default: coinbase)
 * @returns {string} Path to transactions log file
 */
const getLogFile = (exchange = 'coinbase') => {
  const dir = getExchangeDataDir(exchange);
  return path.join(dir, 'transactions.tsv');
};

const HEADERS = [
  'Date',
  'Type',
  'Price',
  'BTC Amount',
  'USDC Amount',
  'Fees',
  'Rebates',
  'Net Fees',
  'Order ID',
  'Fund Size',
  'BTC Reserves',
  'Outstanding USDC',
  'Outstanding BTC',
  'Total Fees',
  'Total Rebates',
];

/**
 * Ensure log file exists with headers
 * @param {string} exchange - Exchange name
 */
const ensureLogFile = (exchange = 'coinbase') => {
  const logFile = getLogFile(exchange);
  const dir = path.dirname(logFile);

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  if (!fs.existsSync(logFile)) {
    fs.writeFileSync(logFile, HEADERS.join('\t') + '\n');
  }
};

/**
 * Format a number for TSV output
 * @param {number} value - Value to format
 * @param {number} decimals - Decimal places
 * @returns {string}
 */
const formatNumber = (value, decimals = 8) => {
  if (value === null || value === undefined) return '';
  return parseFloat(value).toFixed(decimals);
};

/**
 * Log a transaction to the TSV file (includes fee tracking)
 * @param {string} type - Transaction type (BUY, SELL_ORDER, SELL_FILLED)
 * @param {Object} details - Transaction details including fees
 * @param {Object} state - Current state after transaction
 * @param {string} exchange - Exchange name (default: coinbase)
 */
const logTransaction = (type, details, state, exchange = 'coinbase') => {
  ensureLogFile(exchange);
  const logFile = getLogFile(exchange);

  const row = [
    new Date().toISOString().split('T')[0],
    type,
    formatNumber(details.price, 2),
    formatNumber(details.btcAmount, 8),
    formatNumber(details.usdcAmount, 2),
    formatNumber(details.fees || 0, 4),
    formatNumber(details.rebates || 0, 4),
    formatNumber(details.netFees || 0, 4),
    details.orderId || '',
    formatNumber(state.usdcFundSize, 2),
    formatNumber(state.btcReserves, 8),
    formatNumber(state.outstandingOrdersUSDC, 2),
    formatNumber(state.outstandingOrdersBTC, 8),
    formatNumber(state.totalFees || 0, 4),
    formatNumber(state.totalRebates || 0, 4),
  ];

  fs.appendFileSync(logFile, row.join('\t') + '\n');
};

/**
 * Log a buy transaction (includes fee details)
 * @param {Object} buyDetails - Buy order details with fees
 * @param {Object} state - Current state
 * @param {string} exchange - Exchange name (default: coinbase)
 */
const logBuy = (buyDetails, state, exchange = 'coinbase') => {
  logTransaction('BUY', {
    price: buyDetails.price,
    btcAmount: buyDetails.btcAmount,
    usdcAmount: -buyDetails.usdcAmount,
    fees: buyDetails.fees || 0,
    rebates: buyDetails.rebates || 0,
    netFees: buyDetails.netFees || 0,
    orderId: buyDetails.orderId,
  }, state, exchange);
};

/**
 * Log a sell order placement
 * @param {Object} sellOrder - Sell order details
 * @param {Object} state - Current state
 * @param {string} exchange - Exchange name (default: coinbase)
 */
const logSellOrder = (sellOrder, state, exchange = 'coinbase') => {
  logTransaction('SELL_ORDER', {
    price: sellOrder.limitPrice,
    btcAmount: -sellOrder.baseSize,
    usdcAmount: sellOrder.baseSize * sellOrder.limitPrice,
    orderId: sellOrder.orderId,
  }, state, exchange);
};

/**
 * Log a filled sell order (includes fee details)
 * @param {Object} fillDetails - Fill details with fees
 * @param {Object} state - Current state
 * @param {string} exchange - Exchange name (default: coinbase)
 */
const logSellFilled = (fillDetails, state, exchange = 'coinbase') => {
  logTransaction('SELL_FILLED', {
    price: fillDetails.averageFilledPrice,
    btcAmount: -fillDetails.filledSize,
    usdcAmount: fillDetails.netProceeds || fillDetails.fillValue,
    fees: fillDetails.fees || 0,
    rebates: fillDetails.rebates || 0,
    netFees: fillDetails.netFees || 0,
    orderId: fillDetails.orderId,
  }, state, exchange);
};

/**
 * Load transaction history from TSV
 * @param {string} exchange - Exchange name (default: coinbase)
 * @returns {Array} Transaction records
 */
const loadTransactionHistory = (exchange = 'coinbase') => {
  const logFile = getLogFile(exchange);

  if (!fs.existsSync(logFile)) {
    return [];
  }

  const content = fs.readFileSync(logFile, 'utf8');
  const lines = content.trim().split('\n');

  if (lines.length <= 1) {
    return [];
  }

  const headers = lines[0].split('\t');
  return lines.slice(1).map(line => {
    const values = line.split('\t');
    const record = {};
    headers.forEach((header, i) => {
      record[header] = values[i] || '';
    });
    return record;
  });
};

/**
 * Log a message to console with timestamp
 * @param {string} level - Log level (INFO, WARN, ERROR)
 * @param {string} message - Log message
 * @param {Object} data - Optional data to include
 */
const log = (level, message, data = null) => {
  const timestamp = new Date().toISOString();
  const prefix = `[${timestamp}] [${level}]`;

  if (data) {
    console.log(`${prefix} ${message}`, JSON.stringify(data));
  } else {
    console.log(`${prefix} ${message}`);
  }
};

module.exports = {
  logTransaction,
  logBuy,
  logSellOrder,
  logSellFilled,
  loadTransactionHistory,
  log,
  getLogFile,
};
