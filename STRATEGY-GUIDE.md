# Kalshi Strategy Guide

This document serves as the authoritative reference for strategy configuration, known failure modes, and the rationale behind current settings. **Any automated system modifying config MUST consult this guide before making changes.**

## Golden Rules

1. **Kelly sizing is upstream, liquidity sizing is downstream.** Kelly computes the DESIRED contract count. `live-execution-service.js` then caps it to available orderbook liquidity via `availableContracts()`. Never remove or bypass the liquidity-aware sizing — it prevents orders that can't fill.

2. **The edge sanity cap prevents bugs, not large edges.** Near settlement (30-60s), legitimate edges of 60-80% are common on stale-priced brackets. The cap (`maxEdgeSanity`) should be 0.85, not lower. Setting it to 0.50 blocks the ONLY profitable signals the bot finds.

3. **The market is efficiently priced most of the time.** Near-money brackets track fair value within 1-3%. Profitable opportunities only appear when market makers leave stale prices on OTM brackets near settlement. Raising thresholds to "be safer" often means zero trades, not fewer losses.

4. **Binary bracket markets are all-or-nothing.** Positions settle at $0 or $1. Risk control comes from POSITION SIZING (small bets), not from entry threshold tuning. A 25% edge threshold with $50 bets is riskier than a 15% threshold with $10 bets.

## Current Strategy Configuration (as of 2026-02-17)

### Settlement Sniper (LIVE)
- **What it does**: Uses Black-Scholes-style probability model to find mispriced brackets 2-5 min before settlement
- **Edge threshold**: 0.18 (18%)
- **Momentum requirement**: 0.40 (40%) — lowered from 0.60 which blocked all signals on illiquid OTM markets
- **Settlement ride**: DISABLED (threshold 1.0) — rides to settlement caused 100% losses when model was wrong
- **Position sizing**: kellyFraction 0.12, maxBetPct 0.03, maxContracts 100

### Coinbase Fair Value (LIVE)
- **What it does**: Compares Coinbase spot price to Kalshi bracket strike, trades when divergence exceeds threshold
- **Edge threshold**: 0.15 (15%) — see "Why 0.15, not 0.25" below
- **Max seconds to settlement**: 300 (5 min) — see "Why 300s, not 180s" below
- **Time scaling**: Capped at 1.3x (effective max threshold: 19.5% at 300s TTL)
- **Position sizing**: kellyFraction 0.15, maxBetPct 0.03, maxContracts 100

### Gamma Scalper (LIVE)
- **What it does**: Buys cheap OTM brackets (5-15c) with asymmetric 12:1 payoff when spot trends toward strike
- **Edge threshold**: 0.08 (8%)
- **Position sizing**: maxBetPct 0.02, maxContracts 50, maxPositions 3
- **Note**: Lowest risk per trade (~$4) with highest potential return. Should evaluate BEFORE higher-risk strategies.

### Swing Flipper (SHADOW — new)
- **What it does**: Rides intra-window oscillation on ATM brackets (30-60¢). Buys pullbacks (8¢ below recent peak) and sells recoveries for 8¢ flips. Never holds to settlement.
- **Key insight**: ATM contracts MUST oscillate as BTC spot moves around the bracket boundary. We don't predict settlement — we scalp the swings.
- **Oscillation requirement**: Contract must show 12¢+ range in last 15 snapshots (proves it's swinging)
- **Spot confirmation**: Coinbase spot must be (a) near the bracket boundary and (b) moving toward it
- **Exit conditions**: Take profit at +8¢, stop loss at -6¢, time exit at 90s to settlement, oscillation collapse at <6¢ range
- **Position sizing**: maxBetPct 0.02, maxContracts 30, maxPositions 2
- **Status**: Shadow mode — needs real oscillation data before going live
- **Do NOT change**: `takeProfitCents` to >10 (greed kills), `stopLossCents` to >8 (must cut fast), `minOscillationRange` to <10 (need proven swings)

### Momentum Rider (SHADOW ONLY)
- **What it does**: Rides Kalshi price momentum with Coinbase spot confirmation
- **Status**: Shadow mode — needs more data before going live
- **Shadow result so far**: 1 trade, 1 win, +$46

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

## Known Failure Modes (Documented 2026-02-17)

### 1. Cross-bracket double-entry (-$96 loss)
Two strategies entered the same settlement window on adjacent brackets with opposing views — both lost. The engine's window conflict check existed but relied on in-memory `pendingReservations` which are lost on restart. **Fix**: The conflict check now also scans `state.trades` for recent buy trades in the same settlement window, surviving restarts.

### 2. Reconciliation always assumed loss (-$106 loss)
When the engine found positions it lost track of (`engine_only` discrepancies), it hardcoded `price: 0` (full loss) regardless of actual outcome. Positions that actually won were still recorded as losses. **Fix**: Reconciliation now uses `determineBracketOutcome()` with current BTC spot to determine the correct win/loss outcome before recording.

### 3. Momentum-rider pre-settlement exits are the only consistently profitable pattern
The shadow momentum-rider strategy (1 trade, 1 win, +$46) exits before settlement, avoiding the binary all-or-nothing risk. Settlement-riding strategies (sniper, CFV) have a 0% win rate on 3 live trades. Until model accuracy improves, pre-settlement exit strategies should be prioritized.

## Health Checks

When analyzing performance:

1. **Do NOT revert `edgeThreshold` to 0.25** — this causes zero trading activity. If trades are losing, reduce `maxBetPct` or `maxContracts` instead.
2. **Do NOT revert `maxSecondsToSettlement` to 180** — 300s gives the strategy time to evaluate. The evaluation window doesn't cause losses; position sizing does.
3. **Do NOT lower `maxEdgeSanity` below 0.85** — large edges near settlement are legitimate, not bugs.
4. **Do NOT lower sniper momentum below 0.40** — already at the floor for illiquid OTM markets.
5. **DO reduce position sizing** (`maxBetPct`, `maxContracts`) if losses are too high per trade.
6. **DO check if gamma-scalper is being crowded out** by higher-risk strategies claiming windows first.
7. **DO verify balance and position reconciliation** is running (every ~60s in logs).
