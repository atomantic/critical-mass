# DCA Trading Bot - Development Plan

A multi-exchange DCA trading bot for Bitcoin with admin dashboard.

**Version:** 2.3.0
**Ports:** 5563 (API), 5564 (UI dev)

---

## Completed Features (v2.0)

### Multi-Exchange Support
- Adapter architecture for exchange abstraction (`src/adapters/`)
- Coinbase adapter with JWT ES256 authentication
- Gemini adapter with HMAC-SHA384 authentication
- Crypto.com adapter with HMAC-SHA256 authentication
- Per-exchange configuration, data namespacing, and state management
- Automatic data migration from v1 flat structure

### Granular Time Intervals
- Configurable intervals: 5min, 10min, 30min, 1hour, 4hour, daily
- Interval-aligned execution with duplicate prevention
- Backwards compatible with `daysToSpread` configuration

### Admin Dashboard
- React-based web UI at port 5563
- Exchange selector for multi-exchange management
- Real-time dashboard with WebSocket updates
- Configuration editor with validation
- API keys management (masked display)
- Transaction history and cost basis reports
- Backtesting with historical price data (supports any trading pair from config)
- Parameter optimization engine (supports any trading pair from config)
- Smart price formatting: adapts decimal places based on asset price magnitude
  - High prices (>$100): 2 decimals (e.g., $105,234.56)
  - Medium prices ($1-$100): up to 4 decimals (e.g., $45.1234)
  - Low prices ($0.01-$1): up to 5 decimals (e.g., $0.10234)
  - Very low prices (<$0.01): up to 8 decimals
- D3.js interactive charts:
  - Fund balance over time (area chart)
  - Price history with buy markers (line chart)
  - Pending sell orders visualization
  - Cost basis distribution histogram
  - Daily buy/sell volume (bar chart)
  - Cumulative fees & rebates (composed chart)

### Core Trading Engine
- Market buy with fee tracking
- Post-only limit sell orders
- Configurable holdback percentage for BTC reserves
- Price protection (max buy price threshold)
- Dry-run mode for testing
- Order consolidation:
  - Consolidate multiple pending orders into single order at weighted average price
  - Manual consolidation via admin UI button
  - Auto-consolidation when pending orders exceed `consolidateAfterOrders` threshold
  - Interval-based consolidation with `consolidateInterval` option (daily, weekly, never)
  - Skips partially filled orders
  - Tracks consolidation in state and transaction logs

### DCA Strategies
- **Fixed Amount (default)**: Traditional DCA with fixed buy amounts per interval
- **Fibonacci**: Volatility-harvesting accumulation strategy
  - Buys using Fibonacci sequence multipliers (1, 1, 2, 3, 5, 8, 13... × base amount)
  - Maintains single consolidated sell order per cycle at weighted-average cost basis + markup
  - Automatic cycle reset when sell fills, restarting at position 0
  - Optimized for short-term mean reversion in low-to-moderate volatility regimes
  - Transitions to accumulation mode during trending/high-volatility periods
  - Configurable via `dcaStrategy: 'fibonacci'` and `fibBaseAmount` in config

### Data Management
- Exchange-namespaced data directories
- Transaction logging in TSV format
- State persistence with migration support
- Price cache for backtesting

### Type System
- JSDoc type definitions in `src/types.js`
- `@ts-check` enabled for type checking in editors
- Comprehensive types for:
  - Exchange configurations and state
  - Order and fill results
  - API responses
  - Transaction records
- TypeScript-compatible `jsconfig.json` for IDE support

---

## Architecture

### File Structure
```
src/
├── types.js            # JSDoc type definitions
├── adapters/           # Exchange abstraction layer
│   ├── base-adapter.js # Interface definition
│   ├── index.js        # Registry and factory
│   ├── coinbase/       # Coinbase implementation
│   ├── gemini/         # Gemini implementation
│   └── cryptocom/      # Crypto.com implementation
├── config-utils.js     # Multi-exchange config management
├── dca-engine.js       # Core trading logic (fixed + fibonacci strategies)
├── fibonacci-utils.js  # Fibonacci sequence and cycle calculations
├── interval-utils.js   # Time interval calculations
├── order-manager.js    # Order execution and tracking
├── state-tracker.js    # State persistence (including fib cycle state)
├── logger.js           # Transaction logging
├── migration.js        # Data structure migration
├── backtest-engine.js  # Historical simulation (fixed + fibonacci)
└── optimizer-engine.js # Parameter optimization

admin/src/components/
├── charts/             # D3.js chart components
│   ├── index.js        # Chart exports
│   ├── chartUtils.js   # Formatting, colors, responsive utils
│   ├── AreaChart.jsx   # Area and stacked area charts
│   ├── BarChart.jsx    # Bar and horizontal bar charts
│   ├── PriceChart.jsx  # Price line with buy markers
│   ├── ComposedChart.jsx # Multi-series area/line charts
│   └── PendingOrdersChart.jsx # Order visualization
├── Charts.jsx          # Charts page using D3 components
├── Dashboard.jsx       # Main dashboard view
└── ...                 # Other components
```

### Configuration Format
```json
{
  "exchanges": {
    "coinbase": { /* exchange-specific settings */ },
    "gemini": { /* exchange-specific settings */ },
    "cryptocom": { /* exchange-specific settings */ }
  },
  "global": {
    "schedulerInterval": 30000
  }
}
```

### Data Namespacing
```
data/
├── coinbase/
│   ├── state.json
│   ├── transactions.tsv
│   └── btc-price-cache-*.json
├── gemini/
│   ├── state.json
│   └── transactions.tsv
├── cryptocom/
│   ├── state.json
│   └── transactions.tsv
├── coinbase-keys.json
├── gemini-keys.json
└── cryptocom-keys.json
```

---

## API Routes

```
GET  /api/exchanges              - List all exchanges
GET  /api/:exchange/summary      - Exchange summary with status
GET  /api/:exchange/config       - Get exchange configuration
PUT  /api/:exchange/config       - Update exchange configuration
GET  /api/:exchange/keys         - Get API keys (masked)
PUT  /api/:exchange/keys         - Save API keys
POST /api/:exchange/test-connection - Test exchange connectivity
POST /api/:exchange/trade        - Trigger manual trade
POST /api/:exchange/consolidate  - Consolidate pending orders
GET  /api/:exchange/transactions - Get transaction history
GET  /api/:exchange/cost-basis   - Get cost basis report
POST /api/:exchange/backtest     - Run backtest simulation
POST /api/:exchange/optimize     - Run parameter optimization
```

---

## Exchange Adapter Interface

Required methods for each adapter:
- `loadCredentials()` - Load API keys
- `getAccountBalance(currency)` - Get balance
- `getCurrentPrice(productId)` - Get current price
- `getProductDetails(productId)` - Get trading details
- `placeMarketBuy(productId, amount)` - Execute market buy
- `placeLimitSell(productId, amount, price)` - Place limit sell
- `getOrder(orderId)` - Get order status
- `getOpenOrders(productId)` - List open orders
- `cancelOrder(orderId)` - Cancel an order
- `getOrderFills(orderId)` - Get fill details
- `getCandles(productId, start, end, granularity)` - Get price history

---

## Future Considerations

- Additional exchange adapters (Kraken, Binance US)
- Multiple trading pairs support
- Advanced order types (trailing stops)
- Portfolio rebalancing
- Tax reporting exports
- Mobile notifications

---

## Exchange-Specific Notes

### Crypto.com Exchange
- Uses HMAC-SHA256 authentication with alphabetically sorted parameters
- Instrument format: `BTC_USDT` (underscore separator, uppercase)
- Spot trading uses `spot_margin: "SPOT"` parameter
- Market buy orders use `notional` field for quote amount
- API documentation: https://exchange-docs.crypto.com/exchange/v1/rest-ws/index.html
- Keys file: `data/cryptocom-keys.json` with `{ "apiKey": "...", "apiSecret": "..." }`
