# Changelog

All notable changes to this project will be documented in this file.

## [2.3.16] - 2026-02-01

### Added
- Live state persistence for regime engine - saves position and regime state to `regime-state.json` for faster recovery on restarts
- Offline order fill detection - checks for TP and entry orders that filled while the engine was offline
- Market re-evaluation on startup - re-anchors volatility triggers after downtime and logs price movement warnings
- `restoreState()` method to regime-detector for restoring regime mode on restart
- `getPendingEntries()` method to both order-executor and dry-run-executor for tracking pending entry orders

### Changed
- Live mode startup now: loads saved state → recovers from exchange → checks offline fills → re-evaluates position
- Periodic state saves every 5 minutes for live mode (dry-run unchanged at 60 seconds)

## [2.3.5] - 2026-02-01

### Added
- Responsive layout for admin dashboard (1280px → 1600px → 1800px breakpoints)
- Live D3.js charts for Regime Dashboard: price sparkline, volatility chart, regime timeline
- `useChartDataBuffer` hook for 15-minute rolling WebSocket data accumulation
- 4-column layout on 3xl screens (1920px+) with dedicated charts column

## [2.3.0] - 2026-01-31

### Added
- Fibonacci DCA strategy - alternative to fixed-amount DCA using Fibonacci sequence for buy amounts (1, 1, 2, 3, 5, 8, 13... × base amount)
- Consolidated sell order per Fibonacci cycle with weighted-average cost basis pricing
- Automatic cycle reset when consolidated sell fills, enabling continuous volatility harvesting
- Fibonacci backtest simulation with cycle tracking and Fibonacci-specific metrics
- Strategy selector in admin UI with detailed risk disclosure about the volatility-harvesting approach

## [2.2.1] - 2026-01-31

### Fixed
- Hardcoded "BTC" in order consolidation logs now dynamically uses actual trading pair currency (e.g., CRO)

## [2.2.0] - 2025-01-31

### Fixed
- Crypto.com API big integer precision loss - order IDs exceeding JavaScript's MAX_SAFE_INTEGER are now preserved as strings
- Crypto.com order status parsing - corrected field access path for nested `order_info` response structure
- Crypto.com order field mappings updated to use `cumulative_quantity`, `cumulative_value`, and `cumulative_fee`

### Added
- Full timestamp support in transaction logs with automatic schema migration for existing data
- Transactions UI now displays full datetime (YYYY-MM-DD HH:MM:SS) when timestamp data is available

### Changed
- Force IPv4-first DNS resolution (`--dns-result-order=ipv4first`) for API stability
- TSV parser preserves Timestamp column as string alongside Date

### Chores
- Added `.playwright-mcp` to .gitignore

## [2.1.1] - 2025-01-25

### Fixed
- Add 1hour interval type to estimated end date calculation

## [2.1.0] - 2025-01-23

### Added
- Crypto.com exchange adapter
- Optimizer enhancements
- UI improvements

## [2.0.0] - 2025-01-22

### Added
- P&L metrics (unrealized $, unrealized %, realized)
