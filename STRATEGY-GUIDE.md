# Kalshi Strategy Guide

This document serves as the authoritative reference for strategy configuration, known failure modes, and the rationale behind current settings. **Any automated system modifying config MUST consult this guide before making changes.**

## Golden Rules

1. **Kelly sizing is upstream, liquidity sizing is downstream.** Kelly computes the DESIRED contract count. `live-execution-service.js` then caps it to available orderbook liquidity via `availableContracts()`. Never remove or bypass the liquidity-aware sizing — it prevents orders that can't fill.

2. **The edge sanity cap prevents bugs, not large edges.** Near settlement (30-60s), legitimate edges of 60-80% are common on stale-priced brackets. The cap (`maxEdgeSanity`) should be 0.85, not lower. Setting it to 0.50 blocks the ONLY profitable signals the bot finds.

3. **The market is efficiently priced most of the time.** Near-money brackets track fair value within 1-3%. Profitable opportunities only appear when market makers leave stale prices on OTM brackets near settlement. Raising thresholds to "be safer" often means zero trades, not fewer losses.

4. **Binary bracket markets are all-or-nothing.** Positions settle at $0 or $1. Risk control comes from POSITION SIZING (small bets), not from entry threshold tuning. A 25% edge threshold with $50 bets is riskier than a 15% threshold with $10 bets.

## Current Strategy Configuration (as of 2026-02-18)

### Settlement Sniper (LIVE)
- **What it does**: Uses Black-Scholes-style probability model to find mispriced brackets 2-5 min before settlement
- **Edge threshold**: 0.15 (15%) — reduced from 0.18 on 2026-02-19 (see "Why 0.15 for Sniper" below)
- **Momentum requirement**: 0.40 (40%) — lowered from 0.60 which blocked all signals on illiquid OTM markets
- **Settlement ride**: DISABLED (threshold 1.0) — rides to settlement caused 100% losses when model was wrong
- **Position sizing**: kellyFraction 0.12, maxBetPct 0.03, maxContracts 100

### Coinbase Fair Value (LIVE — minEntryPrice lowered 2026-02-18)
- **What it does**: Compares Coinbase spot price to Kalshi bracket strike, trades when divergence exceeds threshold
- **Min entry price**: 8c (lowered from 15c on 2026-02-18 — see "Why minEntryPrice 8 not 15" below)
- **Edge threshold**: 0.15 (15%) — see "Why 0.15, not 0.25" below
- **Max seconds to settlement**: 300 (5 min) — see "Why 300s, not 180s" below
- **Time scaling**: Capped at 1.3x (effective max threshold: 19.5% at 300s TTL)
- **Force exit**: 60s before settlement (avoids binary risk; see failure mode #5)
- **Position sizing**: kellyFraction 0.15, maxBetPct 0.03, maxContracts 100

### Gamma Scalper (SHADOW — disabled 2026-02-19)
- **What it does**: Buys cheap OTM brackets (5-15c) with asymmetric 12:1 payoff when spot trends toward strike
- **Edge threshold**: 0.08 (8%)
- **Position sizing**: maxBetPct 0.02, maxContracts 50, maxPositions 3
- **Status**: Disabled — 10% dry-run win rate, and 100% of live signals blocked by slippage guard (95¢ fills on 5-9¢ limits). OTM brackets have no resting liquidity. Re-enable when Kalshi OTM liquidity improves.
- **Note**: Still evaluates first in shadow mode. Lowest risk per trade (~$4).

### Swing Flipper (LIVE — promoted 2026-02-19, widened 2026-02-18)
- **What it does**: Rides intra-window oscillation on ATM brackets (25-65¢). Buys pullbacks (8¢ below recent peak) and sells recoveries for 8¢ flips. Never holds to settlement.
- **Key insight**: ATM contracts MUST oscillate as BTC spot moves around the bracket boundary. We don't predict settlement — we scalp the swings.
- **ATM range**: 25-65c (widened from 30-60c on 2026-02-18 to catch brackets transitioning into/out of ATM range)
- **Oscillation requirement**: Contract must show 10¢+ range in last 15 snapshots (reduced from 12¢ on 2026-02-18 — 10¢ range is still meaningful, and the wider range lets thinner patterns through)
- **Spot confirmation**: Coinbase spot must be (a) near the bracket boundary and (b) moving toward it
- **Exit conditions**: Take profit at +8¢, stop loss at -6¢, time exit at 90s to settlement, oscillation collapse at <6¢ range
- **Position sizing**: maxBetPct 0.01, maxContracts 15, maxPositions 1 (conservative initial live sizing)
- **Status**: Live with reduced sizing — promoted from shadow after observing profitable ATM oscillation trades (+$1.90 on B66625 flip)
- **Do NOT change**: `takeProfitCents` to >10 (greed kills), `stopLossCents` to >8 (must cut fast), `minOscillationRange` to <8 (need proven swings)

### Momentum Rider (LIVE — ATM tuned 2026-02-18)
- **What it does**: Rides Kalshi price momentum with Coinbase spot confirmation
- **Entry range**: 45-70c (lowered from 65-80c on 2026-02-18 — see "Why entryThreshold 45 not 65" below)
- **Stop loss**: 10c (added 2026-02-18 — ride-to-settlement at ATM prices is too risky without a stop)
- **Profit target**: 10c (reduced from 15c — 10c on a 50c entry = 20% return)
- **minTrendTicks**: 5 (increased from 3 on 2026-02-19 — 3 ticks produced too much noise, 20.4% dry-run WR with -$83 P&L)
- **Status**: Live — promoted based on 2/2 wins (+$46 shadow, +$3.49 live)
- **Safety exit**: 45s before settlement (code-level, always active)
- **Result so far**: 2 trades, 2 wins, +$49.49 total

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

### Momentum Rider entryThreshold: 45 not 65
- **Problem at 65**: ATM brackets price at 40-55c — the YES-side where real liquidity exists. The 65c threshold blocked every ATM entry, forcing the strategy to only target 65-80c brackets that are already directionally committed.
- **Why 45**: Conviction tracker data (281 settled brackets) shows 85% accuracy at the 65c threshold. ATM prices (40-55c) have real YES-side orderbook depth (unlike NO-side OTM brackets). At 50c, the fee is only 2c per contract (breakeven at 51% accuracy). Adding a 10c stop loss manages risk at these symmetric payoff prices — room for normal oscillation while cutting real reversals.
- **Existing safeguards**: 5 consecutive tick trend requirement, Coinbase spot momentum confirmation (0.05% in 60s), fair value premium guard (15c max), 45s safety exit before settlement, maxBetPct 0.02, maxContracts 50.

### CFV minEntryPrice: 8 not 15
- **Problem at 15**: B66875 YES had a 90% edge at 9c — blocked by the 15c floor. The bracket was the eventual winner.
- **Why 8**: YES-side asks at 8-9c are real market maker orders (bid=4, ask=8). This is different from the gamma scalper's NO-side problem where OTM brackets have zero resting liquidity. The code default was 10; the config was even more conservative at 15.
- **Why not lower**: Below 8c, spread width (bid-ask gap) makes fills unreliable and slippage guard will likely block.

### Swing Flipper range: 25-65c not 30-60c
- **Problem at 30-60**: Tonight swing-flipper rejected all brackets (0/3 shadow record). Brackets transitioning into or out of ATM range at 25-30c and 60-65c were excluded.
- **Why 25-65**: Catches brackets in their full ATM lifecycle. Combined with reducing minOscillationRange from 12c to 10c, lets thinner but still meaningful oscillation patterns qualify.

### Sniper Momentum: 0.40 not 0.60
- **Problem at 0.60**: OTM bracket markets are illiquid with choppy price movement. Momentum rarely exceeds 40-50%, blocking every sniper signal.
- **Why 0.40**: Allows signals through while still requiring SOME directional confirmation.

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
**Result**: 3 of 4 CFV settlement-rides went to $0 (-$148 total). The edge model identified opportunities correctly (1 of 4 won +$241), but a 25% win rate on settlement rides means negative EV at typical position sizes. Fixed by adding `forceExitSeconds: 60` that converts binary settlement risk into known P&L at 60s before close.

### 9. Evaluating high-risk strategies before low-risk ones (Feb 16-18)
**Result**: Settlement-sniper and CFV evaluated first, claiming settlement windows via the one-position-per-window rule. Gamma-scalper (shadow: +$46 on $4 bet) and momentum-rider (live: +$3.49) never got window access. Fixed by reordering eval: gamma-scalper first, momentum-rider second.

### 10. Gamma scalper live: 100% slippage-blocked (Feb 18-19)
**Result**: Gamma scalper generated signals every 5 seconds targeting OTM NO contracts at 5-9¢, but every single one was blocked by the slippage guard (estimated fill 95¢ vs limit 7¢ + 3¢ max slippage). OTM brackets on Kalshi have no resting limit orders at the NO side — the only available liquidity is the YES ask at 95-96¢. Dry-run: 10% WR, -$15.37 P&L. Disabled on 2026-02-19, demoted to shadow mode.

### 11. Momentum rider noise at minTrendTicks=3 (Feb 18-19)
**Result**: 98 dry-run trades (highest volume by far) but only 20.4% WR, -$83.35 P&L. With only 3 consecutive tick confirmation required, normal market noise frequently triggers false signals. Increased to 5 on 2026-02-19 to reduce noise.

### 12. Settlement sniper at edgeThreshold=0.18 (Feb 18-19)
**Result**: In 34 dry-run trades, edges consistently fell in the 12-15% range — just below the 18% threshold. Best edges found per window were typically 10-15%, meaning the threshold blocked signals that the model identified as profitable. Reduced to 0.15 on 2026-02-19 to align with data. Note: Golden Rule #4 still applies — risk is managed via position sizing (maxBetPct 0.03), not threshold tuning.

## Strategy Evaluation Order (as of 2026-02-19)

Strategies are evaluated in this order. Within each settlement window, only one position is allowed — so evaluation order determines which strategy gets priority.

1. **Gamma Scalper** — lowest risk per trade (~$4), exits before settlement
2. **Momentum Rider** — pre-settlement exit via profit target + safety exit at 45s
3. **Swing Flipper** — pre-settlement exit via take-profit/stop-loss
4. **Coinbase Fair Value** — forced exit at 60s before settlement
5. **Settlement Sniper** — settlement-riding (highest risk, disabled ride = exits at 60s)

**Rationale**: Pre-settlement-exit strategies should evaluate first because they have demonstrated positive returns (momentum-rider: +$49.49, gamma-scalper shadow: +$46) while settlement-riding strategies have a 0% win rate on 4 live settlement rides.

## Risk Controls (Do NOT Weaken)

| Control | Setting | Purpose |
|---------|---------|---------|
| `maxEdgeSanity` | 0.85 | Block signals with edges > 85% (likely data errors) |
| `maxDailyLoss` | $500 | Circuit breaker halts all trading |
| `maxExposurePerWindow` | $75 | Cap total risk per settlement event |
| `maxBetPct` | 0.03 | Max 3% of bankroll per trade |
| `maxContracts` | 100 | Hard cap on contract count |
| `maxTradesPerHour` | 10 | Rate limit to prevent runaway trading |
| `maxOpenPositions` | 20 | Limit concurrent exposure |
| Cross-position conflict | Code | Only 1 position per settlement window |
| Liquidity-aware sizing | Code | Orders capped to available orderbook depth |

## Known Failure Modes (Updated 2026-02-18)

### 1. Cross-bracket double-entry (-$96 loss)
Two strategies entered the same settlement window on adjacent brackets with opposing views — both lost. The engine's window conflict check existed but relied on in-memory `pendingReservations` which are lost on restart. **Fix**: The conflict check now also scans `state.trades` for recent buy trades in the same settlement window, surviving restarts.

### 2. Reconciliation always assumed loss (-$106 loss)
When the engine found positions it lost track of (`engine_only` discrepancies), it hardcoded `price: 0` (full loss) regardless of actual outcome. Positions that actually won were still recorded as losses. **Fix**: Reconciliation now uses `determineBracketOutcome()` with current BTC spot to determine the correct win/loss outcome before recording.

### 3. Momentum-rider pre-settlement exits are the only consistently profitable pattern
The momentum-rider strategy (2 trades, 2 wins: +$46 shadow, +$3.49 live) exits before settlement via profit target, avoiding binary all-or-nothing risk. Settlement-riding strategies (sniper, CFV) have a 0% win rate on 4 live settlement-rides. **Fix (2026-02-18)**: Added 45s safety exit to momentum-rider and 60s forced pre-settlement exit to CFV.

### 4. Strategy evaluation order let high-risk strategies crowd out low-risk ones
Strategies evaluated in config order: sniper first, CFV second. Both claimed settlement windows before gamma-scalper or momentum-rider could evaluate. Gamma-scalper (shadow: 1 trade, 1 win, +$46 on a $4 bet) never got a chance at live windows. **Fix (2026-02-18)**: Strategy evaluation reordered: gamma-scalper → momentum-rider → swing-flipper → CFV → sniper. Lower-risk pre-settlement-exit strategies now evaluate first.

### 5. CFV held positions to binary settlement (-$148 over 3 trades)
CFV had no forced pre-settlement exit — it relied on edge-reversal or take-profit exits, which often didn't trigger before settlement. Result: 3 of 4 CFV trades rode to $0 at settlement. **Fix (2026-02-18)**: Added `forceExitSeconds` param (default 60s) that forces exit before settlement window closes, converting binary risk into a known P&L.

### 6. Reconciled positions are a persistent P&L leak (-$106 over 2 trades)
Positions from 15min markets (KXBTC15M) appeared as API-only during reconciliation. These likely originated from previous engine runs or manual orders. Both settled at $0. The engine has no control over these positions since it didn't create them. Monitor reconciliation logs for recurring `api_only` discrepancies.

## Health Checks

When analyzing performance:

1. **Do NOT revert `edgeThreshold` to 0.25** — this causes zero trading activity. If trades are losing, reduce `maxBetPct` or `maxContracts` instead.
2. **Do NOT revert `maxSecondsToSettlement` to 180** — 300s gives the strategy time to evaluate. The evaluation window doesn't cause losses; position sizing does.
3. **Do NOT lower `maxEdgeSanity` below 0.85** — large edges near settlement are legitimate, not bugs.
4. **Do NOT lower sniper momentum below 0.40** — already at the floor for illiquid OTM markets.
5. **DO reduce position sizing** (`maxBetPct`, `maxContracts`) if losses are too high per trade.
6. **DO check if gamma-scalper is being crowded out** by higher-risk strategies claiming windows first. (Fixed in eval order 2026-02-18.)
7. **DO verify balance and position reconciliation** is running (every ~60s in logs).
8. **DO check that CFV `forceExitSeconds` is set** — if 0 or absent, CFV will ride to binary settlement (historically 0% win rate on settlement rides).
9. **DO review sigma calibration** in window summaries. If ratio (predicted/realized) is consistently >2 or <0.5, the vol model is miscalibrated. Check `sigmaCalibration` in journal window-summary entries.
10. **DO review entry metadata** on settlements. Journal settlement records now include `entryEdge`, `entrySigma`, `entryFairProb`, `entryMarketProb`, and `entryBtcSpot` for post-trade calibration analysis.
