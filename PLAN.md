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
- URL pattern: `/:exchange/:strategy/[tab]` (e.g., `/coinbase/regime/dashboard`)
  - DCA routes: `/coinbase/dca`, `/coinbase/dca/cost-basis`, `/coinbase/dca/transactions`, etc.
  - Regime routes: `/coinbase/regime`, `/coinbase/regime/cost-basis`, `/coinbase/regime/transactions`, etc.
  - API Keys: `/:exchange/keys` (shared per exchange)
- Exchange + Strategy selector showing both strategies per exchange with status indicators
  - DCA: Active/Dry-Run/Off status
  - Regime: Running/Dry-Run/Ready/Off status
- Strategy-specific views:
  - DCA: Order-based cost basis, TSV transactions, Backtest/Optimizer pages
  - Regime: Cycle-based cost basis, fill ledger transactions (no Backtest/Optimizer)
- Real-time dashboard with WebSocket updates
- Configuration editor with validation (strategy-aware fields)
- API keys management (masked display)
- Transaction history and cost basis reports
- Backtesting with historical price data (supports any trading pair from config)
- Parameter optimization engine (supports any trading pair from config)
- Responsive layout with breakpoints: 1280px (default), 1440px (2xl), 1920px (3xl)
- Regime Dashboard with live D3.js charts (price, volatility, regime timeline)
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
- **Regime Engine (v2.4)**: Advanced volatility-driven inventory cycling
  - Replaces fixed-interval DCA with ATR-based volatility clock
  - Three-mode regime state machine: HARVEST, CAUTION, TREND
  - Liquidity-aware position sizing with ladder steps
  - Dynamic take-profit based on recent volatility
  - Hard exposure caps and drawdown protection
  - WebSocket real-time data feed for Coinbase
  - Health monitoring with automatic SAFE mode transitions

### Regime Engine Architecture (v2.4)

The Regime Engine is an advanced trading system that adapts to market conditions:

**Core Components:**
- `src/regime-engine.js` - Main orchestrator
- `src/regime-detector.js` - Regime classification (HARVEST/CAUTION/TREND)
- `src/volatility-utils.js` - ATR, realized volatility, VWAP calculations
- `src/position-sizer.js` - Liquidity-aware sizing with ladder scaling
- `src/order-executor.js` - Maker-prefer limit order placement
- `src/health-monitor.js` - SAFE mode and system health tracking
- `src/tail-events.js` - Flash move, spread widening, depth drop detection
- `src/websocket-feed.js` - Coinbase WebSocket real-time data
- `src/fill-ledger.js` - Idempotent fill tracking with cost basis
- `src/recovery.js` - Startup state recovery from exchange

**Regime Modes:**
| Mode | Description | Entry Behavior | TP Behavior |
|------|-------------|----------------|-------------|
| HARVEST | Mean-reverting, normal volatility | Full ladder entries | Standard TP |
| CAUTION | Elevated volatility or momentum | 50% reduced sizing | Wider TP (1.5x) |
| TREND | Strong directional movement | No new entries | Tighter TP (0.8x) |

**Volatility Clock:**
- Entry triggers based on price moving k × ATR from anchor price
- Minimum interval enforced (default: 60s)
- Maximum interval fallback (default: 1hr)
- ATR calculated from 1-minute and 5-minute candles

**Dynamic TP Auto-Management (v2.4+):**
- Opt-in feature (`tpAutoManaged: true`) for automatic TP parameter adjustment
- Records cycle analytics (optimal TP %, actual TP %, volatility context)
- Compresses historical data into histogram buckets with time-weighted decay
- Calculates percentiles (p25, p50, p75) from compressed + recent data
- Periodic evaluation every N cycles (default: 5) or daily (whichever first)
- Rate-limited adjustments (max 25% change per evaluation)
- Safety bounds: absolute min (0.05%), absolute max (5.0%)
- `holdbackRatio` (0.0-1.0, default 0.5) - configurable profit split between sell/hold
  - Profit-based holdback: sells to recover cost basis + (1-ratio) of profit as USDC
  - Keeps (ratio) of profit as BTC appreciation
  - Example: ratio 0.5 at +1% → 0.5% USDC profit + 0.5% BTC value retained
- **Capital Growth**: maxUsdcDeployed automatically increases by USDC profit each cycle
- State persisted across restarts (in regime-state.json / dry-run-state.json)
- Dashboard panel shows current settings, observed percentiles, adjustment history

**Safety Features:**
- Automatic SAFE mode on: WebSocket disconnect, stale data, REST errors
- Flash move detection pauses entries and disables scaling
- Spread widening and depth drop pauses
- Maximum exposure caps (BTC and USDC)
- Maximum drawdown protection with auto-recovery:
  - Pauses entries when drawdown >= configured limit (default: 20%)
  - Auto-resumes when drawdown recovers to < 50% of limit
  - Auto-resets peak after configurable hours (default: 72h/3 days)
  - Manual "Resume Trading" button in UI to override pause
- Ladder step limit with auto-reset:
  - Pauses entries when ladder limit reached (default: 10 steps)
  - Auto-resets after configurable hours (default: 72h/3 days)
  - Prevents stuck positions in prolonged ATH markets

**Position & P&L Tracking:**
- BTC Held - Current cycle position
- BTC on Order - BTC in pending sell orders
- BTC Reserves - Accumulated holdback from completed cycles (realized BTC P&L)
- Realized P&L shows both USD profit and BTC reserves
- Holdback ratio applied to each TP (sells 1-ratio, holds ratio of position)

**APY & Performance Tracking:**
- Tracks engine start time and initial capital (maxUsdcDeployed)
- Persists APY tracking across restarts
- **Total Liquid Value** - APY calculated from combined USDC + BTC (at live market price)
  - `totalUsdcReturn` - USDC realized P&L from trading
  - `totalBtcReturn` - BTC holdback accumulated (8 decimal precision)
  - `btcValueUsd` - BTC valued at current market price
  - `totalLiquidValue` - Combined value used for APY projections
- Calculates and displays:
  - Total return breakdown (USDC, BTC with USD value, combined Live Total)
  - Daily return rate based on liquid value
  - Estimated annual return (linear projection)
  - Estimated APY (compound calculation)
  - Cycles per day
  - Average P&L per cycle
- UI displays performance metrics in the Position section
- **Auto-resume on restart** - Engine automatically resumes if it was running before server restart

**Dry-Run Mode:**
- Test regime engine against live market data without placing real orders
- Simulates order placement, fills, and P&L tracking
- Decision log tracks all hypothetical trades for analysis
- Configurable via exchange-level `dryRun: true` (same as DCA engine)
- Visual indicators in admin UI show dry-run status
- Reset capability to clear simulated state and start fresh
- **State persistence** - Simulation survives server restarts
  - Saves state on fills, every 60s, and on graceful shutdown
  - Restores position, filled orders, P&L tracking on restart
  - State stored in `dry-run-state.json` (per-exchange)
- Useful for:
  - Validating regime strategy parameters before going live
  - Comparing different configurations against real market conditions
  - Training and understanding the system behavior
  - Stress testing under volatile market conditions

**Live Mode State Persistence:**
- Exchange is always source of truth for position and orders
- State persistence for faster recovery on restarts:
  - Saves regime state to `data/{exchange}/regime-state.json` every 5 minutes
  - Saves fill ledger to `data/{exchange}/fill-ledger.json` on shutdown
  - Restores state on startup, then validates against exchange
- **Restart recovery flow:**
  1. Load saved state from disk (if exists)
  2. Recover state from exchange (fills, open orders, balances)
  3. Merge saved state with exchange-recovered values
  4. Check for orders that filled while offline (TP orders, entry orders)
  5. Re-evaluate position based on current market price
  6. Re-anchor volatility triggers to current price
  7. Resume trading with validated state
- Offline order detection handles:
  - TP orders that filled while offline → completes cycle, calculates P&L
  - Entry orders that filled while offline → updates position
- Market position re-evaluation on startup:
  - Logs price movement since last entry
  - Re-anchors price for volatility triggers
  - Warns if price dropped significantly while offline

**API Routes:**
```
GET  /api/:exchange/regime/config    - Get regime configuration
PUT  /api/:exchange/regime/config    - Update regime configuration
GET  /api/:exchange/regime/status    - Get regime engine status
POST /api/:exchange/regime/start     - Start regime engine
POST /api/:exchange/regime/stop      - Stop regime engine
POST /api/:exchange/regime/pause     - Pause (enter SAFE mode)
POST /api/:exchange/regime/resume    - Resume from SAFE mode
POST /api/:exchange/regime/force-regime - Force regime transition
GET  /api/:exchange/regime/fills     - Get fill ledger

# Dry-Run specific routes
GET  /api/:exchange/regime/dry-run/log   - Get decision log (hypothetical trades)
GET  /api/:exchange/regime/dry-run/pnl   - Get simulated P&L summary
GET  /api/:exchange/regime/dry-run/state - Get full dry-run state
POST /api/:exchange/regime/dry-run/reset - Reset dry-run state
```

**WebSocket Events:**
- `trade:event` - Trade events (entries, fills, errors)
- `regime:change` - Regime transitions
- `regime:health` - Health mode changes
- `regime:position` - Position updates

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
├── optimizer-engine.js # Parameter optimization
│
│ # Regime Engine Components (v2.4)
├── regime-engine.js    # Main regime-aware trading engine
├── regime-detector.js  # Regime classification (HARVEST/CAUTION/TREND)
├── volatility-utils.js # ATR, RV, VWAP, swing calculations
├── position-sizer.js   # Liquidity-aware position sizing
├── order-executor.js   # Maker-prefer limit order placement
├── dry-run-executor.js # Simulated order execution for dry-run mode
├── dry-run-state.js    # State persistence for dry-run simulations
├── tp-optimizer.js     # Dynamic TP auto-management with histogram compression
├── health-monitor.js   # SAFE mode and system health
├── tail-events.js      # Flash/spread/depth event detection
├── websocket-feed.js   # Coinbase WebSocket real-time feed
├── fill-ledger.js      # Idempotent fill tracking with cost basis
├── recovery.js         # Startup state recovery from exchange
└── trade-events.js     # Trade event emitter for WebSocket updates

admin/src/components/
├── charts/             # D3.js chart components
│   ├── index.js        # Chart exports
│   ├── chartUtils.js   # Formatting, colors, responsive utils
│   ├── AreaChart.jsx   # Area and stacked area charts
│   ├── BarChart.jsx    # Bar and horizontal bar charts
│   ├── PriceChart.jsx  # Price line with buy markers
│   ├── ComposedChart.jsx # Multi-series area/line charts
│   ├── PendingOrdersChart.jsx # Order visualization
│   ├── MiniPriceSparkline.jsx  # Compact price sparkline for status bar
│   ├── RegimePriceChart.jsx    # Price chart with ATR trigger bands
│   ├── VolatilityChart.jsx     # ATR/volatility area chart
│   └── RegimeTimeline.jsx      # Horizontal regime history bar
├── ChartsDCA.jsx          # DCA strategy charts page
├── ChartsRegime.jsx       # Regime strategy charts page
├── CostBasisDCA.jsx       # DCA order-based cost basis view
├── CostBasisRegime.jsx    # Regime cycle-based cost basis view
├── TransactionsDCA.jsx    # DCA TSV-based transaction log
├── TransactionsRegime.jsx # Regime fill ledger transactions
├── Dashboard.jsx          # DCA main dashboard view
├── RegimeDashboard.jsx    # Regime engine control panel with live charts
├── ConfigEditor.jsx       # Strategy-aware configuration editor
├── ExchangeSelector.jsx   # Exchange + Strategy selector dropdown
└── ...                    # Other components

admin/src/hooks/
├── useTradeEvents.js    # WebSocket event subscriptions
└── useChartDataBuffer.js # 15-minute rolling data buffer for charts
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
│   ├── btc-price-cache-*.json
│   ├── fill-ledger.json     # Regime engine fill tracking
│   └── regime-state.json    # Regime engine position state
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
