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

## Next Steps

1. Set kalshi.enabled: true in config.json to activate
2. Add Kalshi API keys via the UI (/kalshi/config/keys)
3. Test dry-run mode first
4. Future: Hedged BTC + prediction market insurance engine
