# Critical-Mass — Plan

## Completed

- [x] **Kalshi Integration** (2026-02-17) — Imported kalshibot as new Kalshi section: 61 files, 5 crypto strategies, 34 API endpoints, 14 admin UI components. See [docs/kalshi-integration.md](./docs/kalshi-integration.md)
- [x] **Post-Integration Tuning** (2026-02-18) — Forced pre-settlement exits, strategy evaluation reorder, momentum-rider promoted to LIVE, mobile responsive admin UI
- [x] **Account Reconciliation** (2026-02-18) — Fill-based P&L rebuild from Kalshi API, fixed P&L display bug, expanded Positions page with trade history
- [x] **ATM Strategy Tuning** (2026-02-18) — Widened ATM access for momentum-rider/swing-flipper, lowered CFV entry, added entry metadata for calibration. See [STRATEGY-GUIDE.md](./STRATEGY-GUIDE.md)
- [x] **PM2 Process Isolation** (2026-02-19/20) — 6 PM2 processes: gateway + 4 engines + UI, IPC layer with WS protocol, HTTP reverse proxy for Kalshi. See [docs/pm2-architecture.md](./docs/pm2-architecture.md)
- [x] **Strategy Rebalance** (2026-02-20) — Disabled CFV, re-enabled gamma-scalper, bumped sniper sizing, fixed CFV enter-then-dump bug. See [docs/kalshi-integration.md](./docs/kalshi-integration.md#strategy-rebalance-history-2026-02-20)
- [x] **PM2 Log Viewer** (2026-02-20) — Live log streaming over Socket.IO, LogViewer component with tail/auto-scroll/fullscreen, logs tab on all exchanges + gateway
- [x] **Swing Flipper Admin UI + Auto-Tune Persistence** (2026-02-20) — 15-param admin config for swing-flipper, auto-tune state persisted to config.json

## In Progress

- [ ] **Sigma Calibration** — Predicted/realized ratio averages 1.45x, overestimates bracket probabilities. CFV unusable until fixed.

## Next Actions

1. **Fix sigma calibration model** — Analyze calibration data from journal window summaries, adjust vol scaling to bring predicted/realized ratio closer to 1.0
2. **Add `/api/health` endpoint** — Aggregate engine health across all PM2 processes, expose per-engine memory/uptime/connectivity status
3. **Hedged BTC + prediction market insurance engine** — Design strategy combining spot BTC positions with Kalshi bracket hedging
4. **Per-engine memory tuning** — Profile each PM2 process under load, set `max_memory_restart` appropriately in ecosystem.config.cjs

## Documentation

- [PM2 Architecture](./docs/pm2-architecture.md) — Process layout, IPC layer, engine ports, gateway routing
- [Kalshi Integration](./docs/kalshi-integration.md) — File structure, isolation guarantees, reconciliation, strategy history
- [Fill Ledger Sell Linkage](./docs/fill-ledger-sell-linkage.md) — Buy→sell annotation, stale reference repair
- [Strategy Guide](./STRATEGY-GUIDE.md) — Parameter rationale, what was tried, what failed
