# Done Log

Completed items archived from PLAN.md.

## 2026-03-27

- Celestial systems overhaul — asteroid/nebula tiers, visualizations, Systems page
- UpDown SELL signals — neutral short-TF scoring, debounce history
- Crypto.com partial TP fills — handle partial fills, fix getOpenOrders
- Fixed realizedAssetPnL inflation and multi-asset cost basis fields
- Normalized legacy TP orders to body_tp, partial fill indicator, realized P&L display
- Show total liquid realized P&L on Overview and DCA dashboard
- Per-asset realized P&L breakdown on Overview header
- Expected annual yield breakdown on Overview APY header
- Sentinel service — classifier, feed-poller, sentinel-service, routes, dashboard

## 2026-03-02

- Weekly candle infrastructure (1w) — candle-aggregator, candle-cache, candle-routes, frontend hooks
- OBV indicator — cumulative on-balance volume with linear regression slope normalization
- ADX indicator — Wilder's ADX with +DI/-DI smoothing, trending/ranging classification
- Signal engine integration — weight redistribution, weekly macro trend filter, ADX regime modulation

## 2026-02-25

- Trend-aware indicator scoring — all 6 scoring functions accept trendBias, counter-trend dampening 0.75->0.40

## 2026-02-24

- UpDown Dashboard Overhaul — fixed stale chart data, 10-chart multi-TF layout, signal recalibration
- Fix orphaned buy from TP race condition — repair script, root cause fix, defense-in-depth, prorated PnL
- UpDown Prediction System Overhaul — MACD continuous scoring, activity ratio penalty, data-driven ToD, regime tagging, contract evaluation

## 2026-02-23

- Signal Engine v2 — confluence filter, score cap, time-of-day weighting, multi-timeframe charts

## 2026-02-22

- UpDown Signal Engine v1 — 8 features: trend filter, volatility-scaled thresholds, volume surge, momentum acceleration, divergence detection, pivot points, adaptive weights, multi-candle horizon
- Scorecard Analysis System — weight history logging, analysis API, ScorecardAnalysis page

## 2026-02-21

- Standardization Phase A — created shared utilities: paths.js, time-utils.js, async-handler.js, config-validator.js, useSocketPrice.js
- Standardization Phase B — security hardening: config validation, backup symlink check, key endpoint redaction
- Standardization Phase C — server DRY cleanup: DATA_DIR centralization, timestamp formatting, existsSync guard removal
- Standardization Phase D — server bug fixes: notifier promise chain, IPC readyState guard, market-data null guard, Promise.allSettled
- Standardization Phase E — useSocketPrice generic hook extracted (~215 LOC reduced)
- Standardization Phase F — client fixes: polling cleanup, socket guard, effect splitting, timeout cleanup
- Shared BTC Price Chart & Candle Service — composable chart with overlays, shared candle hook, UpDown migration

## 2026-02-20

- PM2 Process Isolation — gateway + engines + UI, IPC layer with WS protocol
- PM2 Log Viewer — live log streaming, LogViewer component with tail/auto-scroll/fullscreen
- Health Aggregation Endpoint — GET /api/health with per-engine status/uptime/memory
- UpDown Dashboard Code Review — fixed 21 issues across signal types, expiry conversion, null safety, race conditions
