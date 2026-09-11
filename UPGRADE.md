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

You don't strictly *have* to stop PM2 first — the migration runs at engine startup before any state is loaded, so it's safe to do `pm2 restart all` instead. Stopping first just gives you a clean checkpoint to compare against.

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

- The migration runs **before** anything else on engine startup, so the new engine in the same process hasn't started yet and the previous engine in the previous process is by definition dead (PM2 wouldn't be spawning a new process otherwise). It's always safe to run.
- If the migration fails for any reason, the engine process logs an error and `process.exit(1)` — it will NOT silently continue with mixed-layout state.
- The migration uses `fs.renameSync` (atomic move) and refuses to overwrite existing files at the target path. If it sees a conflict (e.g. you started the new code, generated a partial new layout, then tried to restart with old files still around), it logs the conflict and skips that specific file rather than clobbering anything.
- It also cleans up empty pair subdirectories that the API server might have accidentally created before the engine ran (e.g. from gateway requests using `?pair=` before migration completed).

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

## Backup Archives Carry Their Configuration (Unreleased)

**Affects anyone restoring a backup onto a different machine or a fresh clone.**

### Why

`data/config.json` stores only the *difference* between your effective configuration and the machine-local base `config.json` (or, on a fresh clone, the shipped `config.example.json`). If your funds are defined in the base file — the normal native-install layout — then saving an unchanged configuration produces an empty override, and a backup of the data directory carried **no fund identity at all**.

Restoring such an archive onto a fresh clone recovered the state files of, say, `coinbase/ETH-USDC` with a `1234` allocation, while the destination's effective configuration still said `BTC-USDC` at `10000`. The original fund was stranded and its capital settings were lost.

### What changed

- Archives now contain **`backup-manifest.json`**: a versioned, schema-allowlisted snapshot of the *effective* non-secret configuration — every configured pair identity, its capital settings and its full regime (strategy) block, already materialized so it depends on no base file.
- Restore validates the manifest, reconstructs `data/config.json` against **the destination's** base config, and verifies in memory that loading the result reproduces the archived funds — all **before** a single destination file is written.
- Secrets never enter the manifest: `notifications` (Telegram bot token) and `sentinel` (AI classification credentials) are excluded by allowlist, and a restore leaves the destination's own copies of both untouched. API keys (`*-keys.json`) are excluded from the archive as before.
- The restore confirmation screen (Settings → Backups) shows a pre-flight compatibility report listing exactly which funds the archive would restore.

### Restoring an OLD archive (taken before this release)

Old archives have no manifest, so they cannot be made portable on their own. Restore refuses them by default rather than silently letting the destination's defaults win. You have two options:

1. **Recommended — supply the source machine's base config.** Copy the *source* install's root `config.json` and pass it to the restore API as `legacyBaseConfig`:

   ```bash
   curl -X POST http://localhost:3000/api/backups/backup-2026-01-01T00-00-00.zip/restore \
     -H 'Content-Type: application/json' \
     -d "{\"legacyBaseConfig\": $(cat /path/to/source/config.json)}"
   ```

   The archive's stored override is merged onto that base to recover what the source machine actually ran.

2. **Data-only restore.** Tick *"Restore data files only and keep this machine's current fund configuration"* in the restore dialog (or send `{"acceptLegacyWithoutBase": true}`). Your state files are recovered, but **you must configure the destination's funds yourself** so their pair identities match the restored state directories.

Archives created by this release and later need neither step.

### Future archives

An archive whose manifest version is newer than the running build is rejected with an actionable error and no destination changes — upgrade critical-mass before restoring it.

---
