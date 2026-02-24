# Kalshi Integration

## Overview

Kalshi prediction market trading engine integrated into critical-mass (2026-02-17). Supports 5 crypto-bracket strategies with live and dry-run modes.

## File Structure

**Server (31 JS files in `src/kalshi/`):**
- `src/kalshi/adapters/` — 6 files (auth, api, markets, websocket, index, polymarket-websocket)
- `src/kalshi/services/` — 16 files (all services including price-bridge.js)
- `src/kalshi/engines/simulation-engine.js` — Full CJS simulation engine
- `src/kalshi/strategies/` — 7 files (base, index, 5 crypto strategies)
- `src/kalshi/types/` — 4 files (JS + .d.ts type definitions)
- `src/adapters/gemini/websocket.js` — Gemini WebSocket adapter (shared with trading engine)
- `src/adapters/cryptocom/websocket.js` — Crypto.com WebSocket adapter (shared with trading engine)

**Routes:** `src/routes/kalshi-routes.js` — 34+ endpoints under `/api/kalshi/`

**Config:**
- `config.json` — `kalshi.enabled` flag
- `src/config-utils.js` — `getKalshiConfig()` export

**Data:** `data/kalshi/` — config, keys, state, state-dry-run, conviction-tracker, journals/, snapshots/

**Admin UI:** 14 JSX components in `admin/src/components/kalshi/`, 5 WebSocket hooks

## Isolation Guarantees

- All data under `data/kalshi/`
- All API routes under `/api/kalshi/`
- All Socket.IO events prefixed with `kalshi:`
- Price bridge: one WS connection per exchange (replaces standalone Coinbase WS)
- Existing exchange engines completely unaffected

## Account Reconciliation

Service at `src/kalshi/services/account-reconciliation.js` fetches all fills from Kalshi API and rebuilds P&L from ground truth. Endpoints: `GET/POST /api/kalshi/account/reconcile`.

## Strategy Rebalance History (2026-02-20)

Based on 4 days of live + shadow trading data:
- **Disabled CFV** — 0% live win rate, -$134 P&L, sigma model overpredicts vol by 1.45x
- **Re-enabled Gamma Scalper** — +$172 shadow P&L, 35% win rate, 12:1 asymmetric payoff
- **Bumped Sniper sizing** — kellyFraction 0.12→0.15, maxBetPct 0.03→0.04 (75% win rate, +$105 P&L)
- **Fixed CFV enter-then-dump bug** — minSecondsToSettlement (30s) < forceExitSeconds (60s) caused immediate forced exits

## Auto-Tune Persistence

Auto-tune enable/disable state is persisted to `config.json` and synced on startup via the status endpoint.

See also: [STRATEGY-GUIDE.md](../STRATEGY-GUIDE.md) for detailed parameter rationale.
