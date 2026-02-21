/**
 * Kalshi API TypeScript definitions (as JSDoc for JavaScript)
 * These types provide IDE autocompletion and type checking
 */

// ============ Environment & Auth ============

/** @typedef {'demo' | 'prod'} KalshiEnvironment */

/**
 * @typedef {Object} KalshiKeys
 * @property {string} keyId - API key identifier
 * @property {string} privateKeyPem - RSA private key in PEM format
 * @property {KalshiEnvironment} environment - API environment
 */

/**
 * @typedef {Object} KeyValidationResult
 * @property {boolean} valid - Whether keys are valid
 * @property {string[]} errors - Validation error messages
 */

// ============ Market Types ============

/** @typedef {'crypto' | 'sports' | 'other'} MarketType */
/** @typedef {'15min' | 'hourly' | '6hour' | 'daily' | 'weekly' | 'game' | 'unknown'} MarketTimeframe */
/** @typedef {'BTC'} CryptoAsset */
/** @typedef {'NFL' | 'NBA' | 'MLB' | 'NHL' | 'NCAAF' | 'NCAAB' | 'MLS' | 'SOCCER'} SportsLeague */

/**
 * @typedef {Object} MarketClassification
 * @property {MarketType} type - Market type
 * @property {CryptoAsset} [asset] - Crypto asset (if crypto)
 * @property {SportsLeague} [sport] - Sports league (if sports)
 * @property {MarketTimeframe} timeframe - Market timeframe
 */

/**
 * @typedef {Object} KalshiMarket
 * @property {string} ticker - Market ticker
 * @property {string} event_ticker - Parent event ticker
 * @property {string} title - Market title
 * @property {string} subtitle - Market subtitle
 * @property {string} status - Market status (active, closed, settled)
 * @property {string} open_time - ISO timestamp when market opened
 * @property {string} close_time - ISO timestamp when market closes
 * @property {string} [expiration_time] - ISO timestamp when market expires
 * @property {number} [yes_bid] - Best yes bid price (cents)
 * @property {number} [yes_ask] - Best yes ask price (cents)
 * @property {number} [no_bid] - Best no bid price (cents)
 * @property {number} [no_ask] - Best no ask price (cents)
 * @property {number} [last_price] - Last trade price (cents)
 * @property {number} [volume] - 24h volume
 * @property {number} [volume_24h] - 24h volume (alternate field)
 * @property {number} [open_interest] - Open interest
 */

/** @typedef {KalshiMarket & MarketClassification} ClassifiedMarket */

/**
 * @typedef {Object} Orderbook
 * @property {Array<[number, number]>} yes - Yes side [price, quantity] pairs
 * @property {Array<[number, number]>} no - No side [price, quantity] pairs
 */

/** @typedef {ClassifiedMarket & { orderbook: Orderbook }} MarketWithDetails */

/**
 * @typedef {Object} ImpliedProbability
 * @property {number} yes - Yes probability (0-1)
 * @property {number} no - No probability (0-1)
 * @property {number} spread - Market spread/vig
 */

// ============ Position & Order Types ============

/**
 * @typedef {Object} KalshiPosition
 * @property {string} ticker - Market ticker
 * @property {number} position - Net position (positive=yes, negative=no)
 * @property {number} [average_price] - Average entry price
 * @property {number} [market_exposure] - Exposure in cents
 * @property {number} [realized_pnl] - Realized P&L in cents
 * @property {number} [resting_orders_count] - Number of resting orders
 * @property {number} [total_traded] - Total traded volume
 */

/**
 * @typedef {Object} KalshiOrder
 * @property {string} order_id - Order ID
 * @property {string} ticker - Market ticker
 * @property {string} client_order_id - Client-specified order ID
 * @property {'yes' | 'no'} side - Order side
 * @property {'buy' | 'sell'} action - Order action
 * @property {number} count - Number of contracts
 * @property {'market' | 'limit'} type - Order type
 * @property {number} [yes_price] - Yes limit price
 * @property {number} [no_price] - No limit price
 * @property {string} status - Order status
 * @property {string} created_time - ISO timestamp
 * @property {number} [remaining_count] - Remaining unfilled contracts
 */

/**
 * @typedef {Object} OrderRequest
 * @property {string} ticker - Market ticker
 * @property {string} [client_order_id] - Client order ID
 * @property {'yes' | 'no'} side - Order side
 * @property {'buy' | 'sell'} action - Order action
 * @property {number} count - Number of contracts
 * @property {'market' | 'limit'} [type] - Order type
 * @property {number} [yes_price] - Yes limit price (1-99)
 * @property {number} [no_price] - No limit price (1-99)
 * @property {number} [expiration_ts] - Expiration timestamp
 */

/**
 * @typedef {Object} KalshiFill
 * @property {string} trade_id - Trade ID
 * @property {string} ticker - Market ticker
 * @property {string} order_id - Order ID
 * @property {'yes' | 'no'} side - Fill side
 * @property {'buy' | 'sell'} action - Fill action
 * @property {number} count - Number of contracts
 * @property {number} [yes_price] - Yes price
 * @property {number} [no_price] - No price
 * @property {string} created_time - ISO timestamp
 */

// ============ Event Types ============

/**
 * @typedef {Object} KalshiEvent
 * @property {string} event_ticker - Event ticker
 * @property {string} title - Event title
 * @property {string} [subtitle] - Event subtitle
 * @property {string} status - Event status
 * @property {string} [category] - Event category
 * @property {KalshiMarket[]} [markets] - Nested markets (if requested)
 */

// ============ API Response Types ============

/**
 * @typedef {Object} BalanceResponse
 * @property {number} balance - Available balance in cents
 * @property {number} [payout] - Pending payout in cents
 */

/**
 * @typedef {Object} MarketsResponse
 * @property {KalshiMarket[]} markets - List of markets
 * @property {string} [cursor] - Pagination cursor
 */

/**
 * @typedef {Object} PositionsResponse
 * @property {KalshiPosition[]} market_positions - List of positions
 * @property {string} [cursor] - Pagination cursor
 */

/**
 * @typedef {Object} OrdersResponse
 * @property {KalshiOrder[]} orders - List of orders
 * @property {string} [cursor] - Pagination cursor
 */

/**
 * @typedef {Object} FillsResponse
 * @property {KalshiFill[]} fills - List of fills
 * @property {string} [cursor] - Pagination cursor
 */

/**
 * @typedef {Object} EventsResponse
 * @property {KalshiEvent[]} events - List of events
 * @property {string} [cursor] - Pagination cursor
 */

/**
 * @typedef {Object} ExchangeStatusResponse
 * @property {boolean} exchange_active - Is exchange active
 * @property {boolean} trading_active - Is trading allowed
 * @property {string} [exchange_estimated_resume_time] - Resume time if maintenance
 */

/**
 * @typedef {Object} ConnectionTestResult
 * @property {boolean} success - Connection successful
 * @property {{ available: number, total: number }} balance - Account balance
 */

// ============ Query Parameter Types ============

/**
 * @typedef {Object} MarketsQueryParams
 * @property {number} [limit] - Max results
 * @property {string} [cursor] - Pagination cursor
 * @property {string} [event_ticker] - Filter by event
 * @property {string} [series_ticker] - Filter by series
 * @property {string} [status] - Filter by status
 * @property {string} [tickers] - Comma-separated tickers
 */

/**
 * @typedef {Object} PositionsQueryParams
 * @property {string} [ticker] - Filter by ticker
 * @property {string} [event_ticker] - Filter by event
 * @property {number} [limit] - Max results
 * @property {string} [cursor] - Pagination cursor
 * @property {string} [settlement_status] - Filter by settlement status
 */

/**
 * @typedef {Object} OrdersQueryParams
 * @property {string} [ticker] - Filter by ticker
 * @property {string} [event_ticker] - Filter by event
 * @property {string} [status] - Filter by status
 * @property {number} [limit] - Max results
 * @property {string} [cursor] - Pagination cursor
 */

/**
 * @typedef {Object} FillsQueryParams
 * @property {string} [ticker] - Filter by ticker
 * @property {string} [order_id] - Filter by order
 * @property {number} [min_ts] - Minimum timestamp (epoch seconds)
 * @property {number} [limit] - Max results
 * @property {string} [cursor] - Pagination cursor
 */

// ============ Config Types ============

/**
 * @typedef {Object} CryptoMarketsConfig
 * @property {boolean} enabled - Is crypto trading enabled
 * @property {CryptoAsset[]} assets - Enabled crypto assets
 * @property {MarketTimeframe[]} timeframes - Enabled timeframes
 */

/**
 * @typedef {Object} SportsMarketsConfig
 * @property {boolean} enabled - Is sports trading enabled
 * @property {SportsLeague[]} leagues - Enabled leagues
 * @property {number} maxTimeToSettle - Max seconds until settlement
 */

/**
 * @typedef {Object} RiskConfig
 * @property {number} maxPositionContracts - Max contracts per position
 * @property {number} maxDailyLoss - Max daily loss in dollars
 * @property {number} maxOpenPositions - Max concurrent positions
 * @property {number} [stopLossPercent] - Stop loss percentage
 * @property {number} [takeProfitPercent] - Take profit percentage
 */

/**
 * @typedef {Object} StrategyParams
 * @property {boolean} enabled - Is strategy enabled
 * @property {Record<string, number | string | boolean>} params - Strategy parameters
 */

/**
 * @typedef {Object} BotConfig
 * @property {boolean} enabled - Is bot enabled
 * @property {boolean} dryRun - Is dry run mode
 * @property {KalshiEnvironment} apiEnvironment - API environment
 * @property {{ crypto: CryptoMarketsConfig, sports: SportsMarketsConfig }} markets - Market configs
 * @property {RiskConfig} risk - Risk configuration
 * @property {Record<string, StrategyParams>} strategies - Strategy configurations
 */

// ============ WebSocket Types ============

/**
 * @typedef {Object} TickerMessage
 * @property {string} market_ticker - Market ticker
 * @property {number} [yes_bid] - Best yes bid
 * @property {number} [yes_ask] - Best yes ask
 * @property {number} [no_bid] - Best no bid
 * @property {number} [no_ask] - Best no ask
 * @property {number} [last_price] - Last trade price
 * @property {number} [volume] - Volume
 */

/**
 * @typedef {Object} TradeMessage
 * @property {string} market_ticker - Market ticker
 * @property {string} trade_id - Trade ID
 * @property {number} count - Number of contracts
 * @property {number} [yes_price] - Yes price
 * @property {number} [no_price] - No price
 * @property {string} created_time - ISO timestamp
 */

/**
 * @typedef {Object} OrderbookDeltaMessage
 * @property {string} market_ticker - Market ticker
 * @property {string} [client_order_id] - Client order ID if user-caused
 * @property {Array<[number, number]>} [yes] - Yes side updates
 * @property {Array<[number, number]>} [no] - No side updates
 */

/**
 * @typedef {Object} FillMessage
 * @property {string} market_ticker - Market ticker
 * @property {string} order_id - Order ID
 * @property {string} trade_id - Trade ID
 * @property {number} count - Filled count
 * @property {number} remaining_count - Remaining count
 * @property {'yes' | 'no'} side - Side
 * @property {'buy' | 'sell'} action - Action
 * @property {number} [yes_price] - Yes price
 * @property {number} [no_price] - No price
 */

// CJS module - export empty object to make types available via require
module.exports = {}
