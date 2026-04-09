# Upgrade Notes

Step-by-step instructions for breaking changes that require operator action.

---

## Multi-Pair Funds (Unreleased)

**Affects everyone.** This release reorganizes on-disk state into per-fund subdirectories so a single exchange can host multiple trading funds (e.g. BTC-USDC and ETH-USDC on Coinbase). The migration runs automatically the first time an engine starts after the upgrade — but it **refuses to run while engines are live**, so you must stop them first.

### TL;DR

```bash
pm2 stop ecosystem.config.cjs    # 1. stop everything
git pull                          # 2. pull this version
npm run build                     # 3. rebuild the admin UI
pm2 start ecosystem.config.cjs    # 4. start engines — migration runs automatically
pm2 logs critical-mass-coinbase   # 5. confirm "Pair migration complete"
```

### Why

The system now treats a "fund" as a `(exchange, pair)` tuple instead of an `exchange` alone. State files move from `data/<exchange>/state.json` (etc.) into `data/<exchange>/<pair>/state.json` so multiple funds on the same exchange don't collide. The per-fund subdirectories also hold the regime state, fill ledger, chart buffer, transactions log, price caches, long-term candle store, and the regime-engine-running auto-resume flag.

### What the migration does

For each configured exchange (`coinbase`, `gemini`, `cryptocom`):

1. Detects the legacy layout by looking for `data/<exchange>/state.json` or `data/<exchange>/regime-state.json`.
2. Reads the exchange's `productId` from `config.json` to determine the default pair name (e.g. `BTC-USDC` for coinbase, `BTCUSD` for gemini, `CRO_USD` for cryptocom).
3. Moves these per-fund files into `data/<exchange>/<defaultPair>/`:
    - `state.json`, `regime-state.json`, `fill-ledger.json`
    - `transactions.tsv`, `chart-data-buffer.json`
    - `optimizer-cache.json`, `pending-corrective-buys.json`
    - `regime-engine-running.json` (the auto-resume flag — moves so resume still works)
    - `dry-run-state.json`
    - All `*price-cache-*.json` files (e.g. `btc-price-cache-5min.json`, `btcusd-price-cache-1hour.json`)
    - All `long-term-candles-*.json` files
    - All `.backup-*` files associated with the above
4. Migration is idempotent — running it twice is a no-op.

### Safety guarantees

- The migration **refuses to run if any `regime-engine-running.json` flag is present**, either at the legacy or new path. This prevents the running engine from saving state on top of the migration mid-flight (per the project's `CLAUDE.md` runtime-state safety rule).
- If the migration fails for any reason, the engine process logs an error and `process.exit(1)` — it will NOT silently continue with mixed-layout state.
- The migration uses `fs.renameSync` (atomic move) and refuses to overwrite existing files at the target path. If it sees a conflict (e.g. you started the new code, generated a partial new layout, then tried to restart with old files still around), it logs the conflict and skips that specific file rather than clobbering anything.

### Manual recovery if migration is blocked

If the engine logs `Refusing to migrate <exchange>: regime engine is running` after `pm2 stop`, look for stale `regime-engine-running.json` flag files:

```bash
find data -name 'regime-engine-running.json'
# If you confirm no engine is actually running, delete the stale flags:
rm data/coinbase/regime-engine-running.json
rm data/gemini/regime-engine-running.json
rm data/cryptocom/regime-engine-running.json
pm2 start ecosystem.config.cjs
```

### After upgrading

- The admin UI Overview shows one card per fund. Existing single-pair installs see exactly one card per exchange (matching the old behavior).
- The **+ Add Fund** button in the Overview header lets you create a new pair on any existing exchange. New funds start `enabled=false` and `dryRun=true` for safety — review the regime config in the new fund's Config tab before enabling.
- All existing API routes (e.g. `/api/coinbase/regime/status`) continue to return data for the exchange's default fund. Routes accept an optional `?pair=ETH-USDC` query parameter to target a non-default fund.

### Backwards compatibility

- **Config file**: untouched. The legacy flat format (`exchanges.coinbase.productId`, `.regime`, etc.) keeps working. When you add a second fund via the Add Fund modal, the exchange block is converted to the new nested `pairs` map — single-fund exchanges stay flat.
- **State files**: migrated automatically as described above.
- **API**: all existing routes work unchanged for default-pair access.
- **PM2**: still one process per exchange. Multiple funds share the same engine process and the same API key set.

### Out of scope for this release

- API key isolation per fund (all funds on an exchange share the exchange's API key).
- A UI for moving capital between funds.
- Pair-aware variants of the backtest, optimizer, transactions, charts, and keys pages — these still target the exchange's default fund. They'll be updated in a follow-up.

---
