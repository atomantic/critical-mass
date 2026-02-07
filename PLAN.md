# DCA Trading Bot - Development Plan

A multi-exchange DCA trading bot for Bitcoin with admin dashboard.

**Version:** 2.4.11
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
- Minimum interval enforced (default: 2min)
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

**Dynamic Size Auto-Management (v2.3+):**
- Opt-in feature (`sizeAutoManaged: true`) for automatic position sizing adjustment
- Dynamically calculates optimal `baseSizeUsdc` based on available USDC balance
- Calculates total ladder multiplier accounting for geometric scaling (1 + step*0.1, capped)
- Formula: `baseSizeUsdc = (availableUsdc * targetUtilization) / totalLadderMultiplier`
- Records cycle data (steps used, capital deployed, available balance)
- Triggers recalculation on:
  - Cycle completion (every N cycles, default: 5)
  - Significant balance change (>10%)
  - Maximum hours elapsed (default: 24)
- Rate-limited adjustments (max 25% change per evaluation)
- Safety bounds: absolute min base ($10), absolute max base ($500)
- Target utilization default: 90% of available capital
- Optionally auto-adjusts `maxLadderSteps` based on p90 historical step usage
- State persisted across restarts
- Dashboard panel shows current sizing, step usage stats, adjustment history
- Configuration options:
  - `sizeAutoManaged: true/false` - Enable/disable feature
  - `sizeTargetUtilization: 0.90` - Target % of capital to utilize
  - `sizeAbsoluteMinBase: 10` - Floor for baseSizeUsdc
  - `sizeAbsoluteMaxBase: 500` - Ceiling for baseSizeUsdc
  - `sizeMaxChangePercent: 25` - Max % change per adjustment
  - `sizeAutoLadderSteps: false` - Also auto-adjust maxLadderSteps
  - `sizeEvaluationCycles: 5` - Evaluate every N cycles
  - `sizeEvaluationMaxHours: 24` - Or at least once per day

**Fill Time Tracking (v2.3+):**
- Records time from order placement to fill for all entry orders
- Tracks `fillTimeMs` in fill ledger for analytics
- Statistics calculated: avg, min, max, p50, p90, stale rate
- Stale rate = % of orders that took >30s to fill
- Dashboard panel shows fill time stats for last 7 days
- Data useful for optimizing `orderStaleMs` and entry offsets

**Regime-Based Stale Timeout (v2.3+):**
- Automatically adjusts order stale timeout based on current regime
- Multipliers applied to base `orderStaleMs`:
  - HARVEST: 1.0x (default timeout)
  - CAUTION: 0.7x (30% faster - uncertain markets need quicker repricing)
  - TREND: 0.5x (50% faster - trending markets move quickly)
- Effective timeout shown in dashboard with regime-adjustment indicator
- Prevents stale orders lingering at suboptimal prices during volatility

**Aggressiveness Control (v2.4+):**
- Dashboard control with 4 preset levels: Conservative, Moderate, Aggressive, Maximum
- Single-click changes apply immediately without restart
- Controls 8 trading parameters simultaneously (including maxLadderSteps):
  | Parameter | Conservative | Moderate | Aggressive | Maximum |
  |-----------|-------------|----------|------------|---------|
  | baseSizeUsdc | 25 | 50 | 100 | 200 |
  | kFactor | 0.8 | 0.65 | 0.5 | 0.3 |
  | minIntervalMs | 180000 (3min) | 120000 (2min) | 90000 (90s) | 60000 (1min) |
  | maxIntervalMs | 7200000 (2hr) | 3600000 (1hr) | 2400000 (40m) | 1200000 (20m) |
  | cautionScale | 0.15 | 0.35 | 0.6 | 1.0 |
  | trendScale | 0 | 0.1 | 0.25 | 0.5 |
  | entryOffsetBps | 25 | 18 | 12 | 5 |
  | maxLadderSteps | 10 | 15 | 25 | 50 |
- Estimated $25k deployment: Conservative ~23-34 days, Moderate ~10-20 days, Aggressive ~3-6 days, Maximum ~1-1.3 days
- Color-coded buttons (green/blue/yellow/red)
- Hover preview shows computed values with diff highlighting
- Detects "Custom" when values don't match any preset
- Note: baseSizeUsdc may be overridden by auto-sizer if enabled

**Pre-Positioned Liquidity Ladder Mode (v2.5) ✅ Implemented:**
- Alternative entry strategy that pre-positions multiple limit buy orders
- Complements reactive mode by capturing liquidity shocks and fat-tail events
- Two-engine system:
  | Engine | Extracts Value From | Best For |
  |--------|---------------------|----------|
  | Reactive | Oscillation frequency | Tight chop |
  | Ladder | Liquidity shocks & panic selling | Fat-tail dips, wicks |
- Configuration:
  - `entryMode: 'reactive' | 'ladder'` - Entry strategy mode
  - `ladderLevels: 10` - Number of rungs in the ladder
  - `ladderLowerBoundPct: 15` - Base lower bound (% below current price)
  - `ladderLowerBoundAthAdjust: true` - Widen ladder based on ATH distance
  - `ladderSpacingMode: 'linear' | 'sqrt' | 'exponential'` - Price level distribution
  - `ladderSizeMode: 'flat' | 'linear' | 'sqrt'` - Size allocation mode
  - `ladderAutoSwitch: false` - Auto-switch to ladder on high volatility
  - `ladderAutoSwitchVolMult: 2.0` - Vol expansion threshold for auto-switch
  - `ladderMinSpacingPct: 0.5` - Minimum % between rungs
- Adaptive lower bound:
  - Base percentage from config (default 15%)
  - ATH adjustment: widens when further from ATH (e.g., 43% below ATH → 1.43x multiplier)
  - Volatility adjustment: widens during high volatility (capped at 2x)
  - Maximum adjustment capped at 50%
- Spacing modes:
  - `sqrt`: Denser near top (current price), sparser at bottom (default)
  - `linear`: Even spacing throughout
  - `exponential`: Sparser near top, denser at bottom
- Ladder cycle flow:
  1. Build ladder with adaptive lower bound based on ATH distance and volatility
  2. Place N limit buy orders spanning from current price to lower bound
  3. On fill: update position, update TP, reprice remaining ladder from current price
  4. On TP fill: cancel all unfilled ladder orders, reset cycle
- Risk safeguards:
  - Budget cap: Total ladder allocation ≤ maxUsdcDeployed - totalCostBasis
  - BTC cap: Checks maxBtcExposure on each fill
  - Min order size: Skips levels where allocation < minOrderSize
  - Spacing minimum: Enforces ladderMinSpacingPct between levels
  - Order limit: Validates maxOpenOrders ≥ ladderLevels + 1
  - Mode switch protection: Doesn't switch modes mid-cycle with active position

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
  - Pauses entries when ladder limit reached (default: 15 steps)
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
  - **Pending entry orders** saved immediately when placed for recovery
  - Restores state on startup, then validates against exchange
- **Restart recovery flow:**
  1. Load saved state from disk (if exists)
  2. Recover state from exchange (fills, open orders, balances)
  3. Merge saved state with exchange-recovered values
  4. Check for orders that filled while offline (TP orders, entry orders)
  5. **Restore pending entry orders** from saved state (instead of canceling)
  6. Ingest any partial fills that occurred while offline
  7. Re-evaluate position based on current market price
  8. Re-anchor volatility triggers to current price
  9. Resume trading with validated state
- **Pending entry order persistence:**
  - Entry orders saved to `positionState.pendingEntryOrders` immediately when placed
  - Orders restored to order executor tracking on restart
  - Partial fills ingested and position updated accordingly
  - Orders not belonging to regime engine are ignored (e.g., from DCA engine)
  - Prevents lost opportunities when good limit orders were placed before restart
- Offline order detection handles:
  - TP orders that filled while offline → completes cycle, calculates P&L
  - Entry orders that filled while offline → updates position, places/updates TP order
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
│ # Regime Engine Components (v2.4/2.5)
├── regime-engine.js    # Main regime-aware trading engine
├── regime-detector.js  # Regime classification (HARVEST/CAUTION/TREND)
├── volatility-utils.js # ATR, RV, VWAP, swing calculations
├── position-sizer.js   # Liquidity-aware position sizing
├── order-executor.js   # Maker-prefer limit order placement + ladder orders
├── ladder-calculator.js # Ladder mode calculations (levels, sizing, ATH)
├── dry-run-executor.js # Simulated order execution for dry-run mode
├── dry-run-state.js    # State persistence for dry-run simulations
├── tp-optimizer.js     # Dynamic TP auto-management with histogram compression
├── size-optimizer.js   # Dynamic position sizing based on available capital
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

## Prediction Market Arbitrage System (Proposed Feature)

### Overview

Extension to support prediction market arbitrage on platforms like **Kalshi** (US-regulated) and **Polymarket** (crypto-based). Unlike spot crypto trading which requires directional prediction, prediction market arbitrage exploits mathematical pricing inefficiencies for risk-free or low-risk returns.

**Key Insight**: Prediction markets often misprice correlated events, allowing traders to lock in guaranteed profits by buying combinations that must collectively pay out more than their total cost.

### Five Arbitrage Strategy Types

Based on analysis of successful prediction market traders:

#### 1. Basic Arbitrage (Same-Market Spread)
- **Concept**: Buy both YES and NO shares on the same market when total cost < $1
- **Example**: YES @ $0.45 + NO @ $0.51 = $0.96 → Guaranteed $1 payout
- **Profit**: 4.2% return regardless of outcome
- **Risk**: Zero (one side MUST pay $1)
- **Detection**: Monitor bid/ask spreads on single markets

#### 2. Mutually Exclusive Arbitrage
- **Concept**: Two events where exactly one must be true
- **Example**: "Winner is A" vs "Winner is NOT A" across different markets
- **Opportunity**: Combined YES positions < $1 total
- **Risk**: Near-zero (definitional exclusivity)
- **Detection**: Identify markets with logical mutual exclusivity

#### 3. Contradiction Arbitrage
- **Concept**: Two markets make opposing claims about the same event
- **Example**: Market A says "X will happen", Market B says "X won't happen"
- **Trade**: Buy YES on one, buy equivalent position on other
- **Risk**: Low (depends on settlement consistency)
- **Detection**: NLP/semantic analysis of market descriptions

#### 4. One-of-Many (Multi-Date) Arbitrage ⭐ *Primary Strategy*
- **Concept**: Event markets with different date thresholds where earlier events trigger later ones
- **Example**: "US strikes Iran by March/April/June" - if March YES, then April and June also YES
- **Trade**: Buy NO on multiple dates where total NO cost < $1
- **Math**: If event happens in March → lose March NO, but didn't buy April/June NO
         If event never happens → ALL NO positions pay $1 each
- **Optimal**: Buy NO positions whose combined cost guarantees profit either way
- **Risk**: Minimal if positions properly sized
- **Detection**: Find related markets with cascading logic

#### 5. Must-Happen (Exhaustive) Arbitrage
- **Concept**: Set of outcomes where exactly one MUST occur
- **Example**: "Election winner: A, B, C, D" where all YES positions < $1 total
- **Trade**: Buy YES on all outcomes
- **Risk**: Zero (one outcome must win)
- **Detection**: Markets with exhaustive, mutually exclusive outcomes

### Proposed Architecture

```
src/
├── adapters/
│   ├── kalshi/                    # Kalshi API adapter
│   │   ├── index.js               # Main adapter
│   │   ├── auth.js                # Kalshi authentication
│   │   ├── markets.js             # Market data fetching
│   │   └── orders.js              # Order placement
│   └── polymarket/                # Polymarket adapter (optional)
│       ├── index.js
│       └── ...
├── arbitrage/
│   ├── arbitrage-engine.js        # Main orchestrator
│   ├── arbitrage-detector.js      # Opportunity detection
│   ├── arbitrage-types.js         # Strategy implementations
│   │   ├── basic-spread.js        # Type 1: Same-market spread
│   │   ├── mutual-exclusive.js    # Type 2: Mutually exclusive events
│   │   ├── contradiction.js       # Type 3: Contradicting markets
│   │   ├── multi-date.js          # Type 4: Date-cascading events
│   │   └── exhaustive.js          # Type 5: Must-happen sets
│   ├── market-correlator.js       # Find related/correlated markets
│   ├── profit-calculator.js       # ROI and risk calculations
│   ├── position-tracker.js        # Track open arb positions
│   └── settlement-monitor.js      # Monitor settlements/payouts
└── types/
    └── kalshi.d.ts                # Kalshi API types

admin/src/components/
├── arbitrage/
│   ├── ArbitrageDashboard.jsx     # Main arbitrage control panel
│   ├── OpportunityScanner.jsx     # Real-time opportunity display
│   ├── ActivePositions.jsx        # Current arbitrage positions
│   ├── ProfitTracker.jsx          # Historical profits
│   └── MarketCorrelations.jsx     # Visualize correlated markets
```

### Data Models

```javascript
// Arbitrage Opportunity
{
  id: string,
  type: 'basic' | 'mutual_exclusive' | 'contradiction' | 'multi_date' | 'exhaustive',
  markets: [{
    marketId: string,
    ticker: string,
    title: string,
    side: 'YES' | 'NO',
    price: number,      // Cost per share (0.01-0.99)
    shares: number,     // Recommended position size
    cost: number        // Total cost for position
  }],
  totalCost: number,    // Combined cost of all positions
  guaranteedPayout: number,  // Minimum payout regardless of outcome
  profit: number,       // Guaranteed profit (payout - cost)
  roi: number,          // Return on investment percentage
  confidence: number,   // 0-1 confidence in correlation logic
  expiresAt: Date,      // Earliest market expiration
  detectedAt: Date
}

// Arbitrage Position
{
  id: string,
  opportunityId: string,
  type: string,
  legs: [{
    orderId: string,
    marketId: string,
    side: 'YES' | 'NO',
    shares: number,
    fillPrice: number,
    status: 'open' | 'settled' | 'expired'
  }],
  totalInvested: number,
  realizedPayout: number,
  realizedProfit: number,
  status: 'open' | 'partial_settle' | 'complete',
  openedAt: Date,
  settledAt: Date
}
```

### Configuration

```json
{
  "exchanges": {
    "kalshi": {
      "enabled": true,
      "dryRun": true,
      "apiEndpoint": "https://trading-api.kalshi.com",
      "strategies": {
        "arbitrage": {
          "enabled": true,
          "types": ["basic", "multi_date", "exhaustive"],
          "minRoiPercent": 2.0,
          "maxPositionUsd": 1000,
          "maxTotalExposure": 10000,
          "minConfidence": 0.95,
          "autoExecute": false,
          "scanIntervalMs": 60000,
          "categories": ["politics", "economics", "crypto"]
        }
      }
    }
  }
}
```

### API Endpoints

```
# Market Data
GET  /api/kalshi/markets                    - List available markets
GET  /api/kalshi/markets/:id                - Get market details
GET  /api/kalshi/markets/correlated         - Find correlated market groups

# Arbitrage
GET  /api/kalshi/arbitrage/opportunities    - Current arbitrage opportunities
GET  /api/kalshi/arbitrage/opportunities/:type  - Filter by strategy type
POST /api/kalshi/arbitrage/execute          - Execute arbitrage opportunity
GET  /api/kalshi/arbitrage/positions        - Active arbitrage positions
GET  /api/kalshi/arbitrage/history          - Historical arbitrage trades
GET  /api/kalshi/arbitrage/pnl              - Profit/loss summary

# Monitoring
GET  /api/kalshi/arbitrage/alerts           - Active opportunity alerts
POST /api/kalshi/arbitrage/watch            - Add market to watchlist
GET  /api/kalshi/arbitrage/correlations     - Market correlation analysis
```

### Detection Algorithms

#### Multi-Date Event Detection (Primary)
1. Fetch all markets in a category (e.g., geopolitics)
2. Group by underlying event using NLP on titles:
   - Extract entity (e.g., "Iran", "Russia", "Bitcoin")
   - Extract action (e.g., "strikes", "reaches", "passes")
   - Extract date threshold (e.g., "by March", "before April")
3. For each event group with multiple dates:
   - Sort markets by date threshold
   - Calculate: if NO on all later dates, what's the max loss if event happens at each date?
   - Find optimal NO combination where: sum(NO_costs) < $1 guaranteed
4. Alert when ROI > minRoiPercent

#### Pricing Inefficiency Detection
1. For each market, continuously track:
   - Best bid/ask for YES and NO
   - Implied probability (YES price ≈ probability)
2. Alert when: best_ask_YES + best_ask_NO < 0.98 (2%+ guaranteed return)
3. Account for fees in calculations

### Execution Logic

```javascript
async function executeArbitrageOpportunity(opportunity) {
  // 1. Validate opportunity still exists at expected prices
  const currentPrices = await fetchCurrentPrices(opportunity.markets);
  const stillProfitable = validateProfitability(opportunity, currentPrices);

  if (!stillProfitable) {
    return { success: false, reason: 'prices_moved' };
  }

  // 2. Calculate optimal order sizes based on liquidity
  const orders = calculateOptimalOrders(opportunity, currentPrices);

  // 3. Execute all legs atomically (as close as possible)
  const results = await Promise.all(
    orders.map(order => placeOrder(order))
  );

  // 4. Track position
  const position = createPosition(opportunity, results);
  await savePosition(position);

  // 5. Set up settlement monitoring
  monitorSettlement(position);

  return { success: true, position };
}
```

### Risk Considerations

1. **Liquidity Risk**: Large orders may not fill at expected prices
2. **Timing Risk**: Prices move between leg executions
3. **Settlement Risk**: Unclear market resolutions
4. **Platform Risk**: Exchange downtime, withdrawal issues
5. **Regulatory Risk**: Changing rules on prediction markets

### Mitigation Strategies

1. **Slippage Protection**: Only execute if current prices still profitable after fees
2. **Size Limits**: Cap individual position and total exposure
3. **Confidence Thresholds**: Only trade high-confidence correlations
4. **Diversification**: Spread across multiple uncorrelated opportunities
5. **Manual Review Mode**: Alert but don't auto-execute for review

### Implementation Phases

**Phase 1: Foundation**
- [ ] Kalshi API adapter (auth, markets, orders)
- [ ] Basic arbitrage detector (Type 1: spread monitoring)
- [ ] Manual execution via admin UI
- [ ] Position tracking

**Phase 2: Multi-Date Strategy**
- [ ] Market correlation engine
- [ ] Multi-date event grouping
- [ ] Type 4 arbitrage detection
- [ ] Profit/risk calculator

**Phase 3: Automation**
- [ ] Auto-execution with safeguards
- [ ] Real-time monitoring
- [ ] Telegram/Discord alerts
- [ ] Settlement tracking

**Phase 4: Advanced Strategies**
- [ ] Types 2, 3, 5 detection
- [ ] NLP for market relationship inference
- [ ] Historical backtesting
- [ ] Portfolio optimization

---

## Exchange-Specific Notes

### Crypto.com Exchange
- Uses HMAC-SHA256 authentication with alphabetically sorted parameters
- Instrument format: `BTC_USDT` (underscore separator, uppercase)
- Spot trading uses `spot_margin: "SPOT"` parameter
- Market buy orders use `notional` field for quote amount
- API documentation: https://exchange-docs.crypto.com/exchange/v1/rest-ws/index.html
- Keys file: `data/cryptocom-keys.json` with `{ "apiKey": "...", "apiSecret": "..." }`
