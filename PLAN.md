# Critical Mass - Development Plan

## Full Codebase Audit (In Progress)

### Phase 1: Critical Bug Fixes - COMPLETE
- [x] 1.1 Mutex deadlock protection (`src/async-mutex.js`) - Added 30s timeout, waiters counter
- [x] 1.2 atomicReplace naked sell on FILLED (`src/order-executor.js`) - Return early on filled
- [x] 1.3 Stale timeout ignores regime multiplier (`src/order-executor.js`) - Use getEffectiveStaleMs()
- [x] 1.4 P&L data loss during recovery (`src/regime-engine.js`) - Explicit field merge
- [x] 1.5 entryInProgress flag - ALREADY FIXED (uses .finally())
- [x] 1.6 TP optimizer volFactor always 1.0 (`src/tp-optimizer.js`) - Separate historicalVolBaseline
- [x] 1.7 findMergeTarget fallback to body without TP (`src/celestial-hierarchy.js`) - Highest costBasis
- [x] 1.8 getTierSummary conflates satellite and sun (`src/celestial-hierarchy.js`) - TIER_ABBREV map
- [x] 1.9 WebSocket product matching too broad (`src/websocket-feed.js`) - Exact productId match
- [x] 1.10 fill-ledger.js negative BTC guard (`src/fill-ledger.js`) - Reorder linked buys before sells; clamp as fallback

### Phase 2: Security Hardening - COMPLETE
- [x] 2.1 Restrict CORS origin - Allowlist from env/defaults (localhost:5563, localhost:5564)
- [x] 2.2 Exchange param validation - app.param middleware with regex + known exchange check
- [x] 2.3 Rate limiting - express-rate-limit: 100/min GET, 20/min write, 5/min engine start/stop
- [x] 2.4 Atomic writes for config - writeJSON now uses atomicWriteSync
- [x] POST/PUT keys deduplication (from 3.4) - Single saveExchangeKeys handler

### Phase 3: Modularity & DRY Refactoring - PARTIAL
- [x] 3.3 Modularize server.js (2117 → 509 lines, 76% reduction)
  - src/routes/exchange-routes.js, regime-routes.js, keys-routes.js, backtest-routes.js, settings-routes.js, legacy-routes.js
  - Extracted createEngineCallbacks (from 3.4)
- [x] 3.2 Extract apy-calculator.js from regime-engine.js (~170 lines)
- [x] 3.4 POST/PUT keys deduplication (single saveExchangeKeys handler)
- [ ] 3.1 Extract shared order tracking (deferred - deep closure coupling)
- [ ] 3.2 Split regime-engine.js further (deferred - fill-processor, entry-evaluator, tp-manager, recovery deeply coupled to closure state)

### Phase 4: Performance Fixes - COMPLETE
- [x] 4.1 Fill ledger cycleIndex Map for O(1) cycle lookups (`src/fill-ledger.js`)
- [x] 4.2 Order executor tpOrderToKey reverse-lookup Map for O(1) satellite/body TP lookups (`src/order-executor.js`)
- [x] 4.3 Market data service regime state caching - 10s TTL cache to avoid disk reads every second (`src/market-data-service.js`)
- [x] 4.4 Timer cleanup on shutdown - Track all TTL timers in regime-engine + stale timers in order-executor, clear on stop

### Bug Fix: Negative USDC P&L on Body TPs
- [x] Fee floor formula in `placeBodyTp()` didn't account for holdback ratio
  - Old formula: `(2 * 0.0006 * 100) + ($0.01 / costBasis * 100)` → 0.14% for $50 position
  - New formula: `((2 * feeRate) + ($0.01 / costBasis)) / (1 - holdbackRatio) * 100` → 0.44% for $50 position
  - Holdback means only `(1-h)` of gross profit becomes USDC, so TP% must be higher
  - Fee rate now configurable via `config.feeRate` (default 0.001 = 10 bps conservative)
  - Added post-hoc P&L validation loop (bumps TP% up to 10× if rounding causes negative P&L)
  - Added final guard that skips placement if estimated P&L < $0.01

### Bug Fix: UI Holdback & P&L Display
- [x] Filled Orders holdback total was summing entire position, not per-sell holdback
- [x] Filled Orders P&L diverged from Position card due to recomputing vs server-annotated values

### Phase 5: Test Coverage (~283 test cases) - IN PROGRESS

### Phase 6: Satellite → Body Naming Cleanup - COMPLETE

**Goal:** Remove the misleading "satellite" naming that was a legacy of when the only body type
was a satellite. Now that all 7 celestial tiers share identical code paths, the generic "body"
terminology should be used everywhere. The tier name "satellite" (the smallest tier) stays as-is.

**Scope:** ~400 references across ~26 files (src/, admin/, scripts/, tests/)

#### 6.1 Fill Annotation Field Renames (backward-compat read) ✅
Rename fields written to fill-ledger.json fills:
- `isSatellite` → `isBodyOwned`
- `satellitePnl` → `bodyPnl`
- `satelliteHoldbackBtc` → `bodyHoldbackBtc`
- `satelliteCostBasis` → `bodyCostBasis`
- `satelliteAvgPrice` → `bodyAvgPrice`
- `satelliteBtcQty` → `bodyBtcQty`

**Backward compat:** All read sites must accept BOTH old and new field names since existing
fill-ledger.json files on disk have the old names. Pattern: `fill.bodyPnl ?? fill.satellitePnl`
Write sites only write new names. Over time old fills age out naturally.

Files affected:
- `src/regime-engine.js` (~30 refs): annotation writes in body TP fill handler, body TP sell annotation, getState() aggregation
- `src/fill-ledger.js` (~19 refs): filter conditions (`!fill.isSatellite && !fill.bodyId`), comments
- `admin/src/components/RegimeDashboard.jsx` (~32 refs): P&L display, holdback, sell group logic
- `src/routes/regime-routes.js` (1 ref): `satelliteRealizedPnL` in recalculate endpoint
- `scripts/reconcile-state.js` (~9 refs): annotation cleanup
- `scripts/backfill-sell-order-ids.js` (~12 refs): fill annotation
- `scripts/repair-sell-linkage.js` (~15 refs): linkage repair
- `scripts/repair-orphan-sells.js` (~2 refs): orphan detection
- `scripts/fix-recovery-body.js` (~5 refs): recovery annotation
- `scripts/add-recovery-fill.js` (~4 refs): recovery fill
- `tests/fill-ledger.test.js` (~6 refs): test assertions
- `tests/celestial-hierarchy.test.js` (~41 refs): test data

#### 6.2 Order Type Consolidation (`satellite_tp` → `body_tp`) ✅
Consolidate the dual order type strings. Both `satellite_tp` and `body_tp` exist in code;
`body_tp` is already the preferred type. Remove `satellite_tp` usage.

Files affected:
- `src/order-executor.js` (~64 refs): the biggest change — rename all `satellite*` functions
  - `placeSatelliteTpOrder()` → `placeBodyTpOrder()`
  - `cancelSatelliteTpOrder()` → `cancelBodyTpOrder()`
  - `cancelAllSatelliteTpOrders()` → `cancelAllBodyTpOrders()`
  - `isSatelliteTpOrder()` → `isBodyTpOrder()`
  - Internal `satelliteTpOrders` array → `bodyTpOrders`
  - Internal `tpOrderToKey` Map references
  - `satellite_tp` type strings → `body_tp`
- `src/dry-run-executor.js` (~87 refs): mirror all order-executor renames
- `src/regime-engine.js` (~91 refs): all callsites to renamed functions
- `admin/src/components/TransactionsRegime.jsx` (1 ref): order type check
- `src/state-tracker.js` (~11 refs): legacy migration code

**Note:** Functions like `cancelBodyTpOrder` already exist (as wrappers). The rename unifies
the naming so there's a single `bodyTpOrders` array, not the current aliased
`const bodyTpOrders = satelliteTpOrders`.

#### 6.3 State Field Cleanup ✅
Remove/rename legacy state fields in position state:

- `satelliteTpOrders[]` → DELETE (already migrated to `celestialBodies[]` via state-tracker migration)
- `satellitesCompleted` → merge into `bodiesCompleted` (already exists)
- `satelliteRealizedPnL` → merge into `bodiesRealizedPnL` (already exists)
- `satelliteRealizedBtcPnL` → merge into `bodiesRealizedBtcPnL` (already exists)

Files affected:
- `src/state-tracker.js`: Remove from defaults, update migration logic
- `src/regime-engine.js`: Remove references, use only `bodies*` fields
- `src/routes/regime-routes.js`: Update recalculate endpoint
- `src/types.js`: Remove `SatelliteTpOrder` typedef, update `PositionState` props

**Migration:** On state load, sum `satellite*` into `bodies*` if both exist, then delete `satellite*` fields.

#### 6.4 Config Field Cleanup ✅
Remove legacy config aliases:

- `satelliteTpEnabled` → DELETE (already aliased to `celestialEnabled`)
- `maxSatelliteOrders` → DELETE (already aliased to `maxCelestialBodies`)

Files affected:
- `src/config-utils.js` (~6 refs): Remove from defaults, keep one-time migration
- `src/types.js`: Remove from config typedef
- `admin/src/components/ConfigEditor.jsx` (~2 refs): Remove legacy mentions
- `config.json`: Remove fields if present

#### 6.5 Type Definitions Update (`src/types.js`) ✅
- Remove `SatelliteTpOrder` typedef (deprecated, replaced by `CelestialBody`)
- Rename fill annotation properties in typedef comments
- Update `TrackedOrder.type` union: remove `'satellite_tp'`
- Update `CelestialTier.name` comment (keep "satellite" as valid tier name)
- Update `RegimeConfig` satellite section comments

#### 6.6 UI Components ✅
- `admin/src/components/RegimeDashboard.jsx`: Update all `sell.satellitePnl` → `sell.bodyPnl` etc (with backward compat reads)
- `admin/src/components/TransactionsRegime.jsx`: Update `satellite_tp` check → `body_tp`
- `admin/src/components/ConfigEditor.jsx`: Update description text mentioning "satellite"
- `admin/src/components/celestial/celestialConstants.js`: KEEP `satellite` tier name (it's the actual tier, not a misnomer)
- `admin/src/components/celestial/*.jsx`: KEEP tier-name references (CelestialBody, CelestialScene, etc.)

#### 6.7 Scripts Update ✅
All repair/reconcile scripts need updated field names with backward-compat reads:
- `scripts/reconcile-state.js`
- `scripts/backfill-sell-order-ids.js`
- `scripts/repair-sell-linkage.js`
- `scripts/repair-orphan-sells.js`
- `scripts/fix-recovery-body.js`
- `scripts/fix-cycle-numbering.js`
- `scripts/add-recovery-fill.js`

#### 6.8 Tests Update ✅
- `tests/fill-ledger.test.js`: Update test fill objects and assertions
- `tests/celestial-hierarchy.test.js`: Update test data using old field names

#### 6.9 PLAN.md & CLAUDE.md Documentation ✅
- Update PLAN.md Celestial Hierarchy section
- Update PLAN.md architecture notes
- Keep historical references in fix descriptions as-is (they document what happened)

#### Implementation Order
1. **6.3 + 6.4** State & config cleanup (smallest blast radius, migration-safe)
2. **6.5** Type definitions (no runtime impact, just docs)
3. **6.2** Order type consolidation (biggest single change: order-executor + dry-run-executor)
4. **6.1** Fill annotation renames (regime-engine writes + all read sites)
5. **6.6** UI components (follow server-side changes)
6. **6.7** Scripts (low priority, used manually)
7. **6.8** Tests (update to match new field names)
8. **6.9** Documentation

#### Risks & Mitigations
- **Persisted data on disk**: fill-ledger.json has old field names → backward-compat reads (`?? oldName`)
- **regime-state.json**: has old state fields → one-time migration in state-tracker
- **Active orders on exchange**: `satellite_tp` type only used internally, not on exchange → safe to rename
- **Running engine during deploy**: Stop engine before deploying, restart after → state migration runs on load
- **Rollback**: All changes are naming-only, no logic changes → `git revert` is clean

### Fix: Cancel-Verification Race Causing Orphan Double-Sells - COMPLETE
- [x] `safeCancelOrder` now verifies cancel with `getOrder` poll after Coinbase ack (500ms delay, 2 retries)
  - Detects Coinbase phantom cancel acks where order remains OPEN on the book
  - Returns `{ cancelled: false, filled: true }` if order fills between cancel and verify
  - Logs escalating warnings (⚠️ retry, 🚨 exhausted) for monitoring
- [x] Merge snapshot TTL increased from 60s to 5min (300000ms) across all 3 locations
  - Matches reconciliation interval so late WebSocket fills still find snapshot data
- [x] Corrective buy script (`scripts/place-corrective-buys.js`) for orphan sell recovery
  - Places GTC limit buys at prices preserving original P&L
  - `--status` checks fill progress, `--annotate` ingests fills + sets sellOrderId linkage

### Fix: Realized P&L Sync (Filled Orders ↔ Position Card) - COMPLETE
- [x] Realized P&L in Position card ($88.64) diverged from Filled Orders total ($92.25)
  - Root cause: Recalculate used per-cycle P&L + stale `bodiesRealizedPnL` counter
  - Fix: Global buy-sell linkage algorithm in `recalculateCycles()` mirrors dashboard exactly
  - Three-step approach: (1) pnlMap with running average for core, annotations for body
    (2) Build buy-sell linkage via sellOrderId with orphan redirect via bodyId
    (3) Override P&L from linked buys for sells without trusted annotations
  - Returns `globalRealizedPnL` and `globalRealizedBtcPnL` used by both startup and API
- [x] Startup auto-recalculate now uses global buy-linkage P&L (not stale body counter)
- [x] Unrealized P&L now includes all active celestial bodies' mark-to-market (not just core)
- [x] Fill reordering for corrective buys: linked buys processed before sells regardless of timestamp
  - Fixes negative BTC warning for fills where correction buy was added after its sell

---

Multi-exchange BTC accumulation engine with celestial position management.

**Version:** 2.4.21
**Ports:** 5563 (API), 5564 (UI dev)

---

## Completed Features (v2.0)

### Multi-Exchange Support
- Adapter architecture for exchange abstraction (`src/adapters/`)
- Coinbase adapter with JWT ES256 authentication
- Gemini adapter with HMAC-SHA384 authentication
- Crypto.com adapter with HMAC-SHA256 authentication
- Per-exchange configuration, data namespacing, and state management
- Automatic data migration from v1 flat structure

### Granular Time Intervals
- Configurable intervals: 5min, 10min, 30min, 1hour, 4hour, daily
- Interval-aligned execution with duplicate prevention
- Backwards compatible with `daysToSpread` configuration

### Admin Dashboard
- React-based web UI at port 5563
- URL pattern: `/:exchange/:pair/[tab]` (e.g., `/coinbase/BTC-USDC/config`)
  - Overview: `/` (multi-exchange overview dashboard with aggregate P&L, APY, live status cards)
  - Pair routes: `/coinbase/BTC-USDC`, `/coinbase/BTC-USDC/cost-basis`, `/coinbase/BTC-USDC/transactions`, etc.
  - Strategy derived from exchange config (not URL) — regime vs DCA determined automatically
  - API Keys: `/:exchange/:pair/keys` (in sub-nav tabs)
- Exchange selector shows trading pair per exchange (strategy no longer in URL)
- Strategy-specific views:
  - DCA: Order-based cost basis, TSV transactions, Backtest/Optimizer pages
  - Regime: Cycle-based cost basis, fill ledger transactions (no Backtest/Optimizer)
- Real-time dashboard with WebSocket updates
- Configuration editor with validation (strategy-aware fields)
- API keys management (masked display)
- Transaction history and cost basis reports
- Backtesting with historical price data (supports any trading pair from config)
- Parameter optimization engine (supports any trading pair from config)
- Responsive layout with breakpoints: 1280px (default), 1440px (2xl), 1920px (3xl)
- Regime Dashboard with live D3.js charts (price, volatility, regime timeline)
- Smart price formatting: adapts decimal places based on asset price magnitude
  - High prices (>$100): 2 decimals (e.g., $105,234.56)
  - Medium prices ($1-$100): up to 4 decimals (e.g., $45.1234)
  - Low prices ($0.01-$1): up to 5 decimals (e.g., $0.10234)
  - Very low prices (<$0.01): up to 8 decimals
- D3.js interactive charts:
  - Fund balance over time (area chart)
  - Price history with buy markers (line chart)
  - Pending sell orders visualization
  - Cost basis distribution histogram
  - Daily buy/sell volume (bar chart)
  - Cumulative fees & rebates (composed chart)

### Core Trading Engine
- Market buy with fee tracking
- Post-only limit sell orders
- Configurable holdback percentage for BTC reserves
- Price protection (max buy price threshold)
- Dry-run mode for testing
- Order consolidation:
  - Consolidate multiple pending orders into single order at weighted average price
  - Manual consolidation via admin UI button
  - Auto-consolidation when pending orders exceed `consolidateAfterOrders` threshold
  - Interval-based consolidation with `consolidateInterval` option (daily, weekly, never)
  - Skips partially filled orders
  - Tracks consolidation in state and transaction logs

### DCA Strategies
- **Fixed Amount (default)**: Traditional DCA with fixed buy amounts per interval
- **Fibonacci**: Volatility-harvesting accumulation strategy
  - Buys using Fibonacci sequence multipliers (1, 1, 2, 3, 5, 8, 13... × base amount)
  - Maintains single consolidated sell order per cycle at weighted-average cost basis + markup
  - Automatic cycle reset when sell fills, restarting at position 0
  - Optimized for short-term mean reversion in low-to-moderate volatility regimes
  - Transitions to accumulation mode during trending/high-volatility periods
  - Configurable via `dcaStrategy: 'fibonacci'` and `fibBaseAmount` in config
- **Regime Engine (v2.4)**: Advanced volatility-driven inventory cycling
  - Replaces fixed-interval DCA with ATR-based volatility clock
  - Three-mode regime state machine: HARVEST, CAUTION, TREND
  - Liquidity-aware position sizing with ladder steps
  - Dynamic take-profit based on recent volatility
  - Hard exposure caps and drawdown protection
  - WebSocket real-time data feed for Coinbase and Crypto.com
  - Health monitoring with automatic SAFE mode transitions

### Regime Engine Architecture (v2.4)

The Regime Engine is an advanced trading system that adapts to market conditions:

**Core Components:**
- `src/regime-engine.js` - Main orchestrator
- `src/regime-detector.js` - Regime classification (HARVEST/CAUTION/TREND)
- `src/volatility-utils.js` - ATR, realized volatility, VWAP calculations
- `src/position-sizer.js` - Liquidity-aware sizing with ladder scaling
- `src/order-executor.js` - Maker-prefer limit order placement
- `src/health-monitor.js` - SAFE mode and system health tracking
- `src/tail-events.js` - Flash move, spread widening, depth drop detection
- `src/websocket-feed.js` - Coinbase WebSocket real-time data
- `src/fill-ledger.js` - Idempotent fill tracking with cost basis
- `src/recovery.js` - Startup state recovery from exchange

**Regime Modes:**
| Mode | Description | Entry Behavior | TP Behavior |
|------|-------------|----------------|-------------|
| HARVEST | Mean-reverting, normal volatility | Full ladder entries | Standard TP |
| CAUTION | Elevated volatility or momentum | 50% reduced sizing | Wider TP (1.5x) |
| TREND | Strong directional movement | No new entries | Tighter TP (0.8x) |

**Volatility Clock:**
- Entry triggers based on price moving k × ATR from anchor price
- Minimum interval enforced (default: 2min)
- Maximum interval fallback (default: 1hr)
- ATR calculated from 1-minute and 5-minute candles

**Dynamic TP Auto-Management (v2.4+):**
- Opt-in feature (`tpAutoManaged: true`) for automatic TP parameter adjustment
- Records cycle analytics (optimal TP %, actual TP %, volatility context)
- Compresses historical data into histogram buckets with time-weighted decay
- Calculates percentiles (p25, p50, p75) from compressed + recent data
- Periodic evaluation every N cycles (default: 5) or daily (whichever first)
- Rate-limited adjustments (max 25% change per evaluation)
- Safety bounds: absolute min (0.05%), absolute max (5.0%)
- `holdbackRatio` (0.0-1.0, default 0.5) - configurable profit split between sell/hold
  - Profit-based holdback: sells to recover cost basis + (1-ratio) of profit as USDC
  - Keeps (ratio) of profit as BTC appreciation
  - Example: ratio 0.5 at +1% → 0.5% USDC profit + 0.5% BTC value retained
- **Capital Growth**: maxUsdcDeployed automatically increases by USDC profit each cycle
- State persisted across restarts (in regime-state.json / dry-run-state.json)
- Dashboard panel shows current settings, observed percentiles, adjustment history

**Dynamic Size Auto-Management (v2.3+):**
- Opt-in feature (`sizeAutoManaged: true`) for automatic position sizing adjustment
- Dynamically calculates optimal `baseSizeUsdc` based on available USDC balance
- Calculates total ladder multiplier (assumes factor=1.0 per step; divergence scaling is bonus capacity)
- Formula: `baseSizeUsdc = (availableUsdc * targetUtilization) / totalLadderMultiplier`
- Records cycle data (steps used, capital deployed, available balance)
- Triggers recalculation on:
  - Cycle completion (every N cycles, default: 5)
  - Significant balance change (>10%)
  - Maximum hours elapsed (default: 24)
- Rate-limited adjustments (max 25% change per evaluation)
- Safety bounds: absolute min base ($10), absolute max base ($500)
- Target utilization default: 90% of available capital
- Optionally auto-adjusts `maxCycleBuys` based on p90 historical step usage
- State persisted across restarts
- Dashboard panel shows current sizing, step usage stats, adjustment history
- Configuration options:
  - `sizeAutoManaged: true/false` - Enable/disable feature
  - `sizeTargetUtilization: 0.90` - Target % of capital to utilize
  - `sizeAbsoluteMinBase: 10` - Floor for baseSizeUsdc
  - `sizeAbsoluteMaxBase: 500` - Ceiling for baseSizeUsdc
  - `sizeMaxChangePercent: 25` - Max % change per adjustment
  - `sizeAutoCycleBuys: false` - Also auto-adjust maxCycleBuys
  - `sizeEvaluationCycles: 5` - Evaluate every N cycles
  - `sizeEvaluationMaxHours: 24` - Or at least once per day

**Fill Time Tracking (v2.3+):**
- Records time from order placement to fill for all entry orders
- Tracks `fillTimeMs` in fill ledger for analytics
- Statistics calculated: avg, min, max, p50, p90, stale rate
- Stale rate = % of orders that took >30s to fill
- Dashboard panel shows fill time stats for last 7 days
- Data useful for optimizing `orderStaleMs` and entry offsets

**Regime-Based Stale Timeout (v2.3+):**
- Automatically adjusts order stale timeout based on current regime
- Multipliers applied to base `orderStaleMs`:
  - HARVEST: 1.0x (default timeout)
  - CAUTION: 0.7x (30% faster - uncertain markets need quicker repricing)
  - TREND: 0.5x (50% faster - trending markets move quickly)
- Effective timeout shown in dashboard with regime-adjustment indicator
- Prevents stale orders lingering at suboptimal prices during volatility

**Aggressiveness Control (v2.4+):**
- Dashboard control with 4 preset levels: Conservative, Moderate, Aggressive, Maximum
- Single-click changes apply immediately without restart
- Controls 8 trading parameters simultaneously (including maxCycleBuys):
  | Parameter | Conservative | Moderate | Aggressive | Maximum |
  |-----------|-------------|----------|------------|---------|
  | baseSizeUsdc | 25 | 50 | 100 | 200 |
  | kFactor | 0.8 | 0.65 | 0.5 | 0.3 |
  | minIntervalMs | 180000 (3min) | 120000 (2min) | 90000 (90s) | 60000 (1min) |
  | maxIntervalMs | 7200000 (2hr) | 3600000 (1hr) | 2400000 (40m) | 1200000 (20m) |
  | cautionScale | 0.15 | 0.35 | 0.6 | 1.0 |
  | trendScale | 0 | 0.1 | 0.25 | 0.5 |
  | entryOffsetBps | 25 | 18 | 12 | 5 |
  | maxCycleBuys | 10 | 15 | 25 | 50 |
- Estimated $25k deployment: Conservative ~23-34 days, Moderate ~10-20 days, Aggressive ~3-6 days, Maximum ~1-1.3 days
- Color-coded buttons (green/blue/yellow/red)
- Hover preview shows computed values with diff highlighting
- Detects "Custom" when values don't match any preset
- Note: baseSizeUsdc may be overridden by auto-sizer if enabled

**Pre-Positioned Liquidity Ladder Mode (v2.4, redesigned v2.6) ✅ Implemented:**
- Deploys ALL available USDC as limit buy orders from just below current price
  down to an ATH-based floor with Fibonacci-weighted sizing
- Complements reactive mode by capturing liquidity shocks and fat-tail events
- Two-engine system:
  | Engine | Extracts Value From | Best For |
  |--------|---------------------|----------|
  | Reactive | Oscillation frequency | Tight chop |
  | Ladder | Liquidity shocks & panic selling | Fat-tail dips, wicks |
- Key behaviors:
  - Bottom of ladder is ATH-based (not % below current price)
  - Number of orders is dynamic (not a fixed count)
  - Fibonacci sizing (smallest at top, largest at bottom)
  - Ladder orders STAY in place on individual buy fills (no reprice)
  - Rebuild only after all sells clear (cycle reset)
  - Safety & Tail Events checks are skipped in ladder mode
- Configuration:
  - `entryMode: 'reactive' | 'ladder'` - Entry strategy mode
  - `ladderMaxAthDropPct: 80` - Floor = ATH × (1 - this/100). 80 = lowest bid at 20% of ATH
  - `ladderSpacingMode: 'linear' | 'sqrt' | 'exponential'` - Price level distribution
  - `ladderSizeMode: 'flat' | 'linear' | 'sqrt' | 'fibonacci'` - Size allocation mode (default: fibonacci)
  - `ladderAutoSwitch: false` - Auto-switch to ladder on high volatility
  - `ladderAutoSwitchVolMult: 2.0` - Vol expansion threshold for auto-switch
  - `ladderMinSpacingPct: 0.5` - Minimum % between rungs
  - `maxOpenOrders: 50` - Raised for ladder mode (Coinbase allows 500/product)
- ATH-based floor:
  - `floor = ATH × (1 - maxAthDropPct/100)` (e.g., 80% drop → floor at 20% of ATH)
  - Fallback when ATH=0: uses currentPrice as reference
  - Returns null if price already below floor
- Adaptive first order offset:
  - `topPrice = currentPrice × (1 - kFactor × ATR / currentPrice)` — reuses volatility trigger distance
  - Fallback 1% if ATR unavailable
- Dynamic level count (fibonacci mode):
  - Finds max N where smallest fib-weighted order meets baseSizeUsdc
  - Capped at 30 levels for safety
  - Example: $30k budget, $100 base → ~14 levels
- Spacing modes:
  - `sqrt`: Denser near top (current price), sparser at bottom (default)
  - `linear`: Even spacing throughout
  - `exponential`: Sparser near top, denser at bottom
- Size modes:
  - `fibonacci`: Escalating Fibonacci weights (1, 1, 2, 3, 5, 8, 13...) — most capital at bottom
  - `flat`: Equal allocation to all levels
  - `linear`: Linearly increasing towards bottom
  - `sqrt`: Moderate increase towards bottom
- Ladder cycle flow:
  1. Build ladder with ATH-based floor and dynamic level count
  2. Place N limit buy orders from topPrice to floor with fibonacci sizing
  3. On fill: create celestial body, place TP — ladder orders STAY in place
  4. On cycle reset (all sells clear): cancel remaining ladder buys, rebuild from scratch
- Risk safeguards:
  - Budget cap: Total ladder allocation ≤ maxUsdcDeployed - totalCostBasis
  - BTC cap: Checks maxBtcExposure on each fill
  - Min order size: Skips levels where allocation < minOrderSizeUsdc
  - Spacing minimum: Enforces ladderMinSpacingPct between levels
  - Order limit: Validates maxOpenOrders capacity before placement
  - Mode switch protection: Doesn't switch modes mid-cycle with active position
- Manual rebuild:
  - "Rebuild Ladder" button in Open Orders card (visible when entryMode=ladder + engine running)
  - Inline settings panel: edit ATH Drop %, spacing mode, size mode, min spacing %
  - Preview auto-fetches on panel open and after settings change
  - "Place Orders" executes rebuild: cancel existing → build new → place orders
  - `previewLadder()` and `rebuildLadder()` engine methods bypass health/regime guards

**Celestial Hierarchy System (v2.5+):**
- Evolved from satellite TP orders into a unified celestial body system
- Every buy creates or merges into a "celestial body" with independent TP tracking
- Bodies are classified by **percentage of maxUsdcDeployed** into tiers (satellite → moon → planet → sun → hypergiant → galaxy → black hole)
- Each tier has its own TP multiplier, holdback scale, and emoji
- Bodies promote to higher tiers as they accumulate more capital through merges
- `src/celestial-hierarchy.js` - Tier classification, body creation/merge, promotion logic
- 7 tiers by % of max capital: satellite(0–2%) → moon(2–5%) → planet(5–15%) → sun(15–30%) → hypergiant(30–50%) → galaxy(50–75%) → black_hole(75%+)
- Tier-specific holdback: higher tiers hold proportionally more BTC (1.00x to 1.25x, capped at 95%)
- **Minimum holdback floor**: Every TP must hold back at least 1 satoshi (0.00000001 BTC)
  - `calculateTakeProfitSize()` enforces `holdbackQty >= 1 sat` via `Math.max()`
  - `placeBodyTp()` raises `minTpPct` floor so profit generates at least 1 sat holdback at sell price
  - Formula: `holdbackFloorPct = (1sat × avgPrice) / (btcQty × holdbackRatio) × 100`
  - Prevents tiny bodies from selling 100% of position with zero BTC accumulation
- **Minimum profit floor**: TP% must clear round-trip fees (2×0.06%) + $0.01 net profit
  - Formula: `feeFloorPct = (2 * 0.0006 * 100) + (0.01 / costBasis * 100)`
- **Body consolidation**: New buys within proximity of existing body are merged
- **Fee-inclusive P&L display**: Dashboard uses prorated cost basis (includes buy fees)
- Configuration:
  - `celestialEnabled` - Enable celestial body system
  - `maxCelestialBodies` - Maximum concurrent bodies
  - `holdbackRatio: 0.5` - Base profit holdback ratio (0.0-1.0)
- Startup recovery: body TP orders restored from state and validated on exchange
- Reconciliation: periodic check for body fills that WebSocket missed
- Dashboard: body count by tier, completed, PnL, individual body details
- Fill ledger annotates body fills with metadata (bodyId, bodyTier, costBasis, holdback, pnl)
- **sellOrderId tracking**: Each buy fill stores the `sellOrderId` of its associated sell order
  - Backfilled via `scripts/backfill-sell-order-ids.js` (dry-run by default, `--apply` to persist)
  - Runtime: set in `placeBodyTp()`, startup reconciliation, and legacy `placeTakeProfitOrder()`
  - `annotateFillsByOrderId()` auto-persists when `sellOrderId` is set
  - Dashboard uses `sellOrderId` for grouping buys under sells (with chronological fallback)
- **3D Visualization**: Three.js orbital scene in dashboard (lazy-loaded, code-split)
  - Hierarchical orbit chain: largest body at center, each smaller orbits the next-larger
  - Sorted by tier rank then costBasis; nested Three.js groups create epicyclic motion
  - Black hole renders with accretion disk + gravitational glow when at center
  - Bloom post-processing for emissive glow (inspired by bituniverse)
  - Dual-layer starfield with fog depth, multiple light sources
  - Percentage-based sizing (sqrt curve from costBasis / maxUsdcDeployed), tier-colored emissive spheres
  - Merged planets (×3+) show Saturn-like rings
  - Orbital path rings shown per-parent for each child body
  - Open buy orders as wireframe "incoming" satellites
  - Hover tooltips with body details (BTC qty, cost, avg, TP)
  - Auto-rotate camera with user orbit/zoom controls
  - Dependencies: three, @react-three/fiber v8, @react-three/drei v9, @react-three/postprocessing v2
- **Manual Body Roll-Up Merge**: Dashboard button to manually merge a body into the next-highest body by TP price
  - Roll-up `↑` button on each `body_tp` row (hidden for highest body, when <2 bodies, or engine stopped)
  - Confirmation dialog shows source/target body labels before executing
  - Flow: cancel both TPs → `mergeBodies()` (pure data) → remove source → re-annotate fills → `placeBodyTp()` → persist
  - `mergeBodies()` in celestial-hierarchy.js: combines qty/cost/orders, clears TP fields, checks tier promotion
  - `manualMergeBody(bodyId)` in regime-engine.js: orchestrates cancel/merge/re-place with rollback on target cancel failure
  - `POST /api/:exchange/regime/rollup-body` endpoint in server.js
  - Emits `body_rollup` trade event on success
  - Pushes `regime:status` via WebSocket after merge so celestial animation updates immediately
- **TP fill detection for all order types**: `checkPendingOrderFills()` and `refreshStaleOrders()` check entries, take_profit, and body_tp orders (not just entries). TP orders that are filled/cancelled are cleaned up; open TPs are never auto-cancelled.
- **Negative P&L guard**: `placeBodyTp()` rejects TP placement when `tpPrice <= body.avgPrice` to prevent selling at a loss
- **Legacy TP cleanup**: `placeTakeProfitOrder()` cancels any legacy `take_profit` order when celestial bodies are present
- **Buy→sell linkage on fill**: Body TP fills annotate source buy fills with `sellOrderId` for dashboard grouping; untracked sells annotate all current-cycle buys
- **Dashboard take_profit display**: `take_profit` orders with matching celestial body data display the celestial emoji/tier instead of generic "TP"
- **Legacy compatibility**: Old `satelliteTpOrders` migrated to celestial bodies on startup; legacy satellite fill annotations read via backward-compat `?? oldName` pattern
- **Orphan reclamation**: On startup, detects sell orders on exchange that aren't tracked
  in state. Small sells reclaimed as bodies; large untracked sells trigger a warning.
- **Coinbase adapter**: `getOpenOrders` includes `size` and `price` from order configuration

**Macro Regime Detection (v2.6):**
- Multi-timeframe EMA overlay that modulates micro-regime behavior
- Fetches hourly (200) and daily (30) candles via REST API every 5 minutes
- Computes 21h, 50h, 200h, and 20d EMAs
- Scoring system (-100 to +100): EMA alignment (±30), price vs 200h (±25), daily trend (±25), EMA convergence (±20)
- Four macro modes with configurable thresholds and hysteresis:
  - ACCUMULATION (dip zone): increase sizing, tighter TP and entries
  - RANGING (consolidation): passthrough (1.0x multipliers)
  - MARKUP (uptrend): reduce sizing, wider TP for bigger captures
  - DECLINE (capitulation risk): conservative sizing, wider entries
- Multipliers applied: `effectiveSize = microSize × macroSizeMult`, `effectiveTP = baseTP × macroTpMult`, `effectiveOffset = baseOffset × macroOffsetMult`
- State persisted for recovery across restarts
- Dashboard: macro mode badge in regime cell, macro panel with EMAs/score/multipliers
- Config UI: toggle, thresholds, hysteresis, per-mode multipliers
- Disabled by default (`macroEnabled: false`), zero behavior change when off
- Files: `src/macro-regime.js`, plus changes to regime-engine, config-utils, types, state-tracker, dashboard, config editor

**Safety Features:**
- Automatic SAFE mode on: WebSocket disconnect, stale data, REST errors
- Flash move detection pauses entries and disables scaling
- Spread widening and depth drop pauses
- Maximum exposure caps (BTC and USDC)
- Maximum drawdown protection with auto-recovery:
  - Pauses entries when drawdown >= configured limit (default: 20%)
  - Auto-resumes when drawdown recovers to < 50% of limit
  - Auto-resets peak after configurable hours (default: 72h/3 days)
  - Manual "Resume Trading" button in UI to override pause
- Ladder step limit with auto-reset:
  - Pauses entries when ladder limit reached (default: 15 steps)
  - Auto-resets after configurable hours (default: 72h/3 days)
  - Prevents stuck positions in prolonged ATH markets

**Position & P&L Tracking:**
- BTC Held - Current cycle position
- BTC on Order - BTC in pending sell orders
- BTC Reserves - Accumulated holdback from completed cycles (realized BTC P&L)
- Realized P&L shows both USD profit and BTC reserves
- Holdback ratio applied to each TP (sells 1-ratio, holds ratio of position)

**APY & Performance Tracking:**
- Tracks engine start time and initial capital (maxUsdcDeployed)
- Persists APY tracking across restarts
- **Total Liquid Value** - APY calculated from combined USDC + BTC (at live market price)
  - `totalUsdcReturn` - USDC realized P&L from trading
  - `totalBtcReturn` - BTC holdback accumulated (8 decimal precision)
  - `btcValueUsd` - BTC valued at current market price
  - `totalLiquidValue` - Combined value used for APY projections
- Calculates and displays:
  - Total return breakdown (USDC, BTC with USD value, combined Live Total)
  - Daily return rate based on liquid value
  - Estimated annual return (linear projection)
  - Estimated APY (compound calculation)
  - Cycles per day
  - Average P&L per cycle
- UI displays performance metrics in the Position section
- **Auto-resume on restart** - Engine automatically resumes if it was running before server restart

**Dry-Run Mode:**
- Test regime engine against live market data without placing real orders
- Simulates order placement, fills, and P&L tracking
- Decision log tracks all hypothetical trades for analysis
- Configurable via exchange-level `dryRun: true` (same as DCA engine)
- Visual indicators in admin UI show dry-run status
- Reset capability to clear simulated state and start fresh
- **State persistence** - Simulation survives server restarts
  - Saves state on fills, every 60s, and on graceful shutdown
  - Restores position, filled orders, P&L tracking on restart
  - State stored in `dry-run-state.json` (per-exchange)
- Useful for:
  - Validating regime strategy parameters before going live
  - Comparing different configurations against real market conditions
  - Training and understanding the system behavior
  - Stress testing under volatile market conditions

**Live Mode State Persistence:**
- Exchange is always source of truth for position and orders
- State persistence for faster recovery on restarts:
  - Saves regime state to `data/{exchange}/regime-state.json` every 5 minutes
  - Saves fill ledger to `data/{exchange}/fill-ledger.json` on shutdown
  - **Pending entry orders** saved immediately when placed for recovery
  - Restores state on startup, then validates against exchange
- **Restart recovery flow:**
  1. Load saved state from disk (if exists)
  2. Recover state from exchange (fills, open orders, balances)
  3. Merge saved state with exchange-recovered values
  4. Check for orders that filled while offline (TP orders, entry orders)
  5. **Restore pending entry orders** from saved state (instead of canceling)
  6. Ingest any partial fills that occurred while offline
  7. Re-evaluate position based on current market price
  8. Re-anchor volatility triggers to current price
  9. Resume trading with validated state
- **Pending entry order persistence:**
  - Entry orders saved to `positionState.pendingEntryOrders` immediately when placed
  - Orders restored to order executor tracking on restart
  - Partial fills ingested and position updated accordingly
  - Orders not belonging to regime engine are ignored (e.g., from DCA engine)
  - Prevents lost opportunities when good limit orders were placed before restart
- Offline order detection handles:
  - TP orders that filled while offline → completes cycle, calculates P&L
  - Entry orders that filled while offline → updates position, places/updates TP order
- Market position re-evaluation on startup:
  - Logs price movement since last entry
  - Re-anchors price for volatility triggers
  - Warns if price dropped significantly while offline

**API Routes:**
```
GET  /api/:exchange/regime/config    - Get regime configuration
PUT  /api/:exchange/regime/config    - Update regime configuration
GET  /api/:exchange/regime/status    - Get regime engine status
POST /api/:exchange/regime/start     - Start regime engine
POST /api/:exchange/regime/stop      - Stop regime engine
POST /api/:exchange/regime/pause     - Pause (enter SAFE mode)
POST /api/:exchange/regime/resume    - Resume from SAFE mode
POST /api/:exchange/regime/force-regime - Force regime transition
POST /api/:exchange/regime/rollup-body - Manual body roll-up merge
GET  /api/:exchange/regime/preview-ladder - Preview ladder rebuild (dry calculation)
POST /api/:exchange/regime/rebuild-ladder - Cancel + rebuild ladder orders
POST /api/:exchange/regime/cancel-ladder - Cancel all ladder orders, switch to reactive mode
GET  /api/:exchange/regime/fills     - Get fill ledger

# Dry-Run specific routes
GET  /api/:exchange/regime/dry-run/log   - Get decision log (hypothetical trades)
GET  /api/:exchange/regime/dry-run/pnl   - Get simulated P&L summary
GET  /api/:exchange/regime/dry-run/state - Get full dry-run state
POST /api/:exchange/regime/dry-run/reset - Reset dry-run state
```

**WebSocket Events:**
- `trade:event` - Trade events (entries, fills, errors)
- `regime:change` - Regime transitions
- `regime:health` - Health mode changes
- `regime:position` - Position updates

### Scheduled Data Backups with Restore UI (v2.5+)
- Automated scheduled backups of all trading data to `data/backups/`
- ZIP-based archives using `spawnSync('zip', ...)` / `spawnSync('unzip', ...)`
- Excludes API keys (`*-keys.json`) and backups dir from archives
- Optionally excludes price cache files (~45MB per exchange, regenerable)
- Configurable via `global.backup` in config: `enabled`, `intervalMs`, `maxBackups`, `includePriceCache`
- Auto-prune oldest backups beyond `maxBackups` (default: 7)
- Admin UI at `/backups`: config panel, manual backup button, backup list with restore/delete
- Restore safety: stops all running regime engines before overwriting data files
- Path traversal protection on restore filenames
- Files: `src/backup-service.js`, backup endpoints in `server.js`, `admin/src/components/BackupRestore.jsx`
- API routes:
  ```
  GET    /api/backups                  - List backups + config
  POST   /api/backups                  - Create backup now
  DELETE /api/backups/:filename        - Delete one backup
  POST   /api/backups/:filename/restore - Restore backup (stops engines)
  GET    /api/backups/config           - Get backup config
  PUT    /api/backups/config           - Update backup config + reschedule
  ```

### Data Management
- Exchange-namespaced data directories
- Transaction logging in TSV format
- State persistence with migration support
- Price cache for backtesting

### Type System
- JSDoc type definitions in `src/types.js`
- `@ts-check` enabled for type checking in editors
- Comprehensive types for:
  - Exchange configurations and state
  - Order and fill results
  - API responses
  - Transaction records
- TypeScript-compatible `jsconfig.json` for IDE support

### ec8b7bcb Race Condition Fix & State Reconciliation (v2.5.28)
- **Root cause**: `cancelBodyTpOrder` had a race condition where the cancel-and-replace flow didn't check if the TP had already filled on exchange
- **Code fix (Part 1)**: `cancelBodyTpOrder` now returns `{cancelled, filled?}` and the merge flow aborts if the TP already filled
- **State corruption caused**: wrong cost basis, 266 wrongly-linked buys, bogus cycle reset to cycle-12, -$103.57 false loss, 2 unprocessed body TP fills
- **Reconciliation script** (`scripts/reconcile-state.js`): Idempotent 5-step repair script:
  1. Fix fill-ledger annotations (remove 266 bogus ec8b7bcb links, relabel cycle-12 → cycle-11)
  2. Ingest ALL missing fills from exchange (pending entries, older buys, sells, body TPs)
  3. Undo untracked handler's state corruption (realizedPnL +103.57, cyclesCompleted 11→10, rebuild cycleBuys)
  4. Process 2 unprocessed body TP fills (93cd9a00/body-65eddfb4, eeb06a32/body-90357600)
  5. Rebuild aggregates from remaining celestial bodies via `syncPositionState`
- **Recovery script** (`scripts/recover-btc.js`): Places market buy for 0.017023 BTC to cover the double-sell short position, annotates fills with ec8b7bcb linkage
- Both scripts support `--dry-run` flag and create timestamped backups before mutations

### Fill Ledger Sell Linkage Fix (v2.5.12)
- Fixed `sellOrderId` annotation using both `sourceOrderIds` and `body.buyOrders` (handles core-migration bodies)
- Core TP path no longer steals body-owned buys (`!fill.bodyId` guard)
- Offline fill detection now links source buys to the sell orderId
- One-time repair script: `scripts/repair-sell-linkage.js` (fixes 23 mismapped fills)
- Documentation: `docs/fill-ledger-sell-linkage.md`

### Sell Order Dedup Guard & Sequential Cycle IDs (v2.5.15)
- **Sell-fill dedup**: `recentlyProcessedSellFills` Set with 5-min TTL prevents double-processing when WS/reconcile/polling race
  - Fixes catastrophic state corruption where untracked fallback path treated entire position as holdback
- **Sequential cycle IDs**: Cycles now use `cycle-1`, `cycle-2`, etc. instead of `cycle-{timestamp}-{random}`
  - `startNewCycle()` uses auto-incrementing counter
  - `recalculateCycles()` renumbers all existing cycles sequentially on startup
  - Admin UI displays `#1`, `#2`, etc. for clean cycle identification
  - Cycle comparison uses numeric ordering instead of timestamp parsing

### Cycle-Grouped Filled Orders (v2.5.18)
- **Filled Orders card redesign**: Two-level hierarchy Cycle > Sell > Buys (live mode only)
  - `expandedCycles` state (Set) tracks which cycle sections are expanded
  - Most recent cycle auto-expanded on mount via useEffect + useRef init guard
  - Cycle headers show colored badge (blue=current, green=completed, gray=unassigned), sell/buy counts, aggregated BTC + P&L
  - Per-cycle subtotal row when multiple sells in a cycle
  - Grand totals bar at top shows sell count, cycle count, total BTC, total P&L
  - Cycle column removed from sell table (context provided by parent header)
  - Header shows cycle count alongside fill count: "23 fills (5 cycles)"
  - Toggle All/Current Cycles resets expandedCycles and re-inits auto-expand
- **DryRun mode**: Flat table rendering preserved (no cycle grouping, no regression)
- **DRY rendering**: Shared `renderSellRow` helper and `tableHeader` variable used by both paths
- **Edge cases**: null cycleId grouped as "Unassigned" (gray badge, sorted last)

### Body P&L Excluded from Realized P&L (v2.5.29)
- **Root cause**: `recalculateCycles()` and `rebuildPositionFromFills()` in fill-ledger.js skipped body TP sell fills (`isSatellite`) but still included their corresponding buy fills in cost basis calculations, inflating avgCost and producing incorrect (often negative) core cycle P&L
- **Fix 1**: fill-ledger.js — Added `|| fill.bodyId` filter alongside existing `fill.isSatellite` in `rebuildPositionFromFills()`, `recalculateCycles()` P&L loops, `getCurrentCycleBuysCount()`, and cycle detail counts
- **Fix 2**: server.js — Recalculate endpoint now includes `bodiesRealizedPnL + satelliteRealizedPnL` in realized P&L totals (matching the startup code in regime-engine.js)
- **Fix 3**: regime-engine.js — Merge-case buy fills now annotated with `{ isSatellite: true, bodyId, bodyTier }` for consistency with new-body creation path
- **Impact**: Realized P&L now correctly reflects body TP profits from both current and completed cycles

### Fix Duplicate TP Orders & Harden Cancel-Discovers-Fill Handling (v2.5.33)
- **Root cause**: When `cancelBodyTpOrder` fails during a merge, code still proceeded with merge and placed a second TP while the old one remained live on Coinbase
- **Critical bug fix**: `const mergeTarget` at two locations prevented reassignment (`mergeTarget = null` would throw TypeError). Changed to `let` in both live and dry-run merge paths
- **`safeCancelOrder` helper** (order-executor.js): Internal wrapper that cancels, then checks `getOrder` on failure to detect fills vs true failures. Returns `{cancelled, filled}` consistently
- **Hardened cancel functions**: `cancelBodyTpOrder`, `cancelSatelliteTpOrder`, `cancelAllSatelliteTpOrders`, `cancelAllLadderOrders` all now use `safeCancelOrder` and return structured `{cancelled, filled}` results
- **Merge abort simplification**: Both live and dry-run merge paths now abort on any cancel failure (filled or otherwise), redirecting buy to a new body instead of risking duplicate TPs
- **`placeBodyTp` guard**: Defensive check rejects duplicate TP placement when `body.tpOrderId` already exists
- **Startup cancel hardening**: Three `adapter.cancelOrder` sites in startup recovery now check `getOrder` on failure to detect fills, logging appropriately instead of silently failing
- **Dry-run consistency**: `cancelSatelliteTpOrder` and `cancelBodyTpOrder` in dry-run-executor.js updated to return `{cancelled, filled}` matching live executor
- **Design**: No inline fill processing during cancel — filled orders stay in `pendingOrders` for polling to process, avoiding re-entrancy. Sequential cancels replace `Promise.allSettled` in ladder cancel for API rate safety

### Race Condition Fixes (v2.5.39)
- **Race 1: Duplicate TP sells** — `cancelTpOrder()` now uses `safeCancelOrder()` and returns `{cancelled, filled, filledOrderId}`. `placeTakeProfitOrder()` detects fill-during-cancel and returns `filledDuringCancel` instead of placing a duplicate TP. Mutex serializes concurrent TP updates.
- **Race 2: State file corruption** — `atomicWriteSync()` helper (write-tmp + rename) prevents truncated JSON on crash. Optimistic version locking (`_saveVersion`) detects external edits and preserves protected fields (`celestialBodies`, `celestialState`, `realizedPnL`, `realizedBtcPnL`). Applied to `saveState()`, `saveRegimeState()`, and fill-ledger `persist()`.
- **Race 3: Orphaned sell fills after body merges** — `pendingMergeTpOrders` and `completedMergeTpOrders` Maps snapshot body data before TP cancellation during merges. If a TP fills after its body is removed from state, the fill handler finds the snapshot and processes P&L correctly. 60s TTL on completed snapshots.
- **Race 4: Stale celestial visualization after roll-up** — `handleRollUp` called `fetchStatus()` which set `localStatus`, but `socketStatus || localStatus` meant stale WebSocket status always won. Fix: use API response's `data.status` to directly set `socketStatus` via `setSocketStatus` from the hook, bypassing the timing race.
- **Reconciliation gap: cancelled/missing body TPs** — Periodic reconciliation only checked body TPs for `FILLED` status and swallowed all errors. Bodies with externally cancelled TPs became orphaned (visible in visualization, missing from Open Orders). Fix: detect `CANCELLED`/`FAILED`/404 and clear body TP fields for automatic re-placement.
- **New file**: `src/async-mutex.js` — Promise-based mutex (zero deps)
- **Test suite**: `tests/race-conditions.test.js` — 13 tests across 4 describe blocks covering all 3 races + mutex utility

### Editable Aggressiveness Presets (v2.5.23)
- **Presets stored in config.json**: `global.aggressivenessPresets` with 4 levels (conservative, moderate, aggressive, maximum), each containing 8 params (kFactor, minIntervalMs, maxIntervalMs, entryOffsetBps, baseSizeUsdc, cautionScale, trendScale, maxCycleBuys)
- **Backend**: `getAggressivenessPresets()` / `updateAggressivenessPresets()` in config-utils.js, `GET/PUT /api/presets/aggressiveness` in server.js
- **RegimeDashboard**: Fetches presets from API on mount, passes to `AggressivenessControl` as prop. Preview panel now includes maxCycleBuys
- **ConfigEditor**: New "Aggressiveness Presets" section with 4 collapsible cards, each showing 8 editable fields with independent save/reset

---

## Architecture

### File Structure
```
src/
├── types.js            # JSDoc type definitions
├── adapters/           # Exchange abstraction layer
│   ├── base-adapter.js # Interface definition
│   ├── index.js        # Registry and factory
│   ├── coinbase/       # Coinbase implementation
│   ├── gemini/         # Gemini implementation (REST + WebSocket)
│   └── cryptocom/      # Crypto.com implementation (REST + WebSocket)
├── config-utils.js     # Multi-exchange config management
├── dca-engine.js       # Core trading logic (fixed + fibonacci strategies)
├── fibonacci-utils.js  # Fibonacci sequence and cycle calculations
├── interval-utils.js   # Time interval calculations
├── order-manager.js    # Order execution and tracking
├── state-tracker.js    # State persistence (including fib cycle state)
├── logger.js           # Transaction logging
├── migration.js        # Data structure migration
├── backtest-engine.js  # Historical simulation (fixed + fibonacci)
├── optimizer-engine.js # Parameter optimization
│
│ # Regime Engine Components (v2.4/2.5/2.6)
├── regime-engine.js    # Main regime-aware trading engine
├── celestial-hierarchy.js # Celestial body tier system (satellite→moon→planet→sun→hypergiant→black hole)
├── regime-detector.js  # Regime classification (HARVEST/CAUTION/TREND)
├── macro-regime.js     # Multi-timeframe macro regime (ACCUMULATION/RANGING/MARKUP/DECLINE)
├── volatility-utils.js # ATR, RV, VWAP, swing, EMA calculations
├── position-sizer.js   # Liquidity-aware position sizing
├── order-executor.js   # Maker-prefer limit order placement + ladder orders
├── ladder-calculator.js # Ladder mode calculations (levels, sizing, ATH)
├── dry-run-executor.js # Simulated order execution for dry-run mode
├── dry-run-state.js    # State persistence for dry-run simulations
├── tp-optimizer.js     # Dynamic TP auto-management with histogram compression
├── size-optimizer.js   # Dynamic position sizing based on available capital
├── health-monitor.js   # SAFE mode and system health
├── tail-events.js      # Flash/spread/depth event detection
├── websocket-feed.js   # WebSocket feed factory (dispatches to exchange-specific implementations)
├── fill-ledger.js      # Idempotent fill tracking with cost basis
├── recovery.js         # Startup state recovery from exchange
├── trade-events.js     # Trade event emitter for WebSocket updates
├── notifier.js         # Telegram notification system (event routing, batching, daily summaries)
└── backup-service.js   # Scheduled backup/restore service (zip-based, auto-prune)

admin/src/components/
├── Systems.jsx         # Debug/showcase page rendering all body types in hierarchical orbit
├── celestial/          # 3D celestial system visualization
│   ├── celestialConstants.js       # Tier colors, sizes, speeds, hierarchical orbit config
│   ├── CelestialVisualization.jsx  # Card wrapper (lazy-loaded Canvas container)
│   ├── CelestialScene.jsx          # R3F scene composition (lights, stars, bloom, controls)
│   ├── HierarchicalOrbit.jsx       # Recursive nested orbit chain (largest→smallest)
│   ├── CelestialBody.jsx           # Body visual (sphere/custom + glow, no orbital motion)
│   ├── BlackHole.jsx               # Black hole visual (dark core + tight accretion disk)
│   ├── GalaxyBody.jsx              # Galaxy visual (spiral particle arms + bright core)
│   ├── HypergiantGeometry.jsx      # Hypergiant mesh (Jupiter-like gas band texture)
│   ├── hypergiantTexture.js        # Procedural canvas gas band texture (singleton)
│   ├── MoonGeometry.jsx            # Moon mesh (cratered procedural texture)
│   ├── moonTexture.js              # Procedural canvas lunar surface texture (singleton)
│   ├── SatelliteGeometry.jsx       # Satellite composite (bus + solar panels + antenna)
│   ├── OrbitalRing.jsx             # Translucent ring showing orbital path (legacy)
│   ├── IncomingOrder.jsx           # Open buy orders as wireframe satellites
│   └── CelestialTooltip.jsx        # HTML overlay tooltip on hover
├── charts/             # D3.js chart components
│   ├── index.js        # Chart exports
│   ├── chartUtils.js   # Formatting, colors, responsive utils
│   ├── AreaChart.jsx   # Area and stacked area charts
│   ├── BarChart.jsx    # Bar and horizontal bar charts
│   ├── PriceChart.jsx  # Price line with buy markers
│   ├── ComposedChart.jsx # Multi-series area/line charts
│   ├── PendingOrdersChart.jsx # Order visualization
│   ├── MiniPriceSparkline.jsx  # Compact price sparkline for status bar
│   ├── RegimePriceChart.jsx    # Price chart with ATR trigger bands
│   ├── VolatilityChart.jsx     # ATR/volatility area chart
│   └── RegimeTimeline.jsx      # Horizontal regime history bar
├── ChartsDCA.jsx          # DCA strategy charts page
├── ChartsRegime.jsx       # Regime strategy charts page
├── CostBasisDCA.jsx       # DCA order-based cost basis view
├── CostBasisRegime.jsx    # Regime cycle-based cost basis view
├── TransactionsDCA.jsx    # DCA TSV-based transaction log
├── TransactionsRegime.jsx # Regime fill ledger transactions
├── Dashboard.jsx          # DCA main dashboard view
├── RegimeDashboard.jsx    # Regime engine control panel with live charts
├── ConfigEditor.jsx       # Strategy-aware configuration editor
├── ExchangeSelector.jsx   # Exchange + Strategy selector dropdown
├── NotificationsConfig.jsx # Telegram notification settings page
├── BackupRestore.jsx      # Scheduled backup config + restore UI
└── ...                    # Other components

admin/src/hooks/
├── useTradeEvents.js    # WebSocket event subscriptions
└── useChartDataBuffer.js # 15-minute rolling data buffer for charts
```

### Configuration Format
```json
{
  "exchanges": {
    "coinbase": { /* exchange-specific settings */ },
    "gemini": { /* exchange-specific settings */ },
    "cryptocom": { /* exchange-specific settings */ }
  },
  "global": {
    "schedulerInterval": 30000
  }
}
```

### Data Namespacing
```
data/
├── coinbase/
│   ├── state.json
│   ├── transactions.tsv
│   ├── btc-price-cache-*.json
│   ├── fill-ledger.json     # Regime engine fill tracking
│   └── regime-state.json    # Regime engine position state
├── gemini/
│   ├── state.json
│   └── transactions.tsv
├── cryptocom/
│   ├── state.json
│   └── transactions.tsv
├── coinbase-keys.json
├── gemini-keys.json
└── cryptocom-keys.json
```

---

## API Routes

```
GET  /api/exchanges              - List all exchanges
GET  /api/:exchange/summary      - Exchange summary with status
GET  /api/:exchange/config       - Get exchange configuration
PUT  /api/:exchange/config       - Update exchange configuration
GET  /api/:exchange/keys         - Get API keys (masked)
PUT  /api/:exchange/keys         - Save API keys
POST /api/:exchange/test-connection - Test exchange connectivity
POST /api/:exchange/trade        - Trigger manual trade
POST /api/:exchange/consolidate  - Consolidate pending orders
GET  /api/:exchange/transactions - Get transaction history
GET  /api/:exchange/cost-basis   - Get cost basis report
POST /api/:exchange/backtest     - Run backtest simulation
POST /api/:exchange/optimize     - Run parameter optimization

# Aggressiveness Presets (global)
GET  /api/presets/aggressiveness  - Get aggressiveness presets (merged with defaults)
PUT  /api/presets/aggressiveness  - Update aggressiveness presets

# Notifications (global, not exchange-specific)
GET  /api/notifications/config   - Get notification config (token masked)
PUT  /api/notifications/config   - Update notification config
POST /api/notifications/test     - Send test Telegram message
GET  /api/notifications/stats    - Get notifier stats
```

---

## Exchange Adapter Interface

Required methods for each adapter:
- `loadCredentials()` - Load API keys
- `getAccountBalance(currency)` - Get balance
- `getCurrentPrice(productId)` - Get current price
- `getProductDetails(productId)` - Get trading details
- `placeMarketBuy(productId, amount)` - Execute market buy
- `placeLimitSell(productId, amount, price)` - Place limit sell
- `getOrder(orderId)` - Get order status
- `getOpenOrders(productId)` - List open orders
- `cancelOrder(orderId)` - Cancel an order
- `getOrderFills(orderId)` - Get fill details
- `getCandles(productId, start, end, granularity)` - Get price history

---

## Future Considerations

- Additional exchange adapters (Kraken, Binance US)
- Multiple trading pairs support
- Advanced order types (trailing stops)
- Portfolio rebalancing
- Tax reporting exports
- Mobile notifications (push; Telegram notifications implemented in v2.5)

---

## Prediction Market Arbitrage System (Proposed Feature)

### Overview

Extension to support prediction market arbitrage on platforms like **Kalshi** (US-regulated) and **Polymarket** (crypto-based). Unlike spot crypto trading which requires directional prediction, prediction market arbitrage exploits mathematical pricing inefficiencies for risk-free or low-risk returns.

**Key Insight**: Prediction markets often misprice correlated events, allowing traders to lock in guaranteed profits by buying combinations that must collectively pay out more than their total cost.

### Five Arbitrage Strategy Types

Based on analysis of successful prediction market traders:

#### 1. Basic Arbitrage (Same-Market Spread)
- **Concept**: Buy both YES and NO shares on the same market when total cost < $1
- **Example**: YES @ $0.45 + NO @ $0.51 = $0.96 → Guaranteed $1 payout
- **Profit**: 4.2% return regardless of outcome
- **Risk**: Zero (one side MUST pay $1)
- **Detection**: Monitor bid/ask spreads on single markets

#### 2. Mutually Exclusive Arbitrage
- **Concept**: Two events where exactly one must be true
- **Example**: "Winner is A" vs "Winner is NOT A" across different markets
- **Opportunity**: Combined YES positions < $1 total
- **Risk**: Near-zero (definitional exclusivity)
- **Detection**: Identify markets with logical mutual exclusivity

#### 3. Contradiction Arbitrage
- **Concept**: Two markets make opposing claims about the same event
- **Example**: Market A says "X will happen", Market B says "X won't happen"
- **Trade**: Buy YES on one, buy equivalent position on other
- **Risk**: Low (depends on settlement consistency)
- **Detection**: NLP/semantic analysis of market descriptions

#### 4. One-of-Many (Multi-Date) Arbitrage ⭐ *Primary Strategy*
- **Concept**: Event markets with different date thresholds where earlier events trigger later ones
- **Example**: "US strikes Iran by March/April/June" - if March YES, then April and June also YES
- **Trade**: Buy NO on multiple dates where total NO cost < $1
- **Math**: If event happens in March → lose March NO, but didn't buy April/June NO
         If event never happens → ALL NO positions pay $1 each
- **Optimal**: Buy NO positions whose combined cost guarantees profit either way
- **Risk**: Minimal if positions properly sized
- **Detection**: Find related markets with cascading logic

#### 5. Must-Happen (Exhaustive) Arbitrage
- **Concept**: Set of outcomes where exactly one MUST occur
- **Example**: "Election winner: A, B, C, D" where all YES positions < $1 total
- **Trade**: Buy YES on all outcomes
- **Risk**: Zero (one outcome must win)
- **Detection**: Markets with exhaustive, mutually exclusive outcomes

### Proposed Architecture

```
src/
├── adapters/
│   ├── kalshi/                    # Kalshi API adapter
│   │   ├── index.js               # Main adapter
│   │   ├── auth.js                # Kalshi authentication
│   │   ├── markets.js             # Market data fetching
│   │   └── orders.js              # Order placement
│   └── polymarket/                # Polymarket adapter (optional)
│       ├── index.js
│       └── ...
├── arbitrage/
│   ├── arbitrage-engine.js        # Main orchestrator
│   ├── arbitrage-detector.js      # Opportunity detection
│   ├── arbitrage-types.js         # Strategy implementations
│   │   ├── basic-spread.js        # Type 1: Same-market spread
│   │   ├── mutual-exclusive.js    # Type 2: Mutually exclusive events
│   │   ├── contradiction.js       # Type 3: Contradicting markets
│   │   ├── multi-date.js          # Type 4: Date-cascading events
│   │   └── exhaustive.js          # Type 5: Must-happen sets
│   ├── market-correlator.js       # Find related/correlated markets
│   ├── profit-calculator.js       # ROI and risk calculations
│   ├── position-tracker.js        # Track open arb positions
│   └── settlement-monitor.js      # Monitor settlements/payouts
└── types/
    └── kalshi.d.ts                # Kalshi API types

admin/src/components/
├── arbitrage/
│   ├── ArbitrageDashboard.jsx     # Main arbitrage control panel
│   ├── OpportunityScanner.jsx     # Real-time opportunity display
│   ├── ActivePositions.jsx        # Current arbitrage positions
│   ├── ProfitTracker.jsx          # Historical profits
│   └── MarketCorrelations.jsx     # Visualize correlated markets
```

### Data Models

```javascript
// Arbitrage Opportunity
{
  id: string,
  type: 'basic' | 'mutual_exclusive' | 'contradiction' | 'multi_date' | 'exhaustive',
  markets: [{
    marketId: string,
    ticker: string,
    title: string,
    side: 'YES' | 'NO',
    price: number,      // Cost per share (0.01-0.99)
    shares: number,     // Recommended position size
    cost: number        // Total cost for position
  }],
  totalCost: number,    // Combined cost of all positions
  guaranteedPayout: number,  // Minimum payout regardless of outcome
  profit: number,       // Guaranteed profit (payout - cost)
  roi: number,          // Return on investment percentage
  confidence: number,   // 0-1 confidence in correlation logic
  expiresAt: Date,      // Earliest market expiration
  detectedAt: Date
}

// Arbitrage Position
{
  id: string,
  opportunityId: string,
  type: string,
  legs: [{
    orderId: string,
    marketId: string,
    side: 'YES' | 'NO',
    shares: number,
    fillPrice: number,
    status: 'open' | 'settled' | 'expired'
  }],
  totalInvested: number,
  realizedPayout: number,
  realizedProfit: number,
  status: 'open' | 'partial_settle' | 'complete',
  openedAt: Date,
  settledAt: Date
}
```

### Configuration

```json
{
  "exchanges": {
    "kalshi": {
      "enabled": true,
      "dryRun": true,
      "apiEndpoint": "https://trading-api.kalshi.com",
      "strategies": {
        "arbitrage": {
          "enabled": true,
          "types": ["basic", "multi_date", "exhaustive"],
          "minRoiPercent": 2.0,
          "maxPositionUsd": 1000,
          "maxTotalExposure": 10000,
          "minConfidence": 0.95,
          "autoExecute": false,
          "scanIntervalMs": 60000,
          "categories": ["politics", "economics", "crypto"]
        }
      }
    }
  }
}
```

### API Endpoints

```
# Market Data
GET  /api/kalshi/markets                    - List available markets
GET  /api/kalshi/markets/:id                - Get market details
GET  /api/kalshi/markets/correlated         - Find correlated market groups

# Arbitrage
GET  /api/kalshi/arbitrage/opportunities    - Current arbitrage opportunities
GET  /api/kalshi/arbitrage/opportunities/:type  - Filter by strategy type
POST /api/kalshi/arbitrage/execute          - Execute arbitrage opportunity
GET  /api/kalshi/arbitrage/positions        - Active arbitrage positions
GET  /api/kalshi/arbitrage/history          - Historical arbitrage trades
GET  /api/kalshi/arbitrage/pnl              - Profit/loss summary

# Monitoring
GET  /api/kalshi/arbitrage/alerts           - Active opportunity alerts
POST /api/kalshi/arbitrage/watch            - Add market to watchlist
GET  /api/kalshi/arbitrage/correlations     - Market correlation analysis
```

### Detection Algorithms

#### Multi-Date Event Detection (Primary)
1. Fetch all markets in a category (e.g., geopolitics)
2. Group by underlying event using NLP on titles:
   - Extract entity (e.g., "Iran", "Russia", "Bitcoin")
   - Extract action (e.g., "strikes", "reaches", "passes")
   - Extract date threshold (e.g., "by March", "before April")
3. For each event group with multiple dates:
   - Sort markets by date threshold
   - Calculate: if NO on all later dates, what's the max loss if event happens at each date?
   - Find optimal NO combination where: sum(NO_costs) < $1 guaranteed
4. Alert when ROI > minRoiPercent

#### Pricing Inefficiency Detection
1. For each market, continuously track:
   - Best bid/ask for YES and NO
   - Implied probability (YES price ≈ probability)
2. Alert when: best_ask_YES + best_ask_NO < 0.98 (2%+ guaranteed return)
3. Account for fees in calculations

### Execution Logic

```javascript
async function executeArbitrageOpportunity(opportunity) {
  // 1. Validate opportunity still exists at expected prices
  const currentPrices = await fetchCurrentPrices(opportunity.markets);
  const stillProfitable = validateProfitability(opportunity, currentPrices);

  if (!stillProfitable) {
    return { success: false, reason: 'prices_moved' };
  }

  // 2. Calculate optimal order sizes based on liquidity
  const orders = calculateOptimalOrders(opportunity, currentPrices);

  // 3. Execute all legs atomically (as close as possible)
  const results = await Promise.all(
    orders.map(order => placeOrder(order))
  );

  // 4. Track position
  const position = createPosition(opportunity, results);
  await savePosition(position);

  // 5. Set up settlement monitoring
  monitorSettlement(position);

  return { success: true, position };
}
```

### Risk Considerations

1. **Liquidity Risk**: Large orders may not fill at expected prices
2. **Timing Risk**: Prices move between leg executions
3. **Settlement Risk**: Unclear market resolutions
4. **Platform Risk**: Exchange downtime, withdrawal issues
5. **Regulatory Risk**: Changing rules on prediction markets

### Mitigation Strategies

1. **Slippage Protection**: Only execute if current prices still profitable after fees
2. **Size Limits**: Cap individual position and total exposure
3. **Confidence Thresholds**: Only trade high-confidence correlations
4. **Diversification**: Spread across multiple uncorrelated opportunities
5. **Manual Review Mode**: Alert but don't auto-execute for review

### Implementation Phases

**Phase 1: Foundation**
- [ ] Kalshi API adapter (auth, markets, orders)
- [ ] Basic arbitrage detector (Type 1: spread monitoring)
- [ ] Manual execution via admin UI
- [ ] Position tracking

**Phase 2: Multi-Date Strategy**
- [ ] Market correlation engine
- [ ] Multi-date event grouping
- [ ] Type 4 arbitrage detection
- [ ] Profit/risk calculator

**Phase 3: Automation**
- [ ] Auto-execution with safeguards
- [ ] Real-time monitoring
- [ ] Telegram/Discord alerts
- [ ] Settlement tracking

**Phase 4: Advanced Strategies**
- [ ] Types 2, 3, 5 detection
- [ ] NLP for market relationship inference
- [ ] Historical backtesting
- [ ] Portfolio optimization

---

## Exchange-Specific Notes

### Gemini Exchange
- Uses HMAC-SHA384 authentication for REST API
- Symbol format: `btcusd` (lowercase, no separator, USDC→USD mapping)
- WebSocket v2: `wss://api.gemini.com/v2/marketdata` (public, no auth)
  - Subscribe via `{ type: "subscribe", subscriptions: [{ name: "l2", symbols: ["BTCUSD"] }] }`
  - L2 updates: `{ type: "l2_updates", symbol, changes: [[side,price,qty]], trades: [...] }`
  - Trade events: `{ type: "trade", symbol, price, quantity, side, tid, timestamp }`
  - Best bid/ask derived from L2 changes; last price from trade events
  - No server heartbeat — client-side ping/pong used for keepalive

### Crypto.com Exchange
- Uses HMAC-SHA256 authentication with alphabetically sorted parameters
- Instrument format: `BTC_USDT` (underscore separator, uppercase)
- Spot trading uses `spot_margin: "SPOT"` parameter
- Market buy orders use `notional` field for quote amount
- API documentation: https://exchange-docs.crypto.com/exchange/v1/rest-ws/index.html
- Keys file: `data/cryptocom-keys.json` with `{ "apiKey": "...", "apiSecret": "..." }`
- WebSocket: `wss://stream.crypto.com/exchange/v1/market` (public channels, no auth needed)
  - Ticker channel: `ticker.{instrument_name}` — fields: `a` (price), `b` (bid), `k` (ask), `v` (volume), `t` (timestamp)
  - Trade channel: `trade.{instrument_name}` — fields: `p` (price), `q` (qty), `s` (side), `t` (timestamp), `d` (trade ID)
  - Must wait 1s after connection before subscribing (rate limit protection)
  - Server heartbeat: respond to `public/heartbeat` with `public/respond-heartbeat`

### DCA-to-Regime Conversion
- `src/dca-converter.js` converts DCA orders into regime fill-ledger entries and celestial bodies
- After conversion, marks all converted DCA orders as `status: 'migrated_to_regime'` to hide from DCA dashboard
- DCA dashboard filters out migrated orders; "Upgrade DCA Orders" button hidden when no pending orders remain
- **Merge mode**: `mergeToRegime()` imports DCA positions into an existing regime state non-destructively
  - Preserves existing celestial bodies, regime state, tpOptimizer, sizeOptimizer
  - Creates new bodies with `tpOrderId: null` — regime engine places sell orders on start
  - Adds DCA `assetReserves` to `realizedAssetPnL` and `totalAllocated` to `depositedCapital`
  - Buy fills marked `isBodyOwned: true` to avoid conflicting with core position tracking
  - Preview response includes `merge` flag and existing body/asset counts
  - API: `POST /api/:exchange/regime/convert-dca` with `{ merge: true }` in body
  - Frontend: "Export to Regime" button on DCA Dashboard, updated "Import" flow on Regime Dashboard
