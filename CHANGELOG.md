# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Added
- **Multi-pair funds (BREAKING DATA LAYOUT)** — A "fund" is now identified by `(exchange, pair)` instead of just `exchange`. One exchange can host multiple funds (e.g. BTC-USDC and ETH-USDC on Coinbase), each with its own regime config, state, fill ledger, lifecycle, and dashboard. **Requires a one-time on-disk migration** that runs automatically on engine startup. **You must stop the engines before pulling this version** — see `UPGRADE.md` for instructions. Existing single-pair installs continue to work unchanged after migration.
  - New REST endpoints: `GET /api/:exchange/funds`, `POST /api/:exchange/funds`, `DELETE /api/:exchange/funds/:pair`
  - All existing per-exchange routes accept an optional `?pair=` query parameter; default falls back to the exchange's first/legacy pair
  - New "Add Fund" button in the admin Overview opens a modal to create a new fund on an existing exchange
- **Drain-and-Close fund lifecycle** — Each fund has a `lifecycle` field (`active` / `draining` / `closed`). The "Close Fund" button in the admin header marks the fund draining: blocks new entries immediately, leaves the active take-profit order in place, and when the cycle's TP fills the engine auto-stops and the fund transitions to `closed`. Reopening requires an explicit click. New IPC channels: `regime:close`, `regime:reopen`. New REST endpoints: `POST /api/:exchange/regime/close`, `POST /api/:exchange/regime/reopen`.
- **`simpleDcaEnabled` global config flag** - Gates simple DCA strategy behind opt-in flag (default: false); admin UI hides DCA routes/selector when disabled, API guards DCA-only endpoints
- **`onEntryCancelled` callback in order executor** - Regime engine now cleans up pendingEntryOrders when entries are cancelled (stale timeout, refresh, or external cancel)
- **Stale pending-entry purge on engine startup** - Removes saved pending entries that were filled/cancelled while engine was offline

### Fixed
- **`dcaStrategy` config-validator enum matches engine-supported values** - `EXCHANGE_CONFIG_SCHEMA.dcaStrategy.enum` was `['fixed','regime']`, but the engine only branches on `dcaStrategy === 'fibonacci'` ('regime' is never read). Via the validated `PUT /api/:exchange/config` a client could never set the only alternate strategy the engine implements while the inert 'regime' was silently accepted. Enum is now `['fixed','fibonacci']`, aligning with `validateExchangeConfig` (#156)
- **Macro daily-trend slope now measures a real daily trend** - `macro-regime` previously snapshotted the 20-day EMA every ~5-min update cycle and used that as the "previous day's EMA," so the slope term measured a 20-day EMA's movement over 5 minutes (≈0) — silently killing up to 20 points of macro-score range. The slope is now computed statelessly from the daily EMA series (current EMA vs the EMA excluding the still-forming daily candle), making it a true daily-trend signal that's correct from the first update and across engine restarts (#153)
- **Dry-run multi-entry cycle entry price weights by per-cycle volume** - `simulateFill` now tracks each cycle's own accumulated buy quantity (`cycleQty`) and weights the multi-entry average entry price by it, instead of the global cumulative `simulatedTotalBought` (which is never reset on sells). The old basis inflated `entryPrice` on the 2nd+ entry of every cycle after the first, corrupting the operator-facing optimal-TP analytics (`optimalTpPct`/`actualTpPct`/`missedProfitPct`) (#152)
- **UpDown trades reject non-numeric cost/returnAmount** - `POST /api/updown/trades` now returns 400 when `cost` or `returnAmount` isn't a finite number, and `PUT /api/updown/trades/:id` returns 400 for non-numeric `cost`/`returnAmount`/`btcPriceAtExit`, instead of persisting NaN (serialized as null) that misclassified the win/loss filters; mirrors the position route's #108 guard
- **Coinbase getOrderFills size_in_quote handling** - `size_in_quote` is a boolean flag, not a numeric size; fills now convert quote-denominated `size` (e.g. market buys) to base currency and report the quote notional in `sizeInQuote`, mirroring `sync-fills.js` (was `parseFloat(true)` → NaN, corrupting `assetQty`/cost-basis)
- **avgPrice precision for low-priced assets** - Removed premature `roundUSDC` on avgPrice in fill-ledger aggregation so sub-cent assets (e.g. CRO at $0.08) aren't truncated
- **Self-heal body avgPrice on regime startup** - Detects and corrects bodies where avgPrice diverged >0.1% from costBasis/assetQty due to prior rounding
- **Recovery module currency parsing** - Use canonical `getBaseCurrency`/`getQuoteCurrency` helpers instead of fragile string split

### Removed
- **Remove express-rate-limit from admin server** - Single-user local dashboard doesn't need request rate limiting; was causing 429 errors on page load

### Changed
- **Remove baseSizeUsdc from aggressiveness presets** - Base size is now a platform/fund config only, no longer overridden when switching aggressiveness levels

### Fixed
- **Sync test files with btc→asset rename** - Updated 7 test files to match the source code's multi-asset field renames (roundBTC→roundAsset, btcQty→assetQty, totalBTC→totalAsset, etc.), fixing 83 test failures

### Changed
- **Divergence-based liquidity scaling** - Position sizer now scales entry size based on price divergence from average cost basis instead of buy count
  - Old: `1 + (cycleBuys * 0.1)` (scaled with order count, disconnected from market)
  - New: `1 + (divergencePct / divergenceScalePct) * (cap - 1)` (scales when price drops below avg entry)
  - First entry or no avg cost: factor 1.0 (base size)
  - New config param `divergenceScalePct` (default: 5) controls how much divergence reaches the cap
  - Size optimizer simplified to assume factor=1.0 per step (conservative; divergence acts as bonus capacity)

## [2.4.14] - 2026-02-06

### Fixed
- **ATH fetch fails on Coinbase** - Reduced daily candle request from 365 to 349 days to stay under Coinbase API's 350-candle limit

## [2.4.12] - 2026-02-04

### Changed
- **Extended chart windows to 1 hour** - Regime dashboard now shows more history
  - Regime Timeline expanded from 15 minutes to 1 hour
  - Price & ATR Triggers chart expanded from 15 minutes to 1 hour
  - Backend data buffer increased to retain 1 hour of data (4000 points max)

## [2.4.11] - 2026-02-04

### Fixed
- **USDC cap exceeded log spam** - Fixed repeated warning messages when USDC cap is exceeded
  - The warning `Entry blocked: usdc_cap_exceeded` was logging multiple times per second
  - Now logs only once when the cap is first exceeded
  - Resets to log again after cycle completion

## [2.4.8] - 2026-02-04

### Added
- **Enhanced filled orders tables** - More detailed fill information in UI
  - Added "Fill Time" column showing duration from order placement to fill (e.g., "20s", "1m 30s")
  - Added "Net Fee" column for live fills showing fee minus rebate
  - Green highlight when rebate exceeds fee (you earned money!)
  - Tooltip on net fee shows raw fee and rebate breakdown
  - Renamed "Time" column to "Filled" for clarity
  - Full order IDs displayed (removed truncation)
- **Holdback tracking in Transactions page** - Better visibility into BTC reserves
  - Added "Holdback" column showing BTC kept as reserves on sell transactions
  - Tooltip displays holdback value in USD
  - Summary section shows total holdback BTC and value across all filtered transactions
  - Helps explain P&L calculations when holdback value contributes to total returns

### Fixed
- **Polling-detected fills showing 0 BTC @ $0** - Fixed bug where fills detected via polling had missing data
  - Root cause: Coinbase eventual consistency - fills API can lag behind order status API
  - Added 2-second retry when getOrderFills returns empty but order status shows filled
  - Added fallback to create synthetic fill from order status data if retry still empty
  - Ensures fill data is captured even when Coinbase fills API is slow to propagate
- **Fill time not captured for polling-detected fills** - Fixed order placedAt not being passed to fill handler
  - Order was deleted from pendingOrders before callback, losing the placedAt timestamp
  - Now captures and passes placedAt in the callback for fill time tracking
- **Total fees shown in totals row** - Added total net fees to buy/sell summary rows for cost visibility

## [2.4.4] - 2026-02-04

### Changed
- **Regime Dashboard layout reorganization** - Improved UI layout for better information hierarchy
  - Configuration Summary moved into 3rd column under Price & ATR chart
  - Orders section changed from side-by-side to vertically stacked layout
  - Filled Orders tables height doubled (128px → 256px) to show more fills
  - Open Orders stays compact (only 1-2 orders at a time)

### Fixed
- **Ladder limit log spam** - Fixed repeated warning messages when ladder limit is reached
  - The warning `Entry blocked: ladder_limit_reached` was logging multiple times per second
  - Now logs only once when the limit is first reached
  - Resets to log again after ladder auto-reset or cycle completion
- **Fills totals calculated from only displayed rows** - Fixed buy/sell totals in UI using sliced array
  - Totals were calculated from only the 10 displayed fills instead of all fills in the cycle
  - Now calculates totals from all fills, then slices for display
  - Headers now show total count (e.g., "Buys (58, showing 10)")

## [2.4.2] - 2026-02-03

### Added
- **Capital tracking improvements** - Better visibility into capital allocation
  - `originalCapital` - True starting capital that never changes, preserved across restarts
  - `availableCapital` - Current cap minus deployed capital (maxUsdcDeployed - totalCostBasis)
  - Dashboard now shows "Original" and "Available" capital in the APY section
  - Helps track how much capital is currently deployable vs locked in positions

### Fixed
- **Crypto.com dry-run orders causing API errors on restart** - Fixed error when checking pending orders on startup
  - Dry-run orders (with IDs like `dry-run-sell-*`) were being passed to the Crypto.com API
  - API returned 40003 "Invalid order_id" since these orders don't exist on the exchange
  - Now filters out dry-run orders before attempting to check their status
- **Health monitor stuck in SAFE mode** - Fixed critical bug where system would never auto-recover from SAFE mode
  - Root cause: `checkHealth()` was never called in regime-engine, preventing automatic exit from SAFE mode
  - Added periodic health check call in metrics updater (runs every 60 seconds)
  - Also fixed `resume()` to work with SAFE mode (previously only worked for PAUSED mode)
  - This caused entries to be blocked indefinitely after WebSocket disconnects
- **TP order not updated after offline buy fills** - Fixed bug where TP order size wasn't updated when buy orders filled while engine was offline
  - Root cause: `checkOfflineOrderFills()` updated position but didn't call `placeTakeProfitOrder()`
  - This caused the TP to sell at its original size, leaving excess BTC as unintended holdback
  - Now properly places/updates TP order after processing offline buy fills
- **Entry orders preserved across restarts** - Entry orders are now persisted and restored instead of being canceled
  - Pending entry orders are saved to `positionState.pendingEntryOrders` immediately when placed
  - On restart, saved entries are restored to order tracking and allowed to fill naturally
  - Partial fills during offline periods are properly ingested
  - Orders not belonging to the regime engine (e.g., from DCA engine) are ignored, not canceled
  - This prevents lost opportunities when good limit orders were placed before restart
- **Orphaned TP orders from failed cancels** - Fixed silent failure when canceling old TP before placing new one
  - Cancel failures were ignored, causing new TP to be placed while old one remained on exchange
  - Now logs a warning when cancel fails and keeps the existing TP tracked, refusing to place a new one to avoid duplicate sells

## [2.3.47] - 2026-02-03

### Fixed
- **Fills not showing in UI** - Fixed broken filter that was excluding all fills with cycleIds
  - The filter `!f.cycleId.startsWith('cycle-')` incorrectly excluded all fills since all have cycleIds starting with 'cycle-'
  - Now correctly identifies current cycle by finding the most recent cycleId timestamp
- **Holdback display showing cumulative totals** - Changed holdback to show per-cycle BTC profit instead of running total
  - Each sell row now shows `totalBought - totalSold` for that specific cycle
  - Partial fills are aggregated by orderId for cleaner display
- **Position/P&L not calculated on startup** - Engine now auto-recalculates cycles from fill ledger on startup
  - Ensures accurate P&L tracking without requiring manual "Recalculate from Fills" click
- **APY metrics showing 0 after restart** - Backfills engineStartTime from earliest fill in ledger
  - APY calculations now work correctly even after engine restarts

## [2.3.25] - 2026-02-02

### Fixed
- **NaN position state corruption after fill processing** - Fixed critical bug where position state (avgCostBasis, totalCostBasis) became NaN after processing fills
  - Root cause: `aggregateFills()` was called with raw adapter fills (which have `sizeInQuote`) instead of ingested fills (which have `quoteAmount`)
  - Fixed in `handleOrderFill()`, `checkOfflineOrderFills()` for both TP and entry orders
- **Ghost TP orders after restart** - Engine now validates saved TP order exists on Coinbase before restoring
  - If order was cancelled/failed, clears tracking so a new TP order gets placed
  - Prevents UI showing orders that don't exist on exchange
- **Auto-TP placement after recovery** - Engine now places TP order after metrics update when position exists but no active TP order
  - Previously, TP orders were only placed after buy fills, leaving recovered positions without TP protection
- **Recovery now uses all fills** - Changed recovery to use `fillLedger.getAllFills()` instead of just current cycle fills
  - Fixes issue where restored state showed no fills because `currentCycleId` was null

### Added
- **TP order validation on startup** - Validates saved TP order exists on exchange before restoring tracking
- **restorePendingOrder API** - Added to order executor to restore TP order tracking after recovery

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
- **Duplicate entry orders race condition** - Added lock to prevent concurrent entry evaluations from rapid ticker updates
- **Pending orders not showing in live mode UI** - Added `getPendingOrdersList()` to order executor and updated dashboard to show orders for both live and dry-run modes
- **Unhandled promise in reconciliation interval** - Reconciliation now catches errors and continues operating
  - Added `isRunning` guard to prevent reconciliation after engine stop
  - Errors are logged instead of causing unhandled rejections
- **Unhandled promise in stale order timeout** - Stale order checks now catch errors gracefully
  - Converted async/await to Promise chain with `.catch()` for proper error handling
- **WebSocket malformed JSON crash** - Added safe JSON parsing for WebSocket messages
  - Invalid JSON now logs a warning and is ignored instead of crashing
- **Cancel all entries partial failure** - Cancel loop now continues on individual failures
  - Uses `Promise.allSettled()` to attempt all cancels even if some fail
  - Failed cancels are logged and orders removed from tracking (may have already filled/cancelled)
- **State not persisted immediately after fills** - Added immediate state persistence on order fills
  - Both buy fills and TP fills now trigger immediate state save and fill ledger persist
  - Prevents data loss if process crashes after a fill but before next periodic save
- **Offline fills check failure blocking startup** - Startup continues even if offline fill check fails
  - Error is logged but doesn't prevent engine from starting
  - Fills will be detected on next reconciliation cycle
- **Regime engine showing DCA orders in Open Orders** - Fixed order isolation between engines
  - Regime engine was absorbing ALL open orders from Coinbase during recovery
  - Now only tracks orders it places itself, ignoring orders from DCA engine
  - Orders from other engines (like standard DCA) are no longer displayed or tracked
- **Stop Engine button not updating UI** - UI now properly reflects stopped state
  - Socket status was taking precedence over fetched status after stop
  - Now clears socket status when engine stops so UI shows correct state
- **Ghost orders in UI** - Orders that exist in UI but not on exchange
  - Post-only orders can be immediately cancelled by Coinbase if they would cross the spread
  - Now verifies order status after placement before adding to pending orders
  - If order was immediately cancelled, retries with fresh prices
- **Filled orders not detected** - Orders would fill but engine didn't process them
  - Stale order timeout now detects FILLED status and triggers fill processing
  - Added `checkPendingOrderFills()` method for periodic fill detection backup
  - Reconciliation interval now checks for missed fills every 5 minutes
  - `onFillDetected` callback wired up to handle fills detected via polling
  - Status comparison now case-insensitive to handle varying API response formats

### Added
- **Dynamic entry offset based on momentum** - Entry bid offset now adapts to market direction
  - When momentum is UP: uses smaller offset (`entryOffsetUpBps`, default 5bps) to get fills before price rises
  - When momentum is DOWN: uses larger offset (`entryOffsetDownBps`, default 15bps) to catch falling price
  - When momentum is NEUTRAL: uses default offset (`entryOffsetBps`, default 10bps)
  - Momentum calculated from 1-minute candles (short and long period price returns)
  - Logs now show `momentum=up/down/neutral offset=Xbps` for debugging

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
