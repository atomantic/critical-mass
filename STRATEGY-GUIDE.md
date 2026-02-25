# Kalshi Strategy Guide

This document serves as the authoritative reference for strategy configuration, known failure modes, and the rationale behind current settings. **Any automated system modifying config MUST consult this guide before making changes.**

## Golden Rules

1. **Kelly sizing is upstream, liquidity sizing is downstream.** Kelly computes the DESIRED contract count. `live-execution-service.js` then caps it to available orderbook liquidity via `availableContracts()`. Never remove or bypass the liquidity-aware sizing — it prevents orders that can't fill.

2. **The edge sanity cap prevents bugs, not large edges.** Near settlement (30-60s), legitimate edges of 60-80% are common on stale-priced brackets. The cap (`maxEdgeSanity`) should be 0.85, not lower. Setting it to 0.50 blocks the ONLY profitable signals the bot finds.

3. **The market is efficiently priced most of the time.** Near-money brackets track fair value within 1-3%. Profitable opportunities only appear when market makers leave stale prices on OTM brackets near settlement. Raising thresholds to "be safer" often means zero trades, not fewer losses.

4. **Binary bracket markets are all-or-nothing.** Positions settle at $0 or $1. Risk control comes from POSITION SIZING (small bets), not from entry threshold tuning. A 25% edge threshold with $50 bets is riskier than a 15% threshold with $10 bets.

5. **Exit logic must always be reachable.** Any code path that blocks evaluation (time filters, liquidity checks) must run AFTER exit checks for held positions. A position that can't be exited is a position that rides to settlement.

## Current Strategy Configuration (as of 2026-02-25)

### Settlement Sniper (LIVE)
- **What it does**: Uses Black-Scholes-style probability model to find mispriced brackets 2-5 min before settlement
- **Edge threshold**: 0.15 (15%)
- **Momentum requirement**: 0.40 (40%)
- **Settlement ride**: DISABLED (threshold 1.0)
- **minSigma**: 0.20 (lowered from 0.40 on 2026-02-25 — see "Why minSigma 0.20" below)
- **Position sizing**: kellyFraction 0.25, maxBetPct 0.12, maxContracts 200
- **Skips daily markets**: Black-Scholes not calibrated for daily horizons

### Coinbase Fair Value (DISABLED)
- **Status**: Disabled — no live trades since Feb 18. 0% settlement-ride win rate (3/4 rides to $0). Needs re-evaluation with calibrated sigma.
- **Force exit**: 60s before settlement (avoids binary risk)
- **Position sizing**: kellyFraction 0.15, maxBetPct 0.03, maxContracts 100

### Gamma Scalper (DISABLED — shadow only)
- **Status**: Disabled — 10% dry-run WR, 100% of live signals blocked by slippage guard. OTM brackets have no resting liquidity.
- **Position sizing**: maxBetPct 0.02, maxContracts 50, maxPositions 3

### Swing Flipper (LIVE)
- **What it does**: Rides intra-window oscillation on ATM brackets (30-60¢). Buys pullbacks (8¢ below recent peak) and sells recoveries for 8¢ flips.
- **ATM range**: 30-60c
- **Oscillation requirement**: 12¢+ range in last 15 snapshots
- **Spot confirmation**: Composite/Coinbase spot must be (a) near the bracket boundary and (b) moving toward it
- **Exit conditions**: Take profit at +8¢, stop loss at -6¢, time exit at minTTL, oscillation collapse at <6¢ range
- **Position sizing**: maxBetPct 0.02, maxContracts 30, maxPositions 2
- **Daily market support**: TIME_SCALES widens windows (minTTL 1800s, maxTTL 28800s, oscLookback 60, collapseLookback 30)
- **Critical fix (2026-02-25)**: Exit logic moved before time filter — previously exits were unreachable on daily brackets once TTL < minTTL, causing 100% settlement losses. See failure mode #14.
- **Do NOT change**: `takeProfitCents` to >10 (greed kills), `stopLossCents` to >8 (must cut fast), `minOscillationRange` to <8 (need proven swings)

### Momentum Rider (DISABLED — shadow only)
- **Status**: Disabled — 20.4% dry-run WR with -$83 P&L at minTrendTicks=5. Not producing meaningful edge.

## Why These Settings (Do NOT Revert Without Reading This)

### Edge Threshold: 0.15 not 0.25
- **Problem at 0.25**: With 1.3x time scaling, effective threshold is 32.5%. In 7+ hours of monitoring (54 settlement windows), the bot found edges of 0.1-7.2% on efficiently-priced near-money brackets — zero trades.
- **Problem at 0.15**: With 1.3x time scaling, effective threshold is 19.5%. Still no trades on near-money brackets, but allows moderate-edge signals (15-20%) that appear on OTM brackets near settlement.
- **The winning trades come from 60%+ edges in the final 30-40s** when stale prices diverge from fair value. These pass through the edge sanity cap (0.85), not the strategy threshold. The threshold mainly affects whether moderate opportunities trigger.

### Max Seconds to Settlement: 300 not 180
- **Problem at 180**: Only evaluates for 3 minutes. Market makers are actively quoting during this period, so edges are tiny (0.1-3%).
- **Why 300**: Gives 5 minutes of evaluation. In practice, tradeable edges still only appear in the final minute, but the strategy needs to be watching to catch them.
- **Why NOT higher**: Beyond 5 min, the probability model's vol estimate is unreliable and generates false signals.

### Edge Sanity Cap: 0.85 not 0.50
- **2026-02-17 14:00 UTC**: CFV found 61% edge on B68125 (YES), which WAS the winning bracket. Blocked by 0.50 cap. This was the ONLY winning live signal in 54 windows.
- **Why it's legitimate**: BTC was at $68,074, solidly in the [$68,000, $68,250) bracket with 40s to settlement. Market was still priced at ~34c (stale). Fair value was ~95%. Edge = 61%. Not a bug.
- **Why not 1.0**: Edges above 85% usually indicate a data error or stale WebSocket feed. Keep some guard rail.

### Why minSigma 0.20 not 0.40
- **Problem at 0.40**: The sigma calibration fix (2026-02-20) measured realized BTC vol at 0.16-0.20 across 170 data points. A minSigma of 0.40 forces 2x actual volatility, pushing Black-Scholes probabilities toward 0.50 and suppressing edge detection. The code default was lowered to 0.18 but the config override of 0.40 defeated the calibration.
- **Why 0.20**: Slight buffer above realized vol (0.16-0.20) to handle regime changes. Not so high that it corrupts probability estimates.
- **If overcorrecting** (sigma ratio < 0.8 in window summaries): bump to 0.22.

### Momentum Rider entryThreshold: 45 not 65
- **Problem at 65**: ATM brackets price at 40-55c — the YES-side where real liquidity exists. The 65c threshold blocked every ATM entry.
- **Why 45**: ATM prices have real YES-side orderbook depth. At 50c, the fee is only 2c per contract (breakeven at 51% accuracy).

### Settlement Ride: Disabled (1.0)
- **What it was**: At `settlementRideThreshold: 0.40`, the sniper could skip its 60s exit window if edge > 40% and ride to settlement.
- **Why disabled**: In 3/3 live trades, the model showed high edge but the bracket missed. Riding to settlement = guaranteed 100% loss. Can re-enable after shadow testing validates the feature.

## What We Tried That Did NOT Work

### 1. High edge thresholds to prevent losses (0.25+)
**Result**: Zero trades for 7+ hours. The market is too efficient for strategies to find 25%+ edges in the evaluation window. Losses are better prevented by position sizing.

### 2. Kelly sizing without liquidity awareness
**Result**: Kelly wanted 67-200 contracts, orderbooks had 5-10. Orders either failed or got terrible fills. Fixed by `availableContracts()` in live-execution-service.

### 3. Edge sanity cap at 0.50
**Result**: Blocked the only profitable signal type (60%+ edges on stale brackets near settlement). Raised to 0.85.

### 4. Momentum threshold at 0.60 for sniper
**Result**: Blocked every sniper signal. OTM markets are too illiquid for smooth momentum. Lowered to 0.40.

### 5. CFV time scaling unbounded (up to 2.22x)
**Result**: At 300s TTL, effective threshold was 25% x 2.22 = 55.5%. Nothing passed. Capped at 1.3x.

### 6. Settlement riding (settlementRideThreshold: 0.40)
**Result**: 3/3 positions rode to $0 instead of exiting early. Disabled by setting to 1.0.

### 7. edgeThreshold at 0.20 + maxSecondsToSettlement at 300
**Result**: Allowed 2 losing trades (moderate edge, entered too early). But the problem was position SIZING ($52/trade), not the threshold. After fixing sizing (maxBetPct 0.03, maxContracts 100), the same settings would risk ~$10/trade max.

### 8. CFV without forced pre-settlement exit (Feb 16-18)
**Result**: 3 of 4 CFV settlement-rides went to $0 (-$148 total). Fixed by adding `forceExitSeconds: 60`.

### 9. Evaluating high-risk strategies before low-risk ones (Feb 16-18)
**Result**: Sniper and CFV claimed settlement windows before gamma-scalper or momentum-rider could evaluate. Fixed by reordering eval priority.

### 10. Gamma scalper live: 100% slippage-blocked (Feb 18-19)
**Result**: Every signal blocked by slippage guard (estimated fill 95¢ vs limit 7¢ + 3¢ max slippage). OTM brackets have no resting NO-side liquidity. Disabled.

### 11. Momentum rider noise at minTrendTicks=3 (Feb 18-19)
**Result**: 98 dry-run trades but only 20.4% WR, -$83.35 P&L. Increased to 5.

### 12. Settlement sniper at edgeThreshold=0.18 (Feb 18-19)
**Result**: Edges consistently 12-15%, just below 18% threshold. Reduced to 0.15.

### 13. Limit order retry without fill check (Feb 24)
**Result**: `handleLimitFillTimeout` cancelled the initial 3s-timeout order, got 404 (already filled), but didn't verify via fills API. Retried at price+1, double-buying 200 contracts. Then oscillation collapse triggered 3 sell orders (300 total vs 200 held), creating unintended 100 NO short position. **Fix**: Added fill-check on 404 in retry path, added sell-duplicate guard via `pendingReservations`.

### 14. Swing-flipper exits unreachable on daily brackets (Feb 22-25)
**Result**: The `checkExit()` call was nested AFTER the time filter in `evaluate()`. For daily brackets (minTTL=1800s), once TTL dropped below 30 minutes, the `continue` at the time filter fired before `checkExit` was reached. Take-profit, stop-loss, time-exit, and oscillation-collapse exits NEVER fired. Every daily bracket position rode to settlement. 13 trades, 46% WR, -$212 — average win $7.57 vs average loss $36.82 (4.9:1 loss/win ratio). **Fix (2026-02-25)**: Exit evaluation moved before time filter. Time filter now only blocks new entries, not exits.

### 15. Aggressive sizing overhaul caused outsized losses (Feb 22-24)
**Result**: Swing-flipper sizing increased from maxBetPct 0.01/maxContracts 15 to 0.12/100. Combined with the exit bug (#14), this meant 100-contract positions riding to settlement instead of 15-contract positions. The sizing was reverted to conservative (maxBetPct 0.02, maxContracts 30) after observing the loss pattern. **Lesson**: Never increase sizing and change market scope (adding daily) simultaneously — isolate variables.

### 16. minSigma 0.40 after calibration fix (Feb 20-25)
**Result**: The sigma calibration fix lowered the code default from 0.40 to 0.18, but the config file still overrode it to 0.40. Realized vol was 0.16-0.20 — the 0.40 floor meant the Black-Scholes model always assumed 2x actual volatility, pushing all probabilities toward 0.50 and suppressing edge detection for the settlement sniper. **Fix (2026-02-25)**: Config `minSigma` lowered to 0.20.

## Strategy Evaluation Order (as of 2026-02-19)

Strategies are evaluated in this order. Within each settlement window, only one position is allowed — so evaluation order determines which strategy gets priority.

1. **Gamma Scalper** — lowest risk per trade (~$4), exits before settlement
2. **Momentum Rider** — pre-settlement exit via profit target + safety exit at 45s
3. **Swing Flipper** — pre-settlement exit via take-profit/stop-loss
4. **Coinbase Fair Value** — forced exit at 60s before settlement
5. **Settlement Sniper** — settlement-riding (highest risk, disabled ride = exits at 60s)

**Rationale**: Pre-settlement-exit strategies evaluate first. Settlement-riding strategies have a 0% win rate on 4 live settlement rides.

## Risk Controls (Do NOT Weaken)

| Control | Setting | Purpose |
|---------|---------|---------|
| `maxEdgeSanity` | 0.85 | Block signals with edges > 85% (likely data errors) |
| `maxDailyLoss` | $500 | Circuit breaker halts all trading |
| `maxExposurePerWindow` | $200 | Cap total risk per settlement event |
| `maxBetPct` | strategy-specific | Per-strategy bankroll % cap |
| `maxContracts` | strategy-specific | Per-strategy hard cap on contract count |
| `maxTradesPerHour` | 10 | Rate limit to prevent runaway trading |
| `maxOpenPositions` | 20 | Limit concurrent exposure |
| `maxPositionContracts` | 500 | Global per-ticker contract cap |
| Cross-position conflict | Code | Only 1 position per settlement window |
| Liquidity-aware sizing | Code | Orders capped to available orderbook depth |
| Reconciliation adoption cap | Code | api_only positions exceeding maxPositionContracts are not auto-adopted |

## Known Failure Modes (Updated 2026-02-25)

### 1. Cross-bracket double-entry (-$96 loss)
Two strategies entered the same settlement window on adjacent brackets with opposing views — both lost. **Fix**: Conflict check now scans `state.trades` for recent buy trades in the same settlement window.

### 2. Reconciliation always assumed loss (-$106 loss)
`engine_only` discrepancies were hardcoded as `price: 0` (full loss) regardless of actual outcome. **Fix**: Reconciliation now uses `determineBracketOutcome()` with current BTC spot.

### 3. Settlement-riding strategies have 0% live win rate
Settlement-riding (sniper, CFV) went 0/4 on live rides. **Fix**: Added pre-settlement forced exits: 45s for momentum-rider, 60s for CFV, settlement ride disabled for sniper.

### 4. Strategy evaluation order let high-risk strategies crowd out low-risk ones
**Fix**: Evaluation reordered: gamma-scalper → momentum-rider → swing-flipper → CFV → sniper.

### 5. CFV held positions to binary settlement (-$148 over 3 trades)
**Fix**: Added `forceExitSeconds: 60` that forces exit before settlement.

### 6. Reconciled positions from early engine loop bug (-$1,039 over 36 trades)
An early engine bug placed oversized positions (200-300 contracts) that were then adopted via reconciliation. These dominated P&L losses. **Fix (2026-02-25)**: Reconciliation now caps adoption at `maxPositionContracts` (default 200). Oversized api_only positions are logged and skipped, not blindly adopted.

### 7. Limit order retry caused double-buy + triple-sell cascade (2026-02-24)
**Fix**: Fill-check on cancel-404 in retry path + sell-duplicate guard via `pendingReservations`.

### 8. Swing-flipper exit logic unreachable on daily brackets (-$212 over 13 trades, 2026-02-22 to 2026-02-25)
The `checkExit()` call was nested after the time filter in `evaluate()`. For daily brackets with `minTTL=1800s`, the `continue` fired before exit evaluation once TTL < 30 min. All 4 exit conditions (TP, SL, time, oscillation collapse) were dead code for held daily positions. **Fix (2026-02-25)**: Exit evaluation moved before time filter. Time filter now only blocks new entries.

### 9. determineBracketOutcome hardcoded bracket width
Bracket width was hardcoded at 250 (midpoint +/- 125). If bracket widths change per series, settlement outcomes could be wrong. **Fix (2026-02-25)**: Now uses `getBracketInfo()` for dynamic bracket widths.

## Health Checks

When analyzing performance:

1. **Do NOT revert `edgeThreshold` to 0.25** — causes zero trading activity.
2. **Do NOT revert `maxSecondsToSettlement` to 180** — 300s is needed for evaluation.
3. **Do NOT lower `maxEdgeSanity` below 0.85** — large edges near settlement are legitimate.
4. **Do NOT lower sniper momentum below 0.40** — floor for illiquid OTM markets.
5. **DO reduce position sizing** (`maxBetPct`, `maxContracts`) if losses are too high per trade.
6. **DO verify exit logic is reachable** for all timeframes. Exit checks must run BEFORE time filters.
7. **DO verify balance and position reconciliation** is running (every ~60s in logs).
8. **DO check that CFV `forceExitSeconds` is set** — if 0 or absent, CFV rides to binary settlement.
9. **DO review sigma calibration ratio** in window summaries. Ratio should be ~1.0-1.2x. If >2x, minSigma is too high. If <0.8x, minSigma is too low.
10. **DO review entry metadata** on settlements. Journal records include `entryEdge`, `entrySigma`, `entryFairProb`, `entryMarketProb`, `entryBtcSpot`.
11. **DO check reconciliation adoption logs** for oversized positions being skipped.

## Price Feed Architecture

The system uses three exchange feeds for composite BTC pricing:
- **Coinbase** — primary feed, used as fallback when composite unavailable
- **Gemini** — secondary feed
- **Crypto.com** — secondary feed

Composite price is a volume-weighted average computed by `exchange-aggregator.js` with a 10s staleness filter. Strategies prefer composite prices with Coinbase fallback. No Kraken dependency exists in production code.

## Daily Market Support (added 2026-02-22)

- Engine fetches KXBTCD (daily BTC) markets when `"daily"` is in config timeframes
- **Swing Flipper**: `TIME_SCALES` map widens time windows and lookback for daily markets (minTTL 1800s, maxTTL 28800s, oscLookback 60, collapseLookback 30)
- **Settlement Sniper**: Skips daily markets entirely — Black-Scholes with sigma=0.20 and T=14400s still pushes probabilities toward 0.50
- **Other strategies**: Not timeframe-aware; daily markets fall outside their TTL windows naturally
