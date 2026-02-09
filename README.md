# Critical Mass

Multi-exchange BTC accumulation engine with celestial position management.

**Version:** 2.0.0
**Ports:** 5563 (API), 5564 (UI dev)

## Strategy

The bot executes configurable interval cycles:

1. **Buy** a fixed amount of BTC (e.g., $500/interval)
2. **Sell** 95% at +10% markup via post-only limit order
3. **Hold** 5% as BTC reserves (never sold)

### Expected Returns

When a sell order fills:
- **Fiat**: +4.5% return on that cycle (0.95 × 1.10 = 1.045)
- **BTC**: Accumulates 5% of each purchase as permanent reserves

This creates a dual accumulation strategy that profits in both directions.

## Features

- **Multi-Exchange Support** - Coinbase and Gemini with per-exchange configuration
- **Granular Intervals** - 5min, 10min, 30min, 1hour, 4hour, or daily trading
- **Admin Dashboard** - Web UI for configuration, monitoring, and backtesting
- **Dry-Run Mode** - Test strategies without real trades
- **Post-only Sells** - Maker orders for lower fees
- **BTC Holdback** - Configurable percentage kept as reserves
- **Fee Tracking** - Logs fees, rebates, and net costs
- **Price Protection** - Skip buys above max price threshold
- **Duplicate Prevention** - Only runs once per interval
- **Auto-sync** - Detects filled sell orders and updates fund balance
- **PM2 Support** - Production-ready process management

## Requirements

- Node.js 18+
- Exchange API key with View and Trade permissions

## Installation

```bash
git clone <repo-url>
cd critical-mass
npm run install:all   # Install both server and admin UI dependencies
```

## Configuration

### API Keys

Create exchange-specific key files in the `data/` directory:

**Coinbase** (`data/coinbase-keys.json`):
```json
{
  "name": "organizations/{org-id}/apiKeys/{key-id}",
  "privateKey": "-----BEGIN EC PRIVATE KEY-----\n...\n-----END EC PRIVATE KEY-----\n"
}
```

**Gemini** (`data/gemini-keys.json`):
```json
{
  "apiKey": "your-api-key",
  "apiSecret": "your-api-secret"
}
```

### Bot Settings (`config.json`)

```json
{
  "exchanges": {
    "coinbase": {
      "enabled": true,
      "dryRun": false,
      "productId": "BTC-USDC",
      "totalAllocation": 10000,
      "intervalsToSpread": 60,
      "intervalType": "daily",
      "sellMarkupPercent": 10,
      "holdbackPercent": 5,
      "minOrderSize": 1,
      "maxBuyPrice": 250000
    },
    "gemini": {
      "enabled": false,
      "dryRun": true,
      "productId": "BTCUSD",
      "totalAllocation": 5000,
      "intervalsToSpread": 168,
      "intervalType": "1hour",
      "sellMarkupPercent": 10,
      "holdbackPercent": 5,
      "minOrderSize": 1,
      "maxBuyPrice": 250000
    }
  },
  "global": {
    "schedulerInterval": 30000
  }
}
```

### Configuration Options

| Setting | Description |
|---------|-------------|
| `enabled` | Enable/disable the bot for this exchange |
| `dryRun` | Simulate trades without executing (for testing) |
| `productId` | Trading pair (BTC-USDC for Coinbase, BTCUSD for Gemini) |
| `totalAllocation` | Budget limit in quote currency |
| `intervalsToSpread` | Number of intervals to spread buys |
| `intervalType` | Trade frequency: `5min`, `10min`, `30min`, `1hour`, `4hour`, `daily` |
| `sellMarkupPercent` | Sell price markup percentage (10 = +10%) |
| `holdbackPercent` | BTC kept as reserves (5 = 5%) |
| `minOrderSize` | Minimum order in quote currency |
| `maxBuyPrice` | Skip buys above this BTC price |

## Usage

### Admin Dashboard (Recommended)

```bash
# Development (with hot-reload)
npm run dev

# Production
npm run build
npm run pm2:start
```

**URLs:**
- **API/Production UI:** http://localhost:5563
- **Dev UI (hot-reload):** http://localhost:5564

### CLI Commands

```bash
# Execute interval cycle for an exchange
node index.js run --exchange coinbase
node index.js run -e gemini

# Check status without trading
node index.js status --exchange coinbase

# List all configured exchanges
node index.js exchanges

# Debug - show account balances
node index.js debug --exchange coinbase
```

### PM2 (Production)

```bash
# Start the bot
npm run pm2:start

# View logs
npm run pm2:logs

# Check status
npm run pm2:status

# Restart
npm run pm2:restart

# Stop
npm run pm2:stop
```

## File Structure

```
critical-mass/
├── index.js              # CLI entry point
├── server.js             # API server + scheduler
├── config.json           # Multi-exchange configuration
├── ecosystem.config.cjs  # PM2 configuration
├── package.json
├── src/
│   ├── adapters/         # Exchange adapters
│   │   ├── base-adapter.js
│   │   ├── index.js      # Adapter registry
│   │   ├── coinbase/     # Coinbase implementation
│   │   └── gemini/       # Gemini implementation
│   ├── config-utils.js   # Configuration management
│   ├── dca-engine.js     # Core DCA logic
│   ├── interval-utils.js # Interval timing utilities
│   ├── logger.js         # Transaction logging
│   ├── migration.js      # Data migration utilities
│   ├── order-manager.js  # Order execution
│   ├── state-tracker.js  # State persistence
│   ├── backtest-engine.js # Backtesting engine
│   └── optimizer-engine.js # Parameter optimization
├── admin/                # React admin dashboard
│   └── src/
│       ├── App.jsx
│       └── components/
│           ├── Dashboard.jsx
│           ├── Backtest.jsx
│           ├── ConfigEditor.jsx
│           ├── ExchangeSelector.jsx
│           └── KeysConfig.jsx
├── data/
│   ├── coinbase/         # Coinbase-specific data
│   │   ├── state.json
│   │   └── transactions.tsv
│   ├── gemini/           # Gemini-specific data
│   │   ├── state.json
│   │   └── transactions.tsv
│   ├── coinbase-keys.json # API credentials (git-ignored)
│   └── gemini-keys.json   # API credentials (git-ignored)
└── logs/                 # PM2 logs
```

## State Tracking

Each exchange maintains separate state in `data/{exchange}/state.json`:

- Total allocation used vs budget
- BTC reserves (holdback)
- Outstanding sell orders (value and BTC amount)
- Cumulative fees and rebates
- Last run identifier (prevents duplicate runs)
- Order history with cost basis

## Transaction Log

All transactions logged to `data/{exchange}/transactions.tsv`:

| Column | Description |
|--------|-------------|
| Date | Transaction date |
| Type | BUY, SELL_ORDER, SELL_FILLED |
| Price | BTC price |
| BTC Amount | Amount of BTC |
| USDC Amount | Amount in quote currency |
| Fees | Trading fees |
| Rebates | Fee rebates |
| Net Fees | Fees minus rebates |
| Order ID | Exchange order ID |
| Fund Size | Current fund balance |
| BTC Reserves | Total BTC reserves |
| Outstanding USDC | Value of pending sells |
| Outstanding BTC | Amount in pending sells |
| Total Fees | Cumulative fees |
| Total Rebates | Cumulative rebates |

## Safety Features

- **Max price threshold** - Skips buys when BTC exceeds `maxBuyPrice`
- **Interval run check** - Prevents duplicate runs in same interval
- **Dry-run mode** - Test configuration without real trades
- **Low balance handling** - Uses available balance when below interval amount
- **Post-only orders** - Ensures sell orders are maker orders (lower fees)
- **Auto-sync** - Tracks filled sell orders and updates fund size
- **Fee accounting** - Accurate cost basis including fees and rebates
- **Data backup** - Migration creates backups before moving files

## API Endpoints

The server exposes REST endpoints for the admin dashboard:

```
GET  /api/exchanges              - List all exchanges
GET  /api/:exchange/summary      - Exchange-specific summary
GET  /api/:exchange/config       - Get exchange config
PUT  /api/:exchange/config       - Update exchange config
GET  /api/:exchange/keys         - Get keys (masked)
PUT  /api/:exchange/keys         - Save keys
POST /api/:exchange/test-connection - Test API connection
POST /api/:exchange/trade        - Trigger manual trade
GET  /api/:exchange/transactions - Get transaction history
GET  /api/:exchange/cost-basis   - Get cost basis report
POST /api/:exchange/backtest     - Run backtest simulation
```

## Exchange Setup

### Coinbase

1. Go to [Coinbase Advanced Trade](https://www.coinbase.com/advanced-trade)
2. Navigate to Settings > API
3. Create new API key with **View** and **Trade** permissions
4. Add your server's IP to the allowlist
5. Copy the API key name and private key to `data/coinbase-keys.json`

### Gemini

1. Go to [Gemini API Settings](https://exchange.gemini.com/settings/api)
2. Create new API key with **Trading** scope
3. Copy the API key and secret to `data/gemini-keys.json`

## Example Output

```
[2025-01-20T10:00:00.000Z] [INFO] [coinbase] Starting interval cycle...
[2025-01-20T10:00:01.000Z] [INFO] [coinbase] Current BTC-USDC price: 104523.00
[2025-01-20T10:00:01.000Z] [INFO] [coinbase] USDC balance: 50000.00 available
[2025-01-20T10:00:01.000Z] [INFO] [coinbase] Allocation: 5000/30000 used, buying 500.00
[2025-01-20T10:00:02.000Z] [INFO] [coinbase] Placing market buy for 500 USDC of BTC-USDC
[2025-01-20T10:00:03.000Z] [INFO] [coinbase] Buy filled: 0.00478200 BTC at 104523.00
[2025-01-20T10:00:03.000Z] [INFO] [coinbase] Fees: 0.6250, Rebates: 0.1560, Net: 0.4690
[2025-01-20T10:00:04.000Z] [INFO] [coinbase] Placing post-only sell for 0.00454290 BTC at 114975.30
[2025-01-20T10:00:04.000Z] [INFO] [coinbase] === Daily Cycle Complete ===
[2025-01-20T10:00:04.000Z] [INFO] [coinbase] Bought: 0.00478200 BTC at 104523.00
[2025-01-20T10:00:04.000Z] [INFO] [coinbase] Sell order: 0.00454290 BTC at 114975.30
[2025-01-20T10:00:04.000Z] [INFO] [coinbase] Holdback (reserves): 0.00023910 BTC
[2025-01-20T10:00:04.000Z] [INFO] [coinbase] Total BTC reserves: 0.00502110 BTC
```

## License

ISC
