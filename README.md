<p align="center">
  <img src="logo.svg" alt="Critical Mass logo" width="128" height="128" />
</p>

# Critical Mass

Multi-exchange crypto accumulation engine with adaptive regime detection and celestial position management.

> **Disclaimer:** This software trades real money on cryptocurrency exchanges. Use at your own risk. The authors are not responsible for any financial losses. Always start with dry-run mode and small allocations to verify behavior before committing real capital.

<p align="center">
  <img src="docs/app_1.png" alt="Critical Mass Dashboard" width="800" />
</p>

<p align="center">
  <img src="docs/app_2.png" alt="Critical Mass Systems" width="800" />
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
- **Backtesting** - Simulate Simple DCA against historical data (excludes the regime strategy)
- **Parameter Optimizer** - Compare Simple DCA settings via grid search
- **Dry-Run Mode** - Test strategies without real trades
- **Notifications** - Configurable alerts for fills, errors, and regime changes
- **Backup & Restore** - Automatic state backups with pruning

Simulation HTTP endpoints enforce bounded, server-side request and concurrency
limits; see [Simulation endpoint limits](docs/simulation-limits.md).
- **Health Monitor** - Tracks WebSocket connectivity, latency, rate limits, and error rates
- **PM2 Support** - Production-ready process management

## Requirements

- Node.js 22.12.0 or newer. Production accounting synchronously loads shared ESM modules, and the locked admin toolchain also requires Node 22.12 or newer on the Node 22 line.
- PM2 available on your `PATH` for the production commands below (installed separately from the project dependencies)
- `lsof` for the native npm startup port checks
- `zip` and `unzip` for creating, listing, and restoring full backup archives
- Exchange API key with View and Trade permissions

For a native install, confirm both archive tools are available on `PATH` before
relying on full backups or restores:

```bash
command -v zip
command -v unzip
```

The Docker image already installs `zip` and `unzip`. Hourly fund-state snapshots
are separate JSON recovery points and do not use these tools; they are not a
replacement for a full backup archive.

## Installation

### Operator authentication

The gateway starts in a fail-closed bootstrap state until the first operator password is enrolled. With no password or bootstrap credential, it binds loopback-only and generates a one-time owner-only secret at `data/operator-bootstrap-secret`; open the local admin UI and create the password there, entering that secret (a loopback connection alone is not trusted, because a same-host reverse proxy that adds no headers looks identical to a local browser; set `OPERATOR_TRUST_LOOPBACK_BOOTSTRAP=true` only when no reverse proxy is in front). The file is deleted on enrollment. Then restart the gateway to enable its default Tailscale listener. To bootstrap over Tailscale or another non-loopback listener, set a one-time `OPERATOR_BOOTSTRAP_SECRET` of at least 32 bytes (for example, `openssl rand -hex 32`) and enter it in the setup screen. The secret is accepted only before first enrollment and is never returned by the API or written to logs.

The password is stored as a scrypt hash in `data/operator-auth.json`. After sign-in, a signed HttpOnly, SameSite=Strict browser session is renewed on each visit and remains valid for 30 days; HTTPS sessions are also Secure. Changing or removing the password invalidates existing sessions. Removing the password restarts the gateway in fail-closed bootstrap mode so stale non-loopback listeners do not remain open. With `OPERATOR_TRUST_LOOPBACK_BOOTSTRAP=true`, a local reverse proxy must send `X-Forwarded-For` with the real client address (requests carrying `Forwarded`, `Via`, `X-Real-IP`, other `X-Forwarded-*` markers, or an empty `X-Forwarded-For` are never treated as local). A proxy that adds no headers at all cannot be told apart from a local browser, so in that mode configure it to set `X-Forwarded-For` (nginx: `proxy_set_header X-Forwarded-For $remote_addr;`). By default (flag unset) loopback is not trusted and enrollment needs the generated secret or `OPERATOR_BOOTSTRAP_SECRET`.

Sign-in attempts are throttled per peer (5 failures per minute); successful sign-ins do not count. Behind a reverse proxy or published Docker port every client shares one socket address, so set `OPERATOR_TRUST_PROXY=true` to key the budget on the last `X-Forwarded-For` hop (the address your trusted proxy wrote; earlier hops are client-controlled).

Docker Compose and Umbrel must bind the container interface for their local proxy. On a fresh container start, the entrypoint therefore generates the one-time credential at `data/operator-bootstrap-secret` with owner-only permissions; read that file from the mounted app data directory and enter it in the setup screen. Successful enrollment deletes the file. You can instead supply `OPERATOR_BOOTSTRAP_SECRET` explicitly; rotate it before restarting after password removal because an already-consumed value remains invalid.

AI provider execution is fail-closed: only OpenAI-compatible API providers can be saved, tested or run (CLI providers are not supported), and their origins must be listed in `AI_ALLOWED_ENDPOINTS` (comma-separated exact origins such as `https://api.openai.com`).

The same origin grant applies to UpDown screenshot analysis and Sentinel AI classification, including redirects. RSS feeds use public-address validation independently of the AI origin grant.

```bash
git clone https://github.com/atomantic/critical-mass.git
cd critical-mass
npm run install:all   # Install both server and admin UI dependencies
cp config.example.json config.json  # Copy example config and customize
```

### Docker Compose on Linux

The rootful Docker daemon creates missing bind-mount sources as root-owned
directories. Prepare the persistent directories before the first Compose
start:

```bash
sudo ./scripts/prepare-docker-storage.sh
docker compose up -d --build
# With alpine:3.20 and node:22-alpine already cached:
npm run test:docker-storage
```

The application container runs as numeric UID/GID `1000:1000`. The preparation
script creates new `data/` and `logs/` directories with that ownership and mode
`700`. It never recursively changes an existing directory: if either path
already exists with another owner, it stops and prints the explicit ownership
correction needed. The Compose bind mounts also refuse missing paths, and the
entrypoint reports an actionable error before generating a bootstrap secret if
the mounted paths are not writable.

This preparation step is for the rootful Linux Compose deployment only. Do not
run it against an Umbrel-managed `APP_DATA_DIR`; Umbrel owns those host paths.

## Configuration

### API Keys

> **Tip:** You can also configure exchange API keys directly in the admin dashboard UI (the **API Keys** tab) instead of editing files by hand. The UI writes the same `data/<exchange>-keys.json` files described below.

Create exchange-specific key files in the `data/` directory:

**Coinbase** (`data/coinbase-keys.json`):

> **Important:** Critical Mass requires **Coinbase Advanced API** credentials via the [Coinbase Developer Platform (CDP)](https://cloud.coinbase.com/access/api), **NOT** the regular/legacy Coinbase API (`coinbase.com/settings/api`). Standard Coinbase API keys are incompatible and will fail to authenticate.

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
| `holdbackRatio` | Base share of gross TP profit allocated to retained asset (0–1, default 0.5); tier-adjusted and capped at 0.95 |
| `maxUsdcDeployed` | Maximum capital deployed at once |
| `maxAssetExposure` | Maximum base asset exposure (0 = uncapped) |
| `ladderSizeMode` | Ladder sizing: `flat`, `linear`, `sqrt`, `fibonacci` |

For regime `holdbackRatio`, gross TP profit is position quantity × (target price − average cost). The engine multiplies the configured ratio by the body tier’s `holdbackScale`, caps the effective share at 0.95, and converts that share of profit to asset at the target price; the rest of the position is sized for sale. For example, with 0.01 BTC at an average cost of $100,000/BTC, a target of $110,000/BTC, ratio 0.5 and tier scale 1, gross profit is $100: $50 represents about 0.00045455 BTC of retained value, leaving about 0.00954545 BTC to sell (about 4.55% retained). This illustration excludes fees and rounds quantities to eight decimals; actual placement also applies quantity rounding, a minimum holdback, fee floors and exchange minimums. It is not a guaranteed net return. Simple DCA’s separate `holdbackPercent` setting retains its own meaning.

## Usage

### Native environment settings

For native installs, copy `.env.example` to `.env` in the repository root and
edit the settings before starting. PM2, `node server.js`, `node index.js`, and
`npm run dev` load that file before reading configuration, regardless of the
launch directory. Existing shell environment values take precedence. A missing
file is allowed; an unreadable file stops startup without printing its values.
Only `.env` is loaded, not variants such as `.env.local`.

Restart after changing settings. For PM2, use `npm start` to recreate the
processes with fresh values. `npm run pm2:start` and `npm run pm2:restart` use the
same sequence: stop and confirm the gateway first while engines remain available
for its drain, then stop the engines and development UI, recreate the processes,
and save the PM2 list only after all five report online. Engines are launched
before the gateway; this does not wait for fund initialization or migration, so
follow [UPGRADE.md](UPGRADE.md) when upgrading on-disk state. A failed stop or
port check aborts startup; inspect the error and PM2 status before retrying.
`npm run pm2:stop` uses the same shutdown order and keeps process registrations.
PM2 and the combined development launcher still use their configured service ports.

Local environment files are ignored by Git and Docker. Compose/Umbrel deployments
continue to inject environment settings through their container configuration;
they do not need a repository `.env` inside the image. Compose's host-side
`.env` interpolation is separate from the native application loader.

### Admin Dashboard (Recommended)

**Development (with hot-reload)**

`npm run dev` (`scripts/dev.js`) starts exactly two children: the gateway
(`server.js`) and the Vite UI. It does not start any exchange engine. The gateway
reaches the engines over IPC, so without running engines the dashboard loads but
regime commands fail with HTTP 503 `Engine unavailable: IPC not connected`.
Start the three engines first, with PM2 selecting only them:

```bash
npm install -g pm2   # One-time prerequisite
pm2 start ecosystem.config.cjs --only critical-mass-coinbase,critical-mass-gemini,critical-mass-cryptocom
pm2 describe critical-mass-coinbase critical-mass-gemini critical-mass-cryptocom   # verify: status "online"
npm run dev
```

When finished, stop and remove only those processes:

```bash
pm2 delete critical-mass-coinbase critical-mass-gemini critical-mass-cryptocom
```

Warnings:
- Stop any production gateway/UI (`critical-mass`, `critical-mass-ui`) before running `npm run dev`; both use the same ports.
- Engines auto-resume configured funds on start. Use a separate development checkout/configuration with funds disabled or `dryRun: true` so no real orders are placed.
- See [docs/pm2-architecture.md](docs/pm2-architecture.md#development-topology) for the topology.

**Production**

```bash
npm install -g pm2   # One-time prerequisite for a native install; Docker includes PM2
npm run build
npm run pm2:start
```

**URLs:**
- **API/Production UI:** http://localhost:5570
- **Dev UI (hot-reload):** http://localhost:5571

### CLI Commands

`run` and `status` write the fund's `state.json`, so they refuse while the gateway is running (it owns those writes — use the dashboard instead, or stop the stack first). `run` also requires Simple DCA to be enabled, matching the gateway's scheduler.

```bash
# Complete one interval cycle for an exchange (places trades unless dry-run)
node index.js run --exchange coinbase
node index.js run -e gemini

# Check status without placing new trades (may reconcile and save existing fills)
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

For upgrades and whole-stack restarts, do not use `pm2 restart all`. Follow the ordered, Critical Mass-only procedure in [UPGRADE.md](UPGRADE.md) (stop the gateway first, then engines; start engines first, then the gateway). Shutdown grace intervals (gateway 35 s, engines 25 s) are described in [docs/pm2-architecture.md](docs/pm2-architecture.md).

## Testing

```bash
npm test
```

The gateway retains Express as an accepted framework dependency; see the
[HTTP framework decision](docs/gateway-http-dependency.md) for its scope,
maintenance obligations and criteria for revisiting it.

## Safety Features

- **Max price threshold** - Skips buys above `maxBuyPrice`
- **Capital limits** - `maxUsdcDeployed` and `maxAssetExposure` caps
- **Drawdown protection** - Pauses trading if drawdown exceeds threshold
- **Flash crash detection** - Detects extreme price moves; when `cancelEntriesOnFlash` is enabled, cancels resting reactive entries
- **Spread monitoring** - Pauses new reactive entries if bid-ask spread is too wide
- **Rate limit tracking** - Backs off when approaching exchange limits
- **Stale data protection** - Pauses if market data feed goes stale
- **Duplicate prevention** - Only runs once per interval (DCA mode)
- **Dry-run mode** - Test configuration without real trades
- **Post-only orders** - Ensures sell orders are maker orders for lower fees
- **Auto-sync** - Detects filled sell orders and updates fund balance
- **Fee accounting** - Accurate cost basis including fees and rebates
- **Automatic backups** - Periodic state backups with configurable retention

Depth-based entry protection is unavailable in this build: the engine does not
supply order book depth to the guard. Stored `minDepthUsdc` and `depthPauseMs`
values do not provide that protection. Ladder mode deliberately bypasses the
spread and flash entry guards and leaves resting ladder rungs in place; health,
drawdown, and capital checks still apply to new ladders.

## Exchange Setup

### Coinbase

> **Important:** You must use the **Coinbase Advanced API** via the [Coinbase Developer Platform (CDP)](https://cloud.coinbase.com/access/api), **NOT** the regular/legacy Coinbase API (`coinbase.com/settings/api`). Standard/legacy Coinbase API keys do not support the required EC private key authentication and will fail.

1. Go to the [Coinbase Developer Platform (CDP) API Keys](https://cloud.coinbase.com/access/api) portal
2. Create a new API key with **View** and **Trade** permissions under Advanced Trade (leave **Transfer** off). Open **Advanced settings** and set the signature algorithm to **ECDSA**. The portal's default (**Ed25519**) will not work.
3. Add your server's IP to the IP allowlist (recommended)
4. Download or copy your API credentials:
   - **API Key Name**: Formatted as `organizations/{org-id}/apiKeys/{key-id}`
   - **Private Key**: The ECDSA private key in PEM format (`-----BEGIN EC PRIVATE KEY-----\n...\n-----END EC PRIVATE KEY-----\n`)
   - Ed25519 keys and standard API secrets are not supported.
5. Save the credentials via the admin UI (**API Keys** tab) or copy them to `data/coinbase-keys.json`:
   ```json
   {
     "name": "organizations/{org-id}/apiKeys/{key-id}",
     "privateKey": "-----BEGIN EC PRIVATE KEY-----\n...\n-----END EC PRIVATE KEY-----\n"
   }
   ```

### Gemini

1. Go to [Gemini API Settings](https://exchange.gemini.com/settings/api)
2. Create an account-level (**Primary**) API key with the **Trading** role. The key starts with `account-`; master keys are not supported.
3. If you enable **Requires Heartbeat**, Gemini cancels this key's open orders about 5 minutes after the last Gemini fund stops.
4. Save the API key and secret via the admin UI (**API Keys** tab) or copy them to `data/gemini-keys.json`

### Crypto.com

1. Go to [Crypto.com Exchange API Settings](https://exchange.crypto.com/settings/api)
2. Create new API key with **Trade** permissions (leave withdrawals off)
3. Copy the API key and secret to `data/cryptocom-keys.json`

## License

[MIT](LICENSE)
