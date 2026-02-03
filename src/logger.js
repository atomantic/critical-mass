// @ts-check
const fs = require('fs');
const path = require('path');
const { getExchangeDataDir } = require('./migration');

/**
 * @typedef {import('./types').BotState} BotState
 * @typedef {import('./types').BuyResult} BuyResult
 * @typedef {import('./types').SellOrder} SellOrder
 * @typedef {import('./types').FilledSellOrder} FilledSellOrder
 * @typedef {import('./types').TransactionType} TransactionType
 * @typedef {import('./types').TransactionDetails} TransactionDetails
 * @typedef {import('./types').TransactionRecord} TransactionRecord
 * @typedef {import('./types').ConsolidationResult} ConsolidationResult
 * @typedef {import('./types').FibonacciFillDetails} FibonacciFillDetails
 * @typedef {import('./types').FibonacciCycleInfo} FibonacciCycleInfo
 */

/**
 * Get log file path for an exchange
 * @param {string} [exchange] - Exchange name (default: coinbase)
 * @returns {string} Path to transactions log file
 */
const getLogFile = (exchange = 'coinbase') => {
  const dir = getExchangeDataDir(exchange);
  return path.join(dir, 'transactions.tsv');
};

const HEADERS = [
  'Timestamp',
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
 * Ensure log file exists with headers, migrate old schema if needed
 * @param {string} [exchange] - Exchange name
 * @returns {void}
 */
const ensureLogFile = (exchange = 'coinbase') => {
  const logFile = getLogFile(exchange);
  const dir = path.dirname(logFile);

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  if (!fs.existsSync(logFile)) {
    fs.writeFileSync(logFile, HEADERS.join('\t') + '\n');
    return;
  }

  // Check if migration is needed (old schema missing Timestamp column)
  const content = fs.readFileSync(logFile, 'utf8');
  const lines = content.split('\n');
  const existingHeaders = lines[0].split('\t');

  if (existingHeaders[0] !== 'Timestamp' && existingHeaders[0] === 'Date') {
    // Migrate: add Timestamp column to headers and blank values to existing rows
    const expectedColumnCount = existingHeaders.length;
    const newLines = lines.map((line, i) => {
      if (i === 0) {
        return 'Timestamp\t' + line;
      }
      if (line.trim() === '') return line;
      // Validate row has expected column count before prepending
      const columns = line.split('\t');
      if (columns.length !== expectedColumnCount) return line;
      // For existing data rows, add empty Timestamp (we don't have that info)
      return '\t' + line;
    });
    fs.writeFileSync(logFile, newLines.join('\n'));
  }
};

/**
 * Format a number for TSV output
 * @param {number|null|undefined} value - Value to format
 * @param {number} [decimals] - Decimal places
 * @returns {string}
 */
const formatNumber = (value, decimals = 8) => {
  if (value === null || value === undefined) return '';
  return parseFloat(value).toFixed(decimals);
};

/**
 * Log a transaction to the TSV file (includes fee tracking)
 * @param {TransactionType} type - Transaction type (BUY, SELL_ORDER, SELL_FILLED)
 * @param {TransactionDetails} details - Transaction details including fees
 * @param {BotState} state - Current state after transaction
 * @param {string} [exchange] - Exchange name (default: coinbase)
 * @returns {void}
 */
const logTransaction = (type, details, state, exchange = 'coinbase') => {
  ensureLogFile(exchange);
  const logFile = getLogFile(exchange);

  const now = new Date();
  const row = [
    now.toISOString(),
    now.toISOString().split('T')[0],
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
 * @param {BuyResult} buyDetails - Buy order details with fees
 * @param {BotState} state - Current state
 * @param {string} [exchange] - Exchange name (default: coinbase)
 * @returns {void}
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
 * @param {SellOrder} sellOrder - Sell order details
 * @param {BotState} state - Current state
 * @param {string} [exchange] - Exchange name (default: coinbase)
 * @returns {void}
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
 * @param {FilledSellOrder} fillDetails - Fill details with fees
 * @param {BotState} state - Current state
 * @param {string} [exchange] - Exchange name (default: coinbase)
 * @returns {void}
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
 * @param {string} [exchange] - Exchange name (default: coinbase)
 * @returns {TransactionRecord[]} Transaction records
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

const LOG_EMOJI = {
  INFO: 'ℹ️',
  WARN: '⚠️',
  ERROR: '❌',
};

/**
 * Log a message to console with emoji prefix (pm2 handles timestamps)
 * @param {'INFO' | 'WARN' | 'ERROR'} level - Log level
 * @param {string} message - Log message
 * @param {Object|null} [data] - Optional data to include
 * @returns {void}
 */
const log = (level, message, data = null) => {
  const emoji = LOG_EMOJI[level] || 'ℹ️';
  const output = data ? `${emoji} ${message} ${JSON.stringify(data)}` : `${emoji} ${message}`;
  console.log(output);
};

/**
 * Log a consolidation transaction
 * @param {ConsolidationResult} consolidation - Consolidation result
 * @param {BotState} state - Current state after consolidation
 * @param {string} [exchange] - Exchange name (default: coinbase)
 * @returns {void}
 */
const logConsolidation = (consolidation, state, exchange = 'coinbase') => {
  logTransaction('CONSOLIDATE', {
    price: consolidation.consolidatedPrice,
    btcAmount: consolidation.consolidatedBTC,
    usdcAmount: consolidation.consolidatedBTC * consolidation.consolidatedPrice,
    orderId: consolidation.newOrderId,
  }, state, exchange);
};

/**
 * Log a Fibonacci buy transaction
 * @param {BuyResult} buyDetails - Buy order details with fees
 * @param {BotState} state - Current state
 * @param {FibonacciCycleInfo} cycleInfo - Fibonacci cycle information
 * @param {string} [exchange] - Exchange name (default: coinbase)
 * @returns {void}
 */
const logFibBuy = (buyDetails, state, cycleInfo, exchange = 'coinbase') => {
  logTransaction('FIB_BUY', {
    price: buyDetails.price,
    btcAmount: buyDetails.btcAmount,
    usdcAmount: -buyDetails.usdcAmount,
    fees: buyDetails.fees || 0,
    rebates: buyDetails.rebates || 0,
    netFees: buyDetails.netFees || 0,
    orderId: buyDetails.orderId,
  }, state, exchange);

  log('INFO', `[${exchange}] Fib position ${cycleInfo.position}: bought ${buyDetails.btcAmount.toFixed(8)} @ $${buyDetails.price.toFixed(2)}, cycle total: ${cycleInfo.cumulativeBTC.toFixed(8)} BTC, avg cost: $${cycleInfo.avgCostBasis.toFixed(2)}`);
};

/**
 * Log a Fibonacci sell order placement
 * @param {SellOrder} sellOrder - Sell order details
 * @param {BotState} state - Current state
 * @param {FibonacciCycleInfo} cycleInfo - Fibonacci cycle information
 * @param {string} [exchange] - Exchange name (default: coinbase)
 * @returns {void}
 */
const logFibSellOrder = (sellOrder, state, cycleInfo, exchange = 'coinbase') => {
  logTransaction('FIB_SELL_ORDER', {
    price: sellOrder.limitPrice,
    btcAmount: -sellOrder.baseSize,
    usdcAmount: sellOrder.baseSize * sellOrder.limitPrice,
    orderId: sellOrder.orderId,
  }, state, exchange);

  log('INFO', `[${exchange}] Fib cycle sell order: ${sellOrder.baseSize.toFixed(8)} BTC @ $${sellOrder.limitPrice.toFixed(2)} (position ${cycleInfo.position})`);
};

/**
 * Log a filled Fibonacci cycle sell order
 * @param {FibonacciFillDetails} fillDetails - Fill details with fees
 * @param {BotState} state - Current state
 * @param {number} cyclePosition - Final position of the cycle
 * @param {string} [exchange] - Exchange name (default: coinbase)
 * @returns {void}
 */
const logFibSellFilled = (fillDetails, state, cyclePosition, exchange = 'coinbase') => {
  logTransaction('FIB_SELL_FILLED', {
    price: fillDetails.averageFilledPrice,
    btcAmount: -fillDetails.filledSize,
    usdcAmount: fillDetails.netProceeds || fillDetails.fillValue,
    fees: fillDetails.fees || 0,
    rebates: fillDetails.rebates || 0,
    netFees: fillDetails.netFees || 0,
    orderId: fillDetails.orderId,
  }, state, exchange);

  log('INFO', `[${exchange}] Fib cycle complete! Sold ${fillDetails.filledSize.toFixed(8)} BTC @ $${fillDetails.averageFilledPrice.toFixed(2)} for $${fillDetails.netProceeds.toFixed(2)} (${cyclePosition} buys in cycle)`);
};

module.exports = {
  logTransaction,
  logBuy,
  logSellOrder,
  logSellFilled,
  logConsolidation,
  loadTransactionHistory,
  log,
  getLogFile,
  // Fibonacci logging
  logFibBuy,
  logFibSellOrder,
  logFibSellFilled,
};
