<p align="center">
  <img src="logo.svg" alt="Critical Mass logo" width="128" height="128" />
</p>

# Critical Mass

Multi-exchange crypto accumulation engine with adaptive regime detection and celestial position management.

> **Disclaimer:** This software trades real money on cryptocurrency exchanges. Use at your own risk. The authors are not responsible for any financial losses. Always start with dry-run mode and small allocations to verify behavior before committing real capital.

<p align="center">
  <img src="docs/app_1.png" alt="Critical Mass Dashboard" width="800" />
</p>

## How It Works

Critical Mass supports two trading strategies that can run independently per exchange:

### DCA Strategy (Fixed Interval)

A classic dollar-cost averaging approach with built-in profit-taking:

1. **Buy** a fixed amount of BTC at each interval (e.g., $500/day)
2. **Sell** 95% at a configurable markup (e.g., +10%) via post-only limit order
3. **Hold** the remaining 5% as permanent BTC reserves

When a sell fills, you net ~4.5% return on that cycle (0.95 x 1.10 = 1.045) while accumulating BTC reserves from every purchase.

### Regime Strategy (Adaptive)

A real-time, volatility-aware strategy that adapts to market conditions:

- **Regime Detection** - Classifies the market as TREND, HARVEST, or CAUTION using ATR and momentum indicators
- **Adaptive Sizing** - Scales position sizes based on volatility, VWAP, and the current regime
- **Fibonacci Laddering** - Spreads entries across Fibonacci-spaced price levels for better fills
- **Dynamic Take-Profit** - Adjusts sell targets based on ATR multiples with configurable min/max bounds
- **Macro Overlay** - Factors in ATH distance and broader market context
- **Aggressiveness Presets** - Conservative, Moderate, Aggressive, and Maximum profiles

## Features

- **Multi-Exchange** - Coinbase, Gemini, and Crypto.com with per-exchange configuration
- **Dual Strategy** - Fixed-interval DCA or adaptive regime-based trading per exchange
- **Real-Time Dashboard** - React admin UI with WebSocket-driven live updates
- **Celestial Visualization** - Positions rendered as orbiting bodies in a solar system view
- **Volatility Charts** - Live ATR, price, and regime timeline charts
- **Backtesting** - Simulate strategies against historical data
- **Parameter Optimizer** - Find optimal settings via grid search
- **Dry-Run Mode** - Test strategies without real trades
- **Notifications** - Configurable alerts for fills, errors, and regime changes
- **Backup & Restore** - Automatic state backups with pruning
- **Health Monitor** - Tracks WebSocket connectivity, latency, rate limits, and error rates
- **PM2 Support** - Production-ready process management

## Requirements

- Node.js 18+
- Exchange API key with View and Trade permissions

## Installation

```bash
git clone https://github.com/atomantic/critical-mass.git
cd critical-mass
npm run install:all   # Install both server and admin UI dependencies
cp config.example.json config.json  # Copy example config and customize
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

**Crypto.com** (`data/cryptocom-keys.json`):
```json
{
  "apiKey": "your-api-key",
  "apiSecret": "your-api-secret"
}
```

### Bot Settings (`config.json`)

Each exchange can run either the fixed DCA strategy or the adaptive regime strategy:

```json
{
  "exchanges": {
    "coinbase": {
      "enabled": true,
      "dryRun": true,
      "productId": "BTC-USDC",
      "totalAllocation": 10000,
      "intervalsToSpread": 60,
      "intervalType": "daily",
      "sellMarkupPercent": 10,
      "holdbackPercent": 5,
      "minOrderSize": 1,
      "maxBuyPrice": 250000,
      "regime": {
        "enabled": false,
        "baseSizeUsdc": 100,
        "aggressiveness": "moderate"
      }
    }
  },
  "global": {
    "schedulerInterval": 30000
  }
}
```

### Configuration Options

**DCA Settings:**

| Setting | Description |
|---------|-------------|
| `enabled` | Enable/disable the exchange |
| `dryRun` | Simulate trades without executing |
| `productId` | Trading pair (e.g., `BTC-USDC`, `BTCUSD`, `CRO_USD`) |
| `totalAllocation` | Budget limit in quote currency |
| `intervalsToSpread` | Number of intervals to spread buys across |
| `intervalType` | Trade frequency: `5min`, `10min`, `30min`, `1hour`, `4hour`, `daily` |
| `sellMarkupPercent` | Sell price markup (10 = +10%) |
| `holdbackPercent` | BTC kept as reserves (5 = 5%) |
| `minOrderSize` | Minimum order in quote currency |
| `maxBuyPrice` | Skip buys above this price |

**Regime Settings** (`regime` sub-object):

| Setting | Description |
|---------|-------------|
| `enabled` | Enable adaptive regime strategy |
| `aggressiveness` | Preset: `conservative`, `moderate`, `aggressive`, `maximum` |
| `baseSizeUsdc` | Base order size in quote currency |
| `atrPeriod` | ATR calculation period |
| `kFactor` | ATR multiplier for interval scaling |
| `minIntervalMs` / `maxIntervalMs` | Bounds for adaptive trade interval |
| `tpMinPercent` / `tpMaxPercent` | Take-profit range |
| `holdbackRatio` | Fraction of each buy kept as reserves |
| `maxUsdcDeployed` | Maximum capital deployed at once |
| `maxBtcExposure` | Maximum BTC exposure |
| `ladderSizeMode` | Ladder sizing: `fibonacci` or `fixed` |

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
npm run pm2:start      # Start
npm run pm2:logs       # View logs
npm run pm2:status     # Check status
npm run pm2:restart    # Restart
npm run pm2:stop       # Stop
```

## Testing

```bash
npm test
```

## Safety Features

- **Max price threshold** - Skips buys above `maxBuyPrice`
- **Capital limits** - `maxUsdcDeployed` and `maxBtcExposure` caps
- **Drawdown protection** - Pauses trading if drawdown exceeds threshold
- **Flash crash detection** - Detects extreme price moves and cancels entries
- **Spread monitoring** - Pauses if bid-ask spread is too wide
- **Depth checks** - Requires minimum order book depth
- **Rate limit tracking** - Backs off when approaching exchange limits
- **Stale data protection** - Pauses if market data feed goes stale
- **Duplicate prevention** - Only runs once per interval (DCA mode)
- **Dry-run mode** - Test configuration without real trades
- **Post-only orders** - Ensures sell orders are maker orders for lower fees
- **Auto-sync** - Detects filled sell orders and updates fund balance
- **Fee accounting** - Accurate cost basis including fees and rebates
- **Automatic backups** - Periodic state backups with configurable retention

## Exchange Setup

### Coinbase

1. Go to [Coinbase Developer Platform](https://www.coinbase.com/settings/api)
2. Create new API key with **View** and **Trade** permissions
3. Add your server's IP to the allowlist
4. Copy the API key name and private key to `data/coinbase-keys.json`

### Gemini

1. Go to [Gemini API Settings](https://exchange.gemini.com/settings/api)
2. Create new API key with **Trading** scope
3. Copy the API key and secret to `data/gemini-keys.json`

### Crypto.com

1. Go to [Crypto.com Exchange API Settings](https://exchange.crypto.com/settings/api)
2. Create new API key with **Trade** permissions
3. Copy the API key and secret to `data/cryptocom-keys.json`

## License

[ISC](LICENSE)
