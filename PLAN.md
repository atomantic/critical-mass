# Coinbase DCA Trading Bot

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
