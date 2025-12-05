# Coinbase DCA Trading Bot

A Node.js bot that implements a Dollar Cost Averaging (DCA) strategy for BTC-USDC on Coinbase Advanced Trade, designed to accumulate both USDC and BTC over time.

## Strategy

The bot executes a daily cycle:

1. **Buy** a fixed USDC amount of BTC (e.g., $1000/day)
2. **Sell** 95% at +10% markup via post-only limit order
3. **Hold** 5% as BTC reserves (never sold)

### Expected Returns

When a sell order fills:
- **USDC**: +4.5% return on that cycle (0.95 × 1.10 = 1.045)
- **BTC**: Accumulates 5% of each purchase as permanent reserves

This creates a dual accumulation strategy that profits in both directions.

## Features

- **Automated DCA** - Daily buys spread over configurable period
- **Post-only sells** - Maker orders for lower fees
- **BTC holdback** - Configurable percentage kept as reserves
- **Fee tracking** - Logs fees, rebates, and net costs
- **Price protection** - Skip buys above max price threshold
- **Duplicate prevention** - Only runs once per day
- **Auto-sync** - Detects filled sell orders and updates fund balance
- **PM2 support** - Production-ready process management

## Requirements

- Node.js 18+
- Coinbase Advanced Trade API key with:
  - View permissions
  - Trade permissions
  - IP allowlist configured

## Installation

```bash
git clone <repo-url>
cd coinbase_dca_trade
npm install
```

## Configuration

### API Keys (`keys.json`)

Create `keys.json` with your Coinbase API credentials:

```json
{
  "name": "organizations/{org-id}/apiKeys/{key-id}",
  "privateKey": "-----BEGIN EC PRIVATE KEY-----\n...\n-----END EC PRIVATE KEY-----\n"
}
```

### Bot Settings (`config.json`)

```json
{
  "productId": "BTC-USDC",
  "totalAllocation": 10000,
  "daysToSpread": 10,
  "sellMarkupPercent": 10,
  "holdbackPercent": 5,
  "minOrderSize": 1,
  "maxBuyPrice": 250000,
  "enabled": true
}
```

| Setting | Description |
|---------|-------------|
| `productId` | Trading pair (default: BTC-USDC) |
| `totalAllocation` | Budget limit in USDC (must have funds in account) |
| `daysToSpread` | Number of days to spread buys |
| `sellMarkupPercent` | Sell price markup percentage (10 = +10%) |
| `holdbackPercent` | BTC kept as reserves (5 = 5%) |
| `minOrderSize` | Minimum order in USDC |
| `maxBuyPrice` | Skip buys above this BTC price |
| `enabled` | Enable/disable the bot |

## Usage

### Manual Commands

```bash
# Execute daily DCA cycle
node index.js run

# Check status without trading
node index.js status

# Debug - show account balances
node index.js debug
```

### PM2 (Recommended)

```bash
# Start the bot
pm2 start ecosystem.config.js

# View logs
pm2 logs dca-bot

# Check status
pm2 status

# Stop
pm2 stop dca-bot

# Persist across reboots
pm2 save
pm2 startup
```

**PM2 Apps:**
- `dca-bot` - Main DCA cycle, runs daily at 10:00 AM
- `dca-status` - Status check every 4 hours (syncs filled orders)

## File Structure

```
coinbase_dca_trade/
├── index.js              # Main entry point
├── config.json           # Bot configuration
├── keys.json             # API credentials (git-ignored)
├── ecosystem.config.js   # PM2 configuration
├── package.json
├── src/
│   ├── auth.js           # JWT authentication
│   ├── api.js            # Coinbase API wrapper
│   ├── dca-engine.js     # Core DCA logic
│   ├── order-manager.js  # Order execution
│   ├── state-tracker.js  # State persistence
│   └── logger.js         # Transaction logging
├── data/
│   ├── state.json        # Runtime state
│   └── transactions.tsv  # Transaction log
└── logs/                 # PM2 logs
```

## State Tracking

The bot maintains state in `data/state.json`:

- Total USDC allocated vs budget
- BTC reserves (holdback)
- Outstanding sell orders (USDC and BTC)
- Cumulative fees and rebates
- Last run date (prevents duplicate runs)
- Order history with cost basis

## Transaction Log

All transactions logged to `data/transactions.tsv`:

| Column | Description |
|--------|-------------|
| Date | Transaction date |
| Type | BUY, SELL_ORDER, SELL_FILLED |
| Price | BTC price |
| BTC Amount | Amount of BTC |
| USDC Amount | Amount of USDC |
| Fees | Trading fees |
| Rebates | Fee rebates |
| Net Fees | Fees minus rebates |
| Order ID | Coinbase order ID |
| Fund Size | Current USDC fund balance |
| BTC Reserves | Total BTC reserves |
| Outstanding USDC | Value of pending sells |
| Outstanding BTC | Amount in pending sells |
| Total Fees | Cumulative fees |
| Total Rebates | Cumulative rebates |

## Safety Features

- **Max price threshold** - Skips buys when BTC exceeds `maxBuyPrice`
- **Daily run check** - Prevents duplicate runs on same day
- **Low balance handling** - Uses available USDC when below daily amount
- **Post-only orders** - Ensures sell orders are maker orders (lower fees)
- **Auto-sync** - Tracks filled sell orders and updates fund size
- **Fee accounting** - Accurate cost basis including fees and rebates

## Example Output

```
[2025-12-05T20:01:00.000Z] [INFO] Starting DCA bot (command: run)
[2025-12-05T20:01:01.000Z] [INFO] Current BTC-USDC price: 89646.33 USDC
[2025-12-05T20:01:01.000Z] [INFO] Coinbase USDC balance: 305742.87 available, 0.00 on hold
[2025-12-05T20:01:01.000Z] [INFO] Allocation: 0/10000 USDC used, buying 1000.00 USDC
[2025-12-05T20:01:02.000Z] [INFO] Placing market buy for 1000 USDC of BTC-USDC
[2025-12-05T20:01:03.000Z] [INFO] Buy filled: 0.01114100 BTC at 89646.33 USDC
[2025-12-05T20:01:03.000Z] [INFO] Fees: 1.2500 USDC, Rebates: 0.3121 USDC, Net: 0.9379 USDC
[2025-12-05T20:01:04.000Z] [INFO] Placing post-only sell for 0.01058395 BTC at 98610.96 USDC
[2025-12-05T20:01:04.000Z] [INFO] === Daily Cycle Complete ===
[2025-12-05T20:01:04.000Z] [INFO] Bought: 0.01114100 BTC at 89646.33
[2025-12-05T20:01:04.000Z] [INFO] Sell order: 0.01058395 BTC at 98610.96
[2025-12-05T20:01:04.000Z] [INFO] Holdback (reserves): 0.00055705 BTC
[2025-12-05T20:01:04.000Z] [INFO] Total BTC reserves: 0.00055705 BTC
```

## Coinbase API Setup

1. Go to [Coinbase Advanced Trade](https://www.coinbase.com/advanced-trade)
2. Navigate to Settings > API
3. Create new API key with:
   - **View** permission
   - **Trade** permission
4. Add your server's IP to the allowlist
5. Copy the API key name and private key to `keys.json`

## License

ISC
