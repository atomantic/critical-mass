# DCA Trading Bot

A PortOS-compatible multi-exchange DCA trading bot for Bitcoin.

**Ports:** 5563 (API), 5564 (UI dev)

---

## ✅ COMPLETED: PortOS Compatibility

### Configuration
- `ecosystem.config.cjs` - PM2 configuration following PortOS conventions
- Ports 5563 (API) and 5564 (UI dev) - next available after PortOS apps
- Environment-based port configuration

### Usage
```bash
# Development (with hot-reload)
npm run dev

# PM2 production
npm run pm2:start
npm run pm2:restart
npm run pm2:stop
npm run pm2:logs

# Build admin UI
npm run build
```

### URLs
- **API/Production UI:** http://localhost:5563
- **Dev UI (hot-reload):** http://localhost:5564

---

## ✅ COMPLETED: Dynamic Quote Currency Support

The UI now dynamically displays the correct quote currency based on the exchange:
- **Coinbase:** BTC-USDC → displays "USDC"
- **Gemini:** BTCUSD → displays "USD"

### Implementation
- `getQuoteCurrency(productId)` utility in `App.jsx` extracts currency from product ID
- All UI components receive `quoteCurrency` prop and display it dynamically
- Affects: Dashboard, Transactions, CostBasis, Charts, Backtest, ConfigEditor

---

## ✅ COMPLETED: Multi-Exchange Support (Coinbase + Gemini)

### Goal
Refactor from Coinbase-specific to support multiple exchanges with per-exchange configuration, data namespacing, and preserved production data.

### Key Changes

#### 1. Adapter Architecture
**Files:** `src/adapters/` (new directory)
- `base-adapter.js` - Interface definition with required methods
- `index.js` - Adapter registry and factory with `createAdapter()`, `getAdapter()`
- `coinbase/` - Coinbase adapter (auth.js, api.js, index.js)
- `gemini/` - Gemini adapter (auth.js, api.js, index.js)

**Required adapter methods:**
```
loadCredentials, getAccountBalance, getCurrentPrice, getProductDetails,
placeMarketBuy, placeLimitSell, getOrder, getOpenOrders, cancelOrder,
getOrderFills, getCandles
```

#### 2. Data Migration & Namespacing
**File:** `src/migration.js` (new)
- Auto-migration on startup (detects old structure, migrates if needed)
- Moves data from flat to exchange-namespaced directories
- Creates `.backup` files of originals
- `getExchangeDataDir(exchange)` - Get namespaced data path
- `getExchangeKeysPath(exchange)` - Get keys file path

**Directory structure:**
```
data/
├── coinbase/
│   ├── state.json
│   ├── transactions.tsv
│   └── btc-price-cache-*.json
├── gemini/
│   ├── state.json
│   └── transactions.tsv
├── coinbase-keys.json
└── gemini-keys.json
```

#### 3. Multi-Exchange Configuration
**File:** `src/config-utils.js` (new)
- `loadConfig()` - Load and normalize configuration
- `getExchangeConfig(exchange)` - Get config for specific exchange
- `updateExchangeConfig(exchange, updates)` - Update exchange config
- `getEnabledExchanges()` - List of enabled exchanges
- Backward compatible with single-exchange format

**New config.json format:**
```json
{
  "exchanges": {
    "coinbase": {
      "enabled": true,
      "dryRun": false,
      "productId": "BTC-USDC",
      ...
    },
    "gemini": {
      "enabled": false,
      "dryRun": true,
      "productId": "BTCUSD",
      ...
    }
  },
  "global": {
    "schedulerInterval": 30000
  }
}
```

#### 4. Core Engine Updates
**Files:** `src/dca-engine.js`, `src/order-manager.js`, `src/state-tracker.js`, `src/logger.js`
- All functions accept `exchange` parameter
- Use adapter pattern via `getAdapter(exchange)`
- `runIntervalCycle(exchange)` - Run cycle for specific exchange
- `runAllExchangeCycles()` - Run all enabled exchanges

#### 5. Gemini Adapter
**Key differences from Coinbase:**
| Aspect | Coinbase | Gemini |
|--------|----------|--------|
| Auth | JWT ES256 | HMAC-SHA384 + nonce |
| Market orders | Native `market_market_ioc` | Simulated via IOC limit |
| Product format | BTC-USDC | BTCUSD |
| Payload | JSON body | Base64 in header |

#### 6. Admin Dashboard Updates
**Files:** `admin/src/App.jsx`, `admin/src/components/`
- New `ExchangeSelector.jsx` - Dropdown to switch exchanges
- New `KeysConfig.jsx` - API keys configuration form
- All API calls use `/api/:exchange/...` routes
- Exchange context passed to all components

**New API routes:**
```
GET  /api/exchanges              - List all exchanges
GET  /api/:exchange/summary      - Exchange-specific summary
GET  /api/:exchange/config       - Get exchange config
PUT  /api/:exchange/config       - Update exchange config
GET  /api/:exchange/keys         - Get keys (masked)
PUT  /api/:exchange/keys         - Save keys
POST /api/:exchange/test-connection - Test API connection
POST /api/:exchange/trade        - Trigger trade
```

### Changes Made
1. ✅ Created adapter architecture (`src/adapters/`)
2. ✅ Created migration system (`src/migration.js`)
3. ✅ Created config utilities (`src/config-utils.js`)
4. ✅ Updated core engine files to use adapters
5. ✅ Created Gemini adapter with HMAC-SHA384 auth
6. ✅ Updated server.js with multi-exchange routes and scheduling
7. ✅ Updated admin dashboard with exchange selector and keys config
8. ✅ Updated CLI with `--exchange` flag

### Usage

**CLI:**
```bash
node index.js run --exchange coinbase
node index.js status --exchange gemini
node index.js exchanges  # List configured exchanges
```

**API Keys:**
- Coinbase: `data/coinbase-keys.json` (name + privateKey)
- Gemini: `data/gemini-keys.json` (apiKey + apiSecret)

---

## ✅ COMPLETED: Granular Time Interval Support

### Goal
Enable trading at configurable intervals (10 min, 1 hour, 4 hours, daily) instead of daily-only.

### Key Changes

#### 1. New Interval Utilities Module
**File:** `src/interval-utils.js` (new)
- Interval definitions with ms values and API endpoint mappings
- `getNextExecutionTime(intervalType)` - calculate next run time
- `getRunIdentifier(intervalType)` - unique ID per interval slot
- `hasRunThisInterval(lastRunId, intervalType)` - prevent duplicate runs
- `normalizeConfig(config)` - backwards compat for daysToSpread

#### 2. Configuration Update
**File:** `config.json`
- Rename `daysToSpread` → `intervalsToSpread`
- Add `intervalType`: `"10min"` | `"1hour"` | `"4hour"` | `"daily"`

#### 3. Backtest Engine
**File:** `src/backtest-engine.js`
- Use Coinbase Advanced Trade candles API instead of CryptoCompare
- Endpoint: `GET /api/v3/brokerage/products/{product_id}/candles`
- Granularities: 60 (1m), 300 (5m), 900 (15m), 3600 (1h), 21600 (6h), 86400 (1d)
- Max 300 candles per request (paginate for more)
- `aggregateCandles()` - combine 5-min data into 10-min candles
- Update cache files per interval type

#### 4. Scheduler
**File:** `server.js`
- Remove hardcoded `TRADE_HOUR = 10`
- Replace `checkAndRunDailyTrade()` with `checkAndRunIntervalTrade()`
- Check every 30 seconds (for sub-hourly intervals)
- Use `getNextExecutionTime()` from interval-utils

#### 5. State Tracker
**File:** `src/state-tracker.js`
- Replace `lastRunDate` → `lastRunId` + `lastRunTimestamp`
- Rename `totalDaysRun` → `totalIntervalsRun`
- Update `checkAllocationRemaining()` to use `intervalsToSpread`

#### 6. DCA Engine
**File:** `src/dca-engine.js`
- Rename `runDailyCycle()` → `runIntervalCycle()`
- Use interval-aware allocation math
- Check `hasRunThisInterval()` instead of date comparison

#### 7. Admin UI - Config
**File:** `admin/src/components/ConfigEditor.jsx`
- Add interval type dropdown (10min, 1hour, 4hour, daily)
- Update "Daily Buy Amount" → "Buy Amount per Interval"

#### 8. Admin UI - Backtest
**File:** `admin/src/components/Backtest.jsx`
- Add interval type selector
- Dynamic period options based on API limits
- Show warning for 10min > 7 days (API limit)

#### 9. Admin UI - Dashboard
**File:** `admin/src/components/Dashboard.jsx`
- Show current interval type
- Update "Next Trade" to show interval-appropriate time

### API Limits (Coinbase Candles)
| Granularity | Max per request | Practical limit |
|-------------|-----------------|-----------------|
| 60s (1 min) | 300 candles | ~9 days history |
| 300s (5 min) | 300 candles | paginate for more |
| 3600s (1 hr) | 300 candles | paginate for more |
| 86400s (1 day) | 300 candles | paginate for more |

### Changes Made
1. ✅ Created `src/interval-utils.js` - Core interval calculation utilities
2. ✅ Updated `config.json` - Added `intervalType` and `intervalsToSpread`
3. ✅ Updated `src/state-tracker.js` - Interval-aware run tracking with migration
4. ✅ Updated `src/dca-engine.js` - `runIntervalCycle()` replaces `runDailyCycle()`
5. ✅ Updated `server.js` - Interval-based scheduler (checks every 30 seconds)
6. ✅ Updated `src/backtest-engine.js` - Uses Coinbase candles API instead of CryptoCompare
7. ✅ Updated admin UI components - Interval selector in Config, Backtest, Dashboard
8. ✅ Backtest has independent configuration - Not tied to system config defaults, with "Load from Config" and "Reset Defaults" buttons

### Usage
Set `intervalType` in config.json to: `"10min"`, `"1hour"`, `"4hour"`, or `"daily"`

Example for hourly trading:
```json
{
  "intervalType": "1hour",
  "intervalsToSpread": 168
}
```

---

## Overview

A Node.js cron job that implements a Dollar Cost Averaging (DCA) strategy for BTC-USDC on Coinbase, designed to accumulate both USDC and BTC over time.

## Strategy

**Daily cycle:**
1. Buy a fixed USDC amount of BTC (e.g., $5000/day)
2. Place a post-only limit sell order at +10% for 95% of the purchase
3. Keep 5% as BTC reserves (never sold)

**Result per cycle (when sell fills):**
- USDC: +4.5% return (0.95 × 1.10 = 1.045)
- BTC: Accumulates 5% of each purchase as reserves

## Configuration

Edit `config.json`:

```json
{
  "productId": "BTC-USDC",
  "totalAllocation": 50000,
  "daysToSpread": 10,
  "sellMarkupPercent": 10,
  "holdbackPercent": 5,
  "minOrderSize": 1,
  "maxBuyPrice": 150000,
  "enabled": true
}
```

| Setting | Description |
|---------|-------------|
| `totalAllocation` | Budget limit (must have USDC in Coinbase account) |
| `daysToSpread` | Number of days to spread buys |
| `sellMarkupPercent` | Sell price markup (10 = +10%) |
| `holdbackPercent` | BTC to keep as reserves (5 = 5%) |
| `maxBuyPrice` | Skip buys above this price |
| `enabled` | Enable/disable the bot |

## Setup

1. Copy `keys.json` from perp_account (API credentials)
2. Edit `config.json` with your parameters
3. Run `npm install`

## Usage

```bash
# Run daily DCA cycle
node index.js run

# Check status only (no trading)
node index.js status
```

## PM2 Setup (Recommended)

```bash
# Start the DCA bot with PM2
pm2 start ecosystem.config.js

# View logs
pm2 logs dca-bot

# Check status
pm2 status

# Stop
pm2 stop dca-bot

# Restart
pm2 restart dca-bot

# Save PM2 process list (persist across reboots)
pm2 save
pm2 startup
```

**PM2 apps:**
- `dca-bot` - Main DCA cycle, runs daily at 10:00 AM
- `dca-status` - Status check, runs every 4 hours (optional)

## Alternative: Cron Setup

```bash
# Run daily at 10:00 AM
0 10 * * * cd /path/to/coinbase_dca_trade && node index.js run >> logs/cron.log 2>&1
```

## Files

```
coinbase_dca_trade/
├── index.js           # Main entry point
├── config.json        # Configuration
├── ecosystem.config.js # PM2 configuration
├── keys.json          # API credentials (not tracked)
├── src/
│   ├── auth.js        # JWT authentication
│   ├── api.js         # Coinbase API wrapper
│   ├── dca-engine.js  # Core DCA logic
│   ├── order-manager.js # Order execution
│   ├── state-tracker.js # State management
│   └── logger.js      # Transaction logging
└── data/
    ├── state.json     # Runtime state
    └── transactions.tsv # Transaction log
```

## State Tracking

The bot tracks:
- Total USDC allocated
- BTC reserves (holdback)
- Outstanding sell orders
- Daily run status (prevents duplicate runs)

## Transaction Log

All transactions are logged to `data/transactions.tsv`:

| Field | Description |
|-------|-------------|
| Date | Transaction date |
| Type | BUY, SELL_ORDER, SELL_FILLED |
| Price | BTC price |
| BTC Amount | Amount of BTC |
| USDC Amount | Amount of USDC |
| Order ID | Coinbase order ID |
| Fund Size | Current USDC fund balance |
| BTC Reserves | Total BTC reserves |
| Outstanding USDC | Value of pending sells |
| Outstanding BTC | Amount in pending sells |

## Safety Features

- **Max price threshold**: Skips buys when price exceeds `maxBuyPrice`
- **Daily run check**: Prevents duplicate runs on same day
- **Low balance handling**: Uses available USDC when below daily amount (minimum: `minOrderSize`)
- **Post-only orders**: Ensures sell orders are maker orders
- **Auto-sync**: Tracks filled sell orders and updates fund size

## Example Run

```
[2025-12-05T10:00:00.000Z] [INFO] Starting DCA bot (command: run)
[2025-12-05T10:00:01.000Z] [INFO] Current BTC-USDC price: 101000.00 USDC
[2025-12-05T10:00:01.000Z] [INFO] Allocation: 0/50000 USDC used, buying 5000 USDC
[2025-12-05T10:00:02.000Z] [INFO] Placing market buy for 5000 USDC of BTC-USDC
[2025-12-05T10:00:03.000Z] [INFO] Buy order placed: abc123
[2025-12-05T10:00:04.000Z] [INFO] Buy filled: 0.04950495 BTC at 101000.00 USDC
[2025-12-05T10:00:05.000Z] [INFO] Placing post-only sell for 0.0470297 BTC at 111100.00 USDC
[2025-12-05T10:00:06.000Z] [INFO] Sell order placed: def456
[2025-12-05T10:00:06.000Z] [INFO] === Daily Cycle Complete ===
[2025-12-05T10:00:06.000Z] [INFO] Bought: 0.04950495 BTC at 101000.00
[2025-12-05T10:00:06.000Z] [INFO] Sell order: 0.04702970 BTC at 111100.00
[2025-12-05T10:00:06.000Z] [INFO] Holdback (reserves): 0.00247525 BTC
[2025-12-05T10:00:06.000Z] [INFO] Total BTC reserves: 0.00247525 BTC
[2025-12-05T10:00:06.000Z] [INFO] Outstanding sell orders: 5225.00 USDC
```
