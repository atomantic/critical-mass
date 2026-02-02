# Changelog

All notable changes to this project will be documented in this file.

## [2.3.24] - 2026-02-02

### Fixed
- **Regime engine dryRun config path** - Regime engine now reads `dryRun` from exchange-level config (same as DCA engine)
  - Previously, UI toggle modified `exchanges.coinbase.dryRun` but regime engine read from `exchanges.coinbase.regime.dryRun`
  - This caused the "Dry Run" toggle to not affect the regime engine
  - Both engines now use the same config path, making the UI toggle work correctly for all strategies
- **Regime Dashboard not reflecting dryRun toggle changes** - Dashboard now receives dryRun from exchange config
  - `/api/:exchange/regime/config` endpoint now includes exchange-level dryRun value
  - UI correctly displays "Dry-Run Mode" or "Live" based on current config
- **Coinbase API endpoint change** - Updated list orders endpoint to use new batch endpoint
  - Old: `/api/v3/brokerage/orders/historical?product_id=X`
  - New: `/api/v3/brokerage/orders/historical/batch?product_ids=X`
  - This fixes 404 errors when starting the regime engine in live mode
- **Recovery no longer absorbs full account balance** - Position only tracks what regime engine traded
  - Previously, recovery would overwrite position with full account BTC balance
  - Now only fills from regime engine trades are tracked
  - Account having extra BTC from other sources is logged but not absorbed into position
- **Stop endpoint error handling** - Added proper error handling and logging for stop requests

### Changed
- Removed redundant `dryRun` field from regime config defaults (now inherited from exchange config)

## [2.3.20] - 2026-02-01

### Added
- **Auto-resume regime engine on server restart** - Engine automatically resumes if it was running before restart
  - Running flag saved when engine starts, removed when manually stopped
  - Server restarts preserve flag to enable auto-resume
- **Total liquid value for APY calculations** - APY now based on combined USDC + BTC (at current price)
  - `totalUsdcReturn` - USDC realized P&L from trading
  - `totalBtcReturn` - BTC holdback accumulated
  - `btcValueUsd` - BTC holdings valued at current market price
  - `totalLiquidValue` - Combined value (USDC + BTC at live price) used for APY projections
  - UI shows breakdown: USDC return, BTC return with USD equivalent, and combined "Live Total"
- **Dynamic TP Auto-Management** - Opt-in feature for automatic take-profit parameter adjustment
  - Records cycle analytics (optimal TP %, actual TP %, volatility context)
  - Compresses historical data into histogram buckets with time-weighted decay
  - Calculates percentiles (p25, p50, p75) from compressed + recent data
  - Periodic evaluation every N cycles (default: 5) or daily (whichever first)
  - Rate-limited adjustments (max 25% change per evaluation)
  - Safety bounds: absolute min (0.05%), absolute max (5.0%)
  - Auto-holdback set to half of tpMinPercent when auto-adjusted
  - State persisted across restarts
  - Dashboard panel shows current settings, observed percentiles, adjustment history
  - Config UI with enable toggle and all adjustment parameters

### Changed
- Performance Metrics UI redesigned to show USDC, BTC, and total liquid value separately
- Est. Daily Return now labeled "(Live Value)" to indicate it's based on combined liquid value
- BTC values now displayed with 8 decimal places for precision

## [2.3.19] - 2026-02-01

### Added
- Estimated daily USDC and BTC returns in APY metrics
  - `estimatedDailyUsdc` - projected daily USD return based on current performance
  - `estimatedDailyBtc` - projected daily BTC return (holdback accumulation rate)
  - UI displays both values alongside daily return percentage (in sats for BTC)

## [2.3.17] - 2026-02-01

### Added
- APY and performance tracking for regime engine
  - Tracks engine start time and initial capital
  - Calculates total return, daily return %, estimated annual return, and compound APY
  - Persists tracking across restarts
  - UI displays performance metrics in Position section with highlighted APY/annual return

### Fixed
- APY tracking now properly persists `engineStartTime` across restarts
- APY backfill logic: if engine started before APY tracking was added, automatically backfills start time from first filled order
- Added `engineStartTime` and `initialCapital` to PositionState typedef for proper type checking

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
