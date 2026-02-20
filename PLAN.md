# Plan: Import Kalshibot into Critical-Mass

**Status: COMPLETE** (2026-02-17)

## Summary

Consolidated kalshibot prediction market trading engine into critical-mass as a new "Kalshi" section.

## What Was Done

### Files Created/Modified

**Server (31 JS files in src/kalshi/):**
- `src/kalshi/adapters/` - 6 files (auth, api, markets, websocket, index, polymarket-websocket)
- `src/kalshi/services/` - 16 files (all services including new price-bridge.js)
- `src/kalshi/engines/simulation-engine.js` - 78KB, full CJS conversion
- `src/kalshi/strategies/` - 7 files (base, index, 5 crypto strategies)
- `src/kalshi/types/` - 4 files (JS + .d.ts type definitions)
- `src/adapters/kraken/websocket.js` - Shared Kraken adapter

**Routes:**
- `src/routes/kalshi-routes.js` - 34 endpoints under /api/kalshi/

**Config:**
- `config.json` - Added `"kalshi": { "enabled": false }` entry
- `src/config-utils.js` - Added `getKalshiConfig()` export

**Server integration:**
- `server.js` - Kalshi route mount, auto-start, graceful shutdown

**Data:**
- `data/kalshi/` - 5 template files (config, keys, state, state-dry-run, conviction-tracker)
- `data/kalshi/journals/` and `data/kalshi/snapshots/` directories

**Admin UI (14 components + 5 hooks):**
- `admin/src/components/kalshi/` - 14 JSX components
- `admin/src/hooks/` - 5 WebSocket hooks
- `admin/src/App.jsx` - Kalshi routes and navigation added
- `lucide-react` dependency installed

**Total: ~61 new files**

### Architecture

- Kalshi is disabled by default (config.json -> kalshi.enabled: false)
- All Kalshi data isolated under data/kalshi/
- All API routes under /api/kalshi/
- All Socket.IO events prefixed with kalshi:
- Price bridge replaces standalone Coinbase WS (one WS per exchange)
- Existing exchange engines completely unaffected

### Verification

- All src/kalshi/ files use CJS (require/module.exports) - PASS
- All 32 server modules load without errors - PASS
- Server boots cleanly - PASS
- Admin build completes without errors - PASS
- Kalshi routes isolated, no conflicts - PASS
- Socket.IO events all prefixed - PASS

## Post-Integration Changes (2026-02-18)

- Added forced pre-settlement exits to CFV (60s) and momentum-rider (45s safety net) to avoid binary settlement risk
- Reordered strategy evaluation: pre-settlement-exit strategies first (gamma-scalper, momentum-rider) before settlement-riding strategies (CFV, sniper)
- Promoted momentum-rider to LIVE based on 2/2 wins
- Enabled Kalshi in config.json (kalshi.enabled: true)
- Fixed admin UI mobile responsiveness for exchange selector and sub-nav

## Account Reconciliation (2026-02-18)

- Added account reconciliation service (`src/kalshi/services/account-reconciliation.js`) that fetches all fills from Kalshi API and rebuilds P&L from ground truth
- Added GET/POST `/api/kalshi/account/reconcile` endpoints for preview and apply
- Fixed P&L display bug in Positions UI: analytics data is in dollars, but `formatCents()` was dividing by 100 again
- Fixed open positions showing 0-contract settled entries from API
- Expanded Positions page with trade history table, strategy breakdown, and analytics summary
- Added `min_ts` to FillsQueryParams type definitions

## ATM Strategy Tuning (2026-02-18)

- Tuned momentum-rider for ATM bracket access: entryThreshold 65→45, maxEntryPrice 80→70, profitTarget 15→10, added stopLoss 10
- Widened swing-flipper ATM range: minContractPrice 30→25, maxContractPrice 60→65, minOscillationRange 12→10
- Lowered CFV minEntryPrice 15→8 (YES-side at 8-9c has real market maker asks)
- Added entry metadata (edge, sigma, fairProb, marketProb, btcSpot) to settlement records for calibration
- Added sigmaCalibration to journal window summaries
- Updated STRATEGY-GUIDE.md with full rationale

## PM2 Process Isolation (2026-02-19)

**Status: Phase 3 COMPLETE** — Kalshi+Hedge and Coinbase engines extracted into separate PM2 processes.

### Architecture

```
┌──────────────────────────────────┐
│   critical-mass (:5563)          │  API gateway, Socket.IO hub, admin UI,
│   server.js                      │  DCA scheduler, backup, notifier, settings
└────────┬─────────┬───────────────┘
    IPC WS    HTTP proxy + IPC WS
         │         │
┌────────┴──┐  ┌───┴──────────────────┐
│ cm-coinbase│  │ cm-kalshi            │
│ IPC :5570  │  │ HTTP :5572, IPC :5573│
│            │  │                      │
│ Regime eng │  │ Kalshi sim engine    │
│ Market data│  │ Hedge engine         │
│ Chart buf  │  │ Own CB public WS     │
│ CB/Gem WS  │  │ Own CB adapter       │
└────────────┘  └──────────────────────┘
```

### What Was Done

**Phase 1 — IPC Layer:**
- `src/ipc/ipc-protocol.js` — Message types, serialization, UUID correlation
- `src/ipc/ipc-server.js` — WS server for engine processes (request/response)
- `src/ipc/ipc-client.js` — WS client for gateway (auto-reconnect, backoff)
- `src/ipc/socket-io-proxy.js` — Drop-in `io` replacement forwarding over IPC
- `src/ipc/http-proxy.js` — Lightweight HTTP reverse proxy (Node built-in)
- `src/shared-utils.js` — Extracted shared utilities from server.js

**Phase 2 — Kalshi+Hedge Engine:**
- `engines/kalshi-engine.js` — Own Express (:5572), IPC WS (:5573)
- Gateway proxies `/api/kalshi/*` and `/api/hedge/*` via HTTP reverse proxy
- Gateway forwards Kalshi Socket.IO events via IPC client

**Phase 3 — Coinbase Engine:**
- `engines/coinbase-engine.js` — IPC WS (:5570), handles all spot exchanges
- All regime engine lifecycle moved to engine process (auto-resume, market data)
- `src/routes/regime-routes.js` rewritten as IPC proxy (config stays file-based)
- `src/routes/exchange-routes.js` uses IPC for regime config updates
- `src/routes/settings-routes.js` uses IPC for backup-restore engine stop
- Gateway (server.js) is now a thin API proxy — no direct engine management

**ecosystem.config.cjs:**
- 4 PM2 processes: critical-mass (gateway), critical-mass-kalshi, critical-mass-coinbase, critical-mass-ui

**Phase 4 — Gemini & Crypto.com Engine Isolation (2026-02-20):**
- `engines/coinbase-engine.js` — Generalized to read `EXCHANGE_NAME` env var, single-exchange startup
- `engines/gemini-engine.js` — Thin wrapper setting `EXCHANGE_NAME=gemini` and IPC port 5571
- `engines/cryptocom-engine.js` — Thin wrapper setting `EXCHANGE_NAME=cryptocom` and IPC port 5574
- `server.js` — Added `geminiIPC`/`cryptocomIPC` clients, `exchangeIPCMap` for per-exchange routing
- `src/routes/regime-routes.js` — Routes IPC by exchange name via `getIPC(exchange)`
- `src/routes/exchange-routes.js` — Same `exchangeIPCMap` pattern
- `src/routes/settings-routes.js` — Backup restore sends stop-all to all engines in parallel
- `ecosystem.config.cjs` — 6 PM2 processes: gateway, kalshi, coinbase, gemini, cryptocom, ui

### Remaining

- Phase 5: Add `/api/health` aggregating engine health, per-engine memory tuning

## Kalshi Strategy Rebalance (2026-02-20)

Based on 4 days of live + shadow trading data:

- **Disabled CFV** (0% live win rate, -$134 P&L, sigma model overpredicts vol by 1.45x)
- **Re-enabled Gamma Scalper** (+$172 shadow P&L, 35% win rate, 12:1 asymmetric payoff)
- **Bumped Sniper sizing** (kellyFraction 0.12→0.15, maxBetPct 0.03→0.04) — 75% win rate, +$105 P&L
- **Fixed CFV enter-then-dump bug**: minSecondsToSettlement was 30s but forceExitSeconds was 60s, causing immediate forced exits on new positions. Set minSecondsToSettlement to 90s.

## PM2 Log Viewer (2026-02-20)

- Added live PM2 log streaming over Socket.IO (server.js: `logs:subscribe`, `logs:unsubscribe`, `logs:flush`)
- Created `useLogStream` hook — subscribes to log events, 2000-line circular buffer, clear/flush controls
- Created `LogViewer` component — tail-lines dropdown, auto-scroll, stderr in red, fullscreen mode, flush with toast feedback
- Added "Logs" tab to all exchange pages (`/:exchange/:pair/logs`)
- Added "Logs" tab to Kalshi and Hedge sub-navs
- Added "Gateway" link in header nav → `/gateway/logs` for the gateway process logs
- Process allowlist: `critical-mass`, `critical-mass-coinbase`, `critical-mass-gemini`, `critical-mass-cryptocom`, `critical-mass-kalshi`

## Swing Flipper Admin UI + Auto-Tune Persistence (2026-02-20)

- Added `swing-flipper` strategy config to admin StrategiesConfig (15 params: ATM price range, oscillation detection, pullback entry, take-profit/stop-loss, time exit, collapse detection, sizing)
- Persisted auto-tune enable/disable state to `config.json` so it survives PM2 restarts
- Added startup sync: auto-tune status endpoint reads persisted config on first check

## Next Steps

1. Fix sigma calibration (predicted/realized ratio averages 1.45x — overestimates bracket probabilities)
2. Future: Hedged BTC + prediction market insurance engine
