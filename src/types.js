/**
 * Type definitions for Critical Mass
 *
 * This file contains JSDoc type definitions for the core data structures
 * used throughout Critical Mass. Enable @ts-check in your files to benefit
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
 * @property {boolean} [simpleDcaEnabled] - Whether simple DCA strategies (fixed/fibonacci) are enabled (default: false)
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
 * @property {number} buyQuantity - Amount of BTC bought
 * @property {number} buyUSDC - Amount of USDC spent
 * @property {number} buyFees - Fees paid on buy
 * @property {number} buyRebates - Rebates received on buy
 * @property {number} buyNetFees - Net fees on buy (fees - rebates)
 * @property {number} buyCostBasis - Total cost basis including fees
 * @property {number} sellPrice - Limit price for sell order
 * @property {number} sellQuantity - Amount of BTC to sell
 * @property {number} holdbackAsset - Amount of BTC held in reserves
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
 * @property {number} assetReserves - BTC held in reserves
 * @property {number} outstandingOrdersUSDC - Expected USDC from pending sells
 * @property {number} outstandingOrdersAsset - BTC in pending sell orders
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
 * @property {number} [fibCumulativeAsset] - Total BTC accumulated in current Fibonacci cycle
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
 * @property {number} assetAmount - Amount of BTC purchased
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
 * @property {number} [holdbackAsset] - BTC held back
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
 * @property {number} cumulativeAsset - Total BTC accumulated
 * @property {number} avgCostBasis - Weighted average cost basis per BTC
 * @property {string|null} activeSellOrderId - Active sell order ID
 * @property {number|null} cycleStartTime - When cycle started
 */

// ============================================================================
// Regime Strategy Types
// ============================================================================

/**
 * @typedef {'HARVEST' | 'CAUTION' | 'TREND'} RegimeMode
 * Three trading modes based on market conditions:
 * - HARVEST: Mean-reverting, full inventory cycling
 * - CAUTION: Volatility rising, reduced scaling, wider TP
 * - TREND: Strong momentum, exit/manage only, no averaging down
 */

/**
 * @typedef {'ACTIVE' | 'SAFE' | 'PAUSED'} HealthMode
 * System health states:
 * - ACTIVE: Normal operation, entries allowed
 * - SAFE: Degraded conditions, entries blocked, TP orders maintained
 * - PAUSED: Manually paused by operator
 */

/**
 * @typedef {Object} MarketState
 * @property {number} lastPrice - Most recent trade price
 * @property {number} bid - Current best bid price
 * @property {number} ask - Current best ask price
 * @property {number} spread - Current spread (ask - bid)
 * @property {number} atr1m - 1-minute ATR value
 * @property {number} atr5m - 5-minute ATR value
 * @property {number} realizedVol - Rolling realized volatility
 * @property {number} volBaseline - EMA baseline of realized volatility
 * @property {number} vwap - Volume-weighted average price
 * @property {number} vwapDistance - Distance from VWAP in ATR units
 * @property {number} recentSwing - Recent price swing range
 * @property {number} tradeImbalance - Buy/sell imbalance (-1 to +1)
 * @property {{magnitude: number, direction: 'up' | 'down' | 'neutral'}} momentum - Price momentum indicator
 * @property {Array<{price: number, size: number, side: string, timestamp: number}>} trades - Recent trades
 * @property {number} lastUpdate - Timestamp of last market data update
 * @property {number} [ath] - All-time high price (for ladder mode)
 * @property {number} [athDistance] - Current distance from ATH (negative when below)
 * @property {number} [athLastUpdate] - Timestamp of last ATH fetch
 */

/**
 * @typedef {Object} RegimeState
 * @property {RegimeMode} mode - Current regime mode
 * @property {number} since - Timestamp when current regime started
 * @property {number} transitionCount - Number of regime transitions
 * @property {'up' | 'down' | null} trendDirection - Trend direction if in TREND mode
 * @property {number} lastVolExpansion - Last computed volatility expansion ratio
 * @property {number} lastMomentumMag - Last computed momentum magnitude
 * @property {number} trendConfirmationCount - Consecutive trend confirmations
 */

/**
 * @typedef {Object} RegimePositionState
 * @property {number} totalAsset - Total BTC in current cycle
 * @property {number} totalCostBasis - Total cost including fees
 * @property {number} avgCostBasis - Average cost per BTC
 * @property {number} cycleBuys - Number of buy orders filled in current cycle
 * @property {number} lastEntryPrice - Price of last entry
 * @property {number} lastEntryTime - Timestamp of last entry
 * @property {number} anchorPrice - Price anchor for volatility clock
 * @property {string|null} activeTpOrderId - Active take-profit order ID
 * @property {number} lastTpPrice - Last take-profit price placed
 * @property {number} cyclesCompleted - Number of completed inventory cycles
 * @property {number} unrealizedPnL - Current unrealized P&L
 * @property {number} realizedPnL - Cumulative realized P&L in USD
 * @property {number} realizedAssetPnL - Cumulative realized P&L in BTC (holdback reserves)
 * @property {number} assetOnOrder - BTC currently in open sell orders
 * @property {number} maxDrawdownSeen - Maximum drawdown observed
 * @property {boolean} scalingDisabled - Whether scaling is temporarily disabled
 * @property {string|null} scalingDisabledReason - Reason scaling is disabled
 * @property {MacroRegimeState|null} [macroRegime] - Macro regime state for persistence
 * @property {Array<{orderId: string, price: number, assetQty: number, sizeUsdc: number, placedAt: number}>} [pendingEntryOrders] - Pending entry orders persisted for recovery
 * @property {CelestialBody[]} [celestialBodies_legacy] - (removed, use celestialBodies)
 * @property {CelestialBody[]} [celestialBodies] - Active celestial bodies (replaces core+satellites)
 * @property {CelestialState} [celestialState] - Aggregate celestial tracking
 * @property {boolean} [ladderActive] - Whether ladder mode is active
 * @property {number|null} [ladderPlacedAt] - Timestamp when ladder was placed
 * @property {number} [ladderLowerBound] - Current ladder lower bound price
 * @property {Array<{orderId: string, price: number, sizeUsdc: number, ladderIndex: number}>} [pendingLadderOrders] - Pending ladder orders
 */

/**
 * @typedef {Object} HealthState
 * @property {HealthMode} mode - Current health mode
 * @property {number} since - Timestamp when current mode started
 * @property {string|null} reason - Reason for current mode
 * @property {Object} healthChecks - Health check statuses
 * @property {boolean} healthChecks.wsConnected - WebSocket connection status
 * @property {number} healthChecks.lastTickerMs - Age of last ticker in ms
 * @property {number} healthChecks.lastOrderUpdateMs - Age of last order update in ms
 * @property {number} healthChecks.restErrorCount - REST errors in window
 * @property {number} healthChecks.rateLimitCount - Rate limits in window
 * @property {number} healthChecks.avgLatencyMs - Average REST latency
 */

/**
 * @typedef {Object} PauseState
 * @property {boolean} spreadPaused - Paused due to wide spread
 * @property {number} spreadPausedUntil - Resume timestamp for spread pause
 * @property {number} lastSpreadBps - Last observed spread in bps
 * @property {boolean} depthPaused - Paused due to thin depth
 * @property {number} depthPausedUntil - Resume timestamp for depth pause
 */

/**
 * @typedef {Object} Fill
 * @property {string} tradeId - Exchange trade ID (primary key)
 * @property {string} orderId - Order ID
 * @property {'buy' | 'sell'} side - Trade side
 * @property {number} price - Fill price
 * @property {number} size - Fill size in BTC
 * @property {number} quoteAmount - Fill amount in USDC
 * @property {number} fee - Fee charged
 * @property {string} feeAsset - Fee asset ('USDC' or 'BTC')
 * @property {number} rebate - Maker rebate if any
 * @property {number} netFee - Net fee (fee - rebate)
 * @property {'MAKER' | 'TAKER'} liquidityIndicator - Maker or taker
 * @property {number} timestamp - Exchange timestamp
 * @property {number} ingestedAt - When fill was ingested
 * @property {string|null} cycleId - Trading cycle ID
 */

/**
 * @typedef {Object} PendingOrder
 * @property {'entry' | 'take_profit' | 'body_tp'} type - Order type
 * @property {number} price - Order price
 * @property {number} size - Order size
 * @property {number} sizeUsdc - Order size in USDC (for entries)
 * @property {number} placedAt - Timestamp when placed
 * @property {boolean} [recoveredFromExchange] - Whether recovered on startup
 */

// SatelliteTpOrder typedef removed — use CelestialBody instead

/**
 * @typedef {Object} CelestialTier
 * @property {string} name - Tier name (satellite, moon, planet, sun, hypergiant, galaxy, black_hole)
 * @property {string} emoji - Display emoji
 * @property {number} minMass - Minimum mass multiplier (× baseSizeUsdc)
 * @property {number} maxMass - Maximum mass multiplier
 * @property {number} tpMult - TP percentage multiplier
 * @property {number} tpMaxScale - Multiplied against tpMaxPercent for wider ceiling
 * @property {number} proximity - TP price proximity % for within-tier consolidation
 * @property {number} holdbackScale - Multiplied against holdbackRatio
 */

/**
 * @typedef {Object} CelestialBody
 * @property {string} id - Unique body ID (persists through promotions)
 * @property {string} tier - Tier name (satellite|moon|planet|sun|hypergiant|galaxy|black_hole)
 * @property {number} assetQty - Total BTC
 * @property {number} costBasis - Total cost basis including fees ($)
 * @property {number} avgPrice - costBasis / assetQty
 * @property {string|null} tpOrderId - Exchange sell order ID
 * @property {number} tpPrice - Current TP price
 * @property {number} assetOnOrder - BTC in sell order (after holdback)
 * @property {number} createdAt - First creation timestamp
 * @property {number} lastMergedAt - Last merge/promotion timestamp
 * @property {string[]} sourceOrderIds - All constituent buy order IDs
 * @property {number} mergeCount - Number of merges undergone
 */

/**
 * @typedef {Object} CelestialState
 * @property {number} bodiesCompleted - Total body TP fills (all time)
 * @property {number} bodiesRealizedPnL - Cumulative USD P&L
 * @property {number} bodiesRealizedAssetPnL - Cumulative BTC holdback reserves
 * @property {number} stateVersion - Schema version
 */

/**
 * @typedef {Object} RegimeStrategyConfig
 * Mode Flags
 * @property {boolean} enabled - Whether regime engine is enabled (default: false)
 * Note: dryRun is read from exchange-level config (ExchangeConfig.dryRun), not here
 * @property {'conservative'|'moderate'|'aggressive'|'maximum'} [aggressiveness] - Aggressiveness preset (default: 'moderate')
 *
 * Volatility Clock Parameters
 * @property {number} atrPeriod - Periods for ATR calculation (default: 14)
 * @property {number} kFactor - ATR multiplier for entry trigger (default: 0.6)
 * @property {number} minIntervalMs - Minimum time between entries (default: 60000)
 * @property {number} maxIntervalMs - Maximum time between entries (default: 3600000)
 *
 * Regime Detection Parameters
 * @property {number} momentumMult - Momentum threshold multiplier (default: 1.5)
 * @property {number} volExpansionMult - RV/baseline for CAUTION (default: 1.5)
 * @property {number} volContractionMult - RV/baseline to return to HARVEST (default: 1.2)
 * @property {number} vwapPeriodHours - VWAP calculation window (default: 4)
 * @property {number} trendConfirmationPeriods - Periods to confirm TREND (default: 5)
 *
 * Position Sizing Parameters
 * @property {number} minOrderSizeUsdc - Minimum order size in USDC (default: 5)
 * @property {number} baseSizeUsdc - Base order size in USDC (default: 50)
 * @property {number} harvestScale - Size multiplier in HARVEST (default: 1.0)
 * @property {number} cautionScale - Size multiplier in CAUTION (default: 0.5)
 * @property {number} trendScale - Size multiplier in TREND (default: 0.0)
 * @property {number} maxCycleBuys - Maximum buys per cycle (default: 10)
 * @property {number} cycleResetHours - Hours after which to auto-reset cycle buys at max (default: 72, 0 to disable)
 * @property {number} liquidityFactorCap - Maximum liquidity multiplier (default: 2.0)
 * @property {number} divergenceScalePct - Price divergence % from avg cost at which liquidity factor reaches cap (default: 5)
 *
 * Take-Profit Parameters
 * @property {number} tpMult - TP distance multiplier (default: 1.0)
 * @property {number} tpMinPercent - Minimum TP percentage (default: 2.0)
 * @property {number} tpMaxPercent - Maximum TP percentage (default: 15.0)
 * @property {number} tpUpdateThresholdPct - Min % change to update TP (default: 0.5)
 * @property {number} holdbackRatio - Ratio of position to hold vs sell (0.0-1.0, default: 0.5)
 *
 * Celestial Body Parameters (legacy satellite aliases removed)
 *
 * Risk Cap Parameters
 * @property {number} maxAssetExposure - Maximum asset position, 0 = uncapped (default: 0)
 * @property {number} depositedCapital - Total user deposits, 0 = auto-derive from maxUsdcDeployed - realizedPnL (default: 0)
 * @property {number} maxUsdcDeployed - Maximum USDC cap for trading, grows with profits (default: 10000)
 * @property {number} maxDrawdownPercent - Pause threshold (default: 20)
 * @property {number} drawdownResetHours - Hours after which to auto-reset peak during drawdown pause (default: 72, 0 to disable)
 *
 * Order Execution Parameters
 * @property {number} entryOffsetBps - Offset below mid for bids when momentum is neutral (default: 10)
 * @property {number} entryOffsetUpBps - Offset when momentum is UP, smaller to get fills before price rises (default: 5)
 * @property {number} entryOffsetDownBps - Offset when momentum is DOWN, larger to catch falling price (default: 15)
 * @property {number} entryMaxRetries - Max retries for post-only rejections in fast markets (default: 3)
 * @property {number} cancelRateLimitMs - Min time between cancels (default: 1000)
 * @property {number} orderStaleMs - Timeout for stale entry orders (default: 30000)
 *
 * System Health Parameters
 * @property {number} staleDataMs - Max age of market data (default: 30000)
 * @property {number} staleOrdersMs - Max age of order updates (default: 60000)
 * @property {number} maxRestErrors - REST errors to trigger SAFE (default: 5)
 * @property {number} maxRateLimits - Rate limits to trigger SAFE (default: 3)
 * @property {number} maxLatencyMs - Latency to trigger SAFE (default: 5000)
 * @property {number} safeRecoveryMs - Time healthy to exit SAFE (default: 60000)
 *
 * Invariant Parameters
 * @property {number} maxOpenOrders - Maximum concurrent orders (default: 3)
 * @property {number} reconcileIntervalMs - State reconciliation frequency (default: 300000)
 *
 * Tail Event Parameters
 * @property {number} maxSpreadBps - Spread pause threshold (default: 50)
 * @property {number} spreadPauseMs - Spread pause duration (default: 300000)
 * @property {number} minDepthUsdc - Minimum depth for entries (default: 10000)
 * @property {number} depthPauseMs - Depth pause duration (default: 300000)
 * @property {number} flashMoveMult - ATR multiple for flash detection (default: 3.0)
 * @property {number} flashCooldownMs - Flash move cooldown (default: 600000)
 * @property {boolean} cancelEntriesOnFlash - Cancel entries on flash (default: true)
 *
 * Entry Mode Parameters
 * @property {'reactive' | 'ladder'} [entryMode] - Entry strategy mode (default: 'reactive')
 *
 * Ladder Parameters (when entryMode: 'ladder')
 * @property {number} [ladderMaxAthDropPct] - Floor = ATH × (1 - this/100). 80 means lowest bid at 20% of ATH (default: 80)
 * @property {'linear' | 'sqrt' | 'exponential'} [ladderSpacingMode] - Price level spacing (default: 'sqrt')
 * @property {'flat' | 'linear' | 'sqrt' | 'fibonacci'} [ladderSizeMode] - Size allocation mode (default: 'fibonacci')
 * @property {boolean} [ladderAutoSwitch] - Auto-switch to ladder on high vol (default: false)
 * @property {number} [ladderAutoSwitchVolMult] - Vol expansion threshold for auto-switch (default: 2.0)
 * @property {number} [ladderMinSpacingPct] - Min % between rungs (default: 0.5)
 */

/**
 * @typedef {Object} LimitBuyResult
 * @property {string} orderId - Order ID from exchange
 * @property {string} clientOrderId - Client-generated order ID
 * @property {boolean} success - Whether order was placed successfully
 * @property {string} [errorMessage] - Error message if order failed
 * @property {number} baseSize - Amount of base currency in order
 * @property {number} limitPrice - Limit price for the order
 * @property {boolean} [postOnly] - Whether order was post-only
 */

/**
 * @typedef {Object} EntryCheckResult
 * @property {boolean} allowed - Whether entry is allowed
 * @property {string|null} reason - Reason if not allowed
 */

/**
 * @typedef {Object} VolatilityMetrics
 * @property {number} atr - Average True Range
 * @property {number} realizedVol - Realized volatility
 * @property {number} volExpansion - Volatility expansion ratio
 * @property {number} vwap - Volume-weighted average price
 * @property {number} recentSwing - Recent swing range
 */

// ============================================================================
// Macro Regime Types
// ============================================================================

/**
 * @typedef {'ACCUMULATION' | 'RANGING' | 'MARKUP' | 'DECLINE'} MacroRegimeMode
 * Four macro market states based on multi-timeframe EMA analysis:
 * - ACCUMULATION: Price below key EMAs, in a dip zone — increase sizing
 * - RANGING: No clear trend, consolidation — normal behavior (passthrough)
 * - MARKUP: Sustained uptrend above EMAs — reduce sizing, wider TP
 * - DECLINE: Steep multi-day drop, capitulation risk — conservative sizing
 */

/**
 * @typedef {Object} MacroRegimeState
 * @property {MacroRegimeMode} mode - Current macro mode
 * @property {number} score - Current composite score (-100 to +100)
 * @property {{h21: number, h50: number, h200: number, d20: number}} emas - EMA values
 * @property {number} lastUpdate - Timestamp of last macro update
 * @property {{hourly: number, daily: number}} candles - Number of candles used
 */

/**
 * @typedef {Object} MacroMultipliers
 * @property {number} sizeMult - Position size multiplier
 * @property {number} tpMult - Take-profit multiplier
 * @property {number} offsetMult - Entry offset multiplier
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
 * @property {number} assetAmount - BTC amount (negative for sells)
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
 * @property {(productId: string) => Promise<{bid: number, ask: number}>} getBidAsk - Get current bid/ask
 * @property {(productId: string) => Promise<ProductDetails>} getProductDetails - Get product details
 * @property {(productId: string, quoteAmount: number) => Promise<MarketBuyResult>} placeMarketBuy - Place market buy
 * @property {(productId: string, baseAmount: number, price: number, options?: {postOnly?: boolean}) => Promise<LimitSellResult>} placeLimitSell - Place limit sell
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
 * @property {number} [consolidatedAsset] - Total BTC in consolidated order
 * @property {number} [consolidatedCount] - Number of orders consolidated
 * @property {string[]} [skippedOrderIds] - Order IDs skipped due to partial fills
 * @property {string[]} [cancelledOrderIds] - Order IDs that were cancelled
 * @property {string} [error] - Error message if consolidation failed
 */

// Export empty object to make this a module
module.exports = {};
