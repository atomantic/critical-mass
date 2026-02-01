/**
 * Type definitions for DCA Bot
 *
 * This file contains JSDoc type definitions for the core data structures
 * used throughout the DCA bot. Enable @ts-check in your files to benefit
 * from type checking.
 */

// ============================================================================
// Interval Types
// ============================================================================

/**
 * @typedef {'5min' | '10min' | '30min' | '1hour' | '4hour' | 'daily'} IntervalType
 */

/**
 * @typedef {Object} IntervalDefinition
 * @property {number} ms - Interval duration in milliseconds
 * @property {string} label - Human-readable label
 * @property {number} granularity - Candle granularity in seconds
 * @property {number} aggregateFactor - Factor for aggregating smaller candles
 */

// ============================================================================
// Configuration Types
// ============================================================================

/**
 * @typedef {'never' | 'daily' | 'weekly'} ConsolidateIntervalType
 */

/**
 * @typedef {Object} ExchangeConfig
 * @property {string} productId - Trading pair (e.g., 'BTC-USDC', 'BTCUSD')
 * @property {number} totalAllocation - Total amount to allocate in quote currency
 * @property {number} intervalsToSpread - Number of intervals to spread purchases over
 * @property {IntervalType} intervalType - Type of interval for DCA
 * @property {number} sellMarkupPercent - Markup percentage for sell orders
 * @property {number} holdbackPercent - Percentage of BTC to hold in reserves
 * @property {number} minOrderSize - Minimum order size in quote currency
 * @property {number} maxBuyPrice - Maximum price to buy at
 * @property {boolean} enabled - Whether this exchange is enabled
 * @property {boolean} dryRun - Whether to simulate trades
 * @property {number} [consolidateAfterOrders] - Auto-consolidate when pending orders exceed this count (0 = disabled)
 * @property {ConsolidateIntervalType} [consolidateInterval] - How often to run interval-based consolidation ('never', 'daily', 'weekly')
 * @property {'fixed' | 'fibonacci'} [dcaStrategy] - DCA strategy (default: 'fixed')
 * @property {number} [fibBaseAmount] - Base amount for Fibonacci multiplier (default: 10)
 */

/**
 * @typedef {Object} GlobalConfig
 * @property {number} schedulerInterval - Scheduler interval in milliseconds
 */

/**
 * @typedef {Object} MultiExchangeConfig
 * @property {Object<string, ExchangeConfig>} exchanges - Exchange configurations by name
 * @property {GlobalConfig} global - Global configuration settings
 */

/**
 * @typedef {Object} ValidationResult
 * @property {boolean} valid - Whether the configuration is valid
 * @property {string[]} errors - List of validation errors
 */

// ============================================================================
// State Types
// ============================================================================

/**
 * @typedef {'pending' | 'filled' | 'consolidated'} OrderStatus
 */

/**
 * @typedef {Object} TrackedOrder
 * @property {string} orderId - Sell order ID
 * @property {string} buyOrderId - Original buy order ID
 * @property {number} buyPrice - Price paid for BTC
 * @property {number} buyQuantityBTC - Amount of BTC bought
 * @property {number} buyUSDC - Amount of USDC spent
 * @property {number} buyFees - Fees paid on buy
 * @property {number} buyRebates - Rebates received on buy
 * @property {number} buyNetFees - Net fees on buy (fees - rebates)
 * @property {number} buyCostBasis - Total cost basis including fees
 * @property {number} sellPrice - Limit price for sell order
 * @property {number} sellQuantityBTC - Amount of BTC to sell
 * @property {number} holdbackBTC - Amount of BTC held in reserves
 * @property {OrderStatus} status - Order status
 * @property {string} createdAt - ISO timestamp when order was created
 * @property {string} [filledAt] - ISO timestamp when order was filled
 * @property {number} [actualFillValue] - Actual value received when filled
 * @property {number} [sellFees] - Fees paid on sell
 * @property {number} [sellRebates] - Rebates received on sell
 * @property {number} [sellNetFees] - Net fees on sell
 * @property {number} [netProceeds] - Net proceeds after fees
 * @property {string} [consolidatedInto] - Order ID of the consolidated order (for original orders)
 * @property {string} [consolidatedAt] - ISO timestamp when order was consolidated
 * @property {boolean} [isConsolidated] - Whether this order is a consolidated order
 * @property {string[]} [sourceOrderIds] - Original order IDs that were consolidated (for consolidated orders)
 */

/**
 * @typedef {Object} BotState
 * @property {number} initialAllocation - Initial allocation amount
 * @property {number} totalAllocated - Total amount allocated so far
 * @property {number} totalIntervalsRun - Number of intervals completed
 * @property {number} usdcFundSize - Current fund size in quote currency
 * @property {number} btcReserves - BTC held in reserves
 * @property {number} outstandingOrdersUSDC - Expected USDC from pending sells
 * @property {number} outstandingOrdersBTC - BTC in pending sell orders
 * @property {number} totalFees - Cumulative fees paid
 * @property {number} totalRebates - Cumulative rebates received
 * @property {number} netFees - Cumulative net fees
 * @property {string|null} lastRunId - Identifier for last run
 * @property {number|null} lastRunTimestamp - Timestamp of last run
 * @property {TrackedOrder[]} orders - List of tracked orders
 * @property {string|null} [lastConsolidationId] - Identifier for last consolidation run
 * @property {number|null} [lastConsolidationTimestamp] - Timestamp of last consolidation
 * @property {number} [fibPosition] - Current Fibonacci sequence position (0-indexed)
 * @property {number} [fibCycleStartTime] - Timestamp when Fibonacci cycle started
 * @property {number} [fibCumulativeCost] - Total cost basis for current Fibonacci cycle
 * @property {number} [fibCumulativeBTC] - Total BTC accumulated in current Fibonacci cycle
 * @property {string|null} [fibActiveSellOrderId] - Active consolidated sell order ID for Fibonacci cycle
 */

/**
 * @typedef {Object} AllocationInfo
 * @property {number} remaining - Remaining allocation
 * @property {number} intervalAmount - Amount per interval
 */

// ============================================================================
// Account Balance Types
// ============================================================================

/**
 * @typedef {Object} AccountBalance
 * @property {number} available - Available balance
 * @property {number} hold - Balance on hold
 * @property {number} total - Total balance
 */

// ============================================================================
// Product Types
// ============================================================================

/**
 * @typedef {Object} ProductDetails
 * @property {string} baseIncrement - Minimum base currency increment
 * @property {string} quoteIncrement - Minimum quote currency increment
 * @property {string} baseMinSize - Minimum order size in base currency
 * @property {string} quoteMinSize - Minimum order size in quote currency
 * @property {number} price - Current price
 */

// ============================================================================
// Order Types
// ============================================================================

/**
 * @typedef {Object} MarketBuyResult
 * @property {string} orderId - Order ID from exchange
 * @property {string} clientOrderId - Client-generated order ID
 * @property {boolean} success - Whether order was placed successfully
 * @property {string} [errorMessage] - Error message if order failed
 */

/**
 * @typedef {Object} LimitSellResult
 * @property {string} orderId - Order ID from exchange
 * @property {string} clientOrderId - Client-generated order ID
 * @property {boolean} success - Whether order was placed successfully
 * @property {string} [errorMessage] - Error message if order failed
 * @property {number} baseSize - Amount of base currency in order
 * @property {number} limitPrice - Limit price for the order
 */

/**
 * @typedef {Object} OrderDetails
 * @property {string} orderId - Order ID
 * @property {string} productId - Product ID
 * @property {string} side - Order side (BUY or SELL)
 * @property {string} status - Order status (OPEN, FILLED, CANCELLED, etc.)
 * @property {number} filledSize - Amount filled
 * @property {number} filledValue - Value of filled amount
 * @property {number} averageFilledPrice - Average fill price
 * @property {number} completionPercentage - Percentage completed
 * @property {number} totalFees - Total fees for order
 * @property {string} createdTime - ISO timestamp when order was created
 */

/**
 * @typedef {Object} OpenOrder
 * @property {string} orderId - Order ID
 * @property {string} productId - Product ID
 * @property {string} side - Order side
 * @property {string} status - Order status
 * @property {number} filledSize - Amount filled
 * @property {string} createdTime - ISO timestamp
 */

/**
 * @typedef {Object} CancelResult
 * @property {boolean} success - Whether cancellation was successful
 */

// ============================================================================
// Fill Types
// ============================================================================

/**
 * @typedef {Object} OrderFill
 * @property {string} tradeId - Trade ID
 * @property {string} orderId - Order ID
 * @property {string} productId - Product ID
 * @property {string} side - Trade side
 * @property {number} price - Fill price
 * @property {number} size - Fill size in base currency
 * @property {number} sizeInQuote - Fill size in quote currency
 * @property {number} commission - Commission charged
 * @property {number} totalCommission - Total commission
 * @property {number} rebate - Rebate received
 * @property {number} netFee - Net fee (commission - rebate)
 * @property {string} tradeTime - ISO timestamp of trade
 * @property {string} liquidityIndicator - MAKER or TAKER
 */

/**
 * @typedef {Object} FillSummary
 * @property {number} totalSize - Total size filled
 * @property {number} totalValue - Total value filled
 * @property {number} totalFees - Total fees paid
 * @property {number} totalRebates - Total rebates received
 * @property {number} netFees - Net fees (totalFees - totalRebates)
 * @property {number} fillCount - Number of fills
 * @property {number} averagePrice - Average fill price
 * @property {OrderFill[]} fills - Individual fills
 */

// ============================================================================
// Buy/Sell Result Types
// ============================================================================

/**
 * @typedef {Object} BuyResult
 * @property {string} orderId - Order ID
 * @property {number} price - Average fill price
 * @property {number} btcAmount - Amount of BTC purchased
 * @property {number} usdcAmount - Amount of USDC spent
 * @property {number} fees - Fees paid
 * @property {number} rebates - Rebates received
 * @property {number} netFees - Net fees
 * @property {number} actualCost - Actual cost including fees
 * @property {string} status - Order status
 * @property {OrderFill[]} fills - Individual fills
 */

/**
 * @typedef {Object} SellOrder
 * @property {string} orderId - Order ID
 * @property {string} clientOrderId - Client order ID
 * @property {boolean} success - Whether order was placed successfully
 * @property {string} [errorMessage] - Error message if failed
 * @property {number} baseSize - Amount of BTC to sell
 * @property {number} limitPrice - Limit price for sell
 */

/**
 * @typedef {Object} FilledSellOrder
 * @property {string} orderId - Order ID
 * @property {number} filledSize - Amount filled
 * @property {number} fillValue - Value of fill
 * @property {number} averageFilledPrice - Average price
 * @property {number} fees - Fees paid
 * @property {number} rebates - Rebates received
 * @property {number} netFees - Net fees
 * @property {number} netProceeds - Net proceeds after fees
 * @property {TrackedOrder} originalOrder - Original tracked order
 */

// ============================================================================
// Candle Types
// ============================================================================

/**
 * @typedef {Object} Candle
 * @property {number} timestamp - Timestamp in milliseconds
 * @property {number} open - Open price
 * @property {number} high - High price
 * @property {number} low - Low price
 * @property {number} close - Close price
 * @property {number} volume - Volume
 */

// ============================================================================
// Cycle Result Types
// ============================================================================

/**
 * @typedef {Object} CycleResult
 * @property {string} status - Result status
 * @property {string} exchange - Exchange name
 * @property {boolean} [dryRun] - Whether this was a dry run
 * @property {IntervalType} [intervalType] - Interval type
 * @property {BuyResult} [buyResult] - Buy result if successful
 * @property {SellOrder} [sellOrder] - Sell order if successful
 * @property {number} [holdbackBTC] - BTC held back
 * @property {Object} [state] - State summary
 * @property {number} [currentPrice] - Current price if price check
 * @property {number} [maxBuyPrice] - Max buy price if price too high
 * @property {string} [lastRunId] - Last run ID if already ran
 */

/**
 * @typedef {Object} StatusResult
 * @property {string} exchange - Exchange name
 * @property {number} currentPrice - Current price
 * @property {Object} config - Config summary
 * @property {Object} state - State summary
 * @property {number} recentFills - Number of recent fills
 */

// ============================================================================
// Fibonacci Strategy Types
// ============================================================================

/**
 * @typedef {Object} FibonacciFillDetails
 * @property {string} orderId - Order ID
 * @property {number} filledSize - Amount of BTC filled
 * @property {number} fillValue - Value of fill in quote currency
 * @property {number} averageFilledPrice - Average fill price
 * @property {number} fees - Fees paid
 * @property {number} rebates - Rebates received
 * @property {number} netFees - Net fees
 * @property {number} netProceeds - Net proceeds after fees
 * @property {number} realizedProfit - Profit from cycle
 * @property {number} cyclePosition - Final Fibonacci position of cycle
 * @property {number} cycleBuys - Number of buys in cycle
 */

/**
 * @typedef {Object} FibonacciCycleInfo
 * @property {number} position - Current Fibonacci sequence position
 * @property {number} cumulativeCost - Total cost basis
 * @property {number} cumulativeBTC - Total BTC accumulated
 * @property {number} avgCostBasis - Weighted average cost basis per BTC
 * @property {string|null} activeSellOrderId - Active sell order ID
 * @property {number|null} cycleStartTime - When cycle started
 */

// ============================================================================
// API Credentials Types
// ============================================================================

/**
 * @typedef {Object} ApiCredentials
 * @property {string} apiKey - API key
 * @property {string} apiSecret - API secret
 */

// ============================================================================
// Transaction Log Types
// ============================================================================

/**
 * @typedef {'BUY' | 'SELL_ORDER' | 'SELL_FILLED' | 'CONSOLIDATE' | 'FIB_BUY' | 'FIB_SELL_ORDER' | 'FIB_SELL_FILLED'} TransactionType
 */

/**
 * @typedef {Object} TransactionDetails
 * @property {number} price - Transaction price
 * @property {number} btcAmount - BTC amount (negative for sells)
 * @property {number} usdcAmount - USDC amount (negative for buys)
 * @property {number} [fees] - Transaction fees
 * @property {number} [rebates] - Transaction rebates
 * @property {number} [netFees] - Net fees
 * @property {string} [orderId] - Order ID
 */

/**
 * @typedef {Object} TransactionRecord
 * @property {string} Date - Transaction date
 * @property {string} Type - Transaction type
 * @property {string} Price - Price as string
 * @property {string} 'BTC Amount' - BTC amount as string
 * @property {string} 'USDC Amount' - USDC amount as string
 * @property {string} Fees - Fees as string
 * @property {string} Rebates - Rebates as string
 * @property {string} 'Net Fees' - Net fees as string
 * @property {string} 'Order ID' - Order ID
 * @property {string} 'Fund Size' - Fund size as string
 * @property {string} 'BTC Reserves' - BTC reserves as string
 * @property {string} 'Outstanding USDC' - Outstanding USDC as string
 * @property {string} 'Outstanding BTC' - Outstanding BTC as string
 * @property {string} 'Total Fees' - Total fees as string
 * @property {string} 'Total Rebates' - Total rebates as string
 */

// ============================================================================
// Adapter Interface Type
// ============================================================================

/**
 * @typedef {Object} ExchangeAdapter
 * @property {string} name - Exchange name
 * @property {() => boolean} hasValidKeys - Check if keys are valid
 * @property {() => ApiCredentials} loadCredentials - Load API credentials
 * @property {(currency: string) => Promise<AccountBalance>} getAccountBalance - Get account balance
 * @property {(productId: string) => Promise<number>} getCurrentPrice - Get current price
 * @property {(productId: string) => Promise<ProductDetails>} getProductDetails - Get product details
 * @property {(productId: string, quoteAmount: number) => Promise<MarketBuyResult>} placeMarketBuy - Place market buy
 * @property {(productId: string, baseAmount: number, price: number) => Promise<LimitSellResult>} placeLimitSell - Place limit sell
 * @property {(orderId: string) => Promise<OrderDetails>} getOrder - Get order details
 * @property {(productId: string) => Promise<OpenOrder[]>} getOpenOrders - Get open orders
 * @property {(orderId: string) => Promise<CancelResult>} cancelOrder - Cancel an order
 * @property {(orderId: string) => Promise<OrderFill[]>} getOrderFills - Get order fills
 * @property {(orderId: string) => Promise<FillSummary>} getOrderFillSummary - Get fill summary
 * @property {(productId: string, start: number, end: number, granularity: string) => Promise<Candle[]>} getCandles - Get candles
 */

// ============================================================================
// Consolidation Types
// ============================================================================

/**
 * @typedef {Object} ConsolidationResult
 * @property {boolean} success - Whether consolidation was successful
 * @property {string} [newOrderId] - New consolidated order ID
 * @property {number} [consolidatedPrice] - Weighted average sell price
 * @property {number} [consolidatedBTC] - Total BTC in consolidated order
 * @property {number} [consolidatedCount] - Number of orders consolidated
 * @property {string[]} [skippedOrderIds] - Order IDs skipped due to partial fills
 * @property {string[]} [cancelledOrderIds] - Order IDs that were cancelled
 * @property {string} [error] - Error message if consolidation failed
 */

// Export empty object to make this a module
module.exports = {};
