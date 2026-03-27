# UpDown Strategy Evaluation

**Date**: 2026-03-06
**Scope**: Signal engine, indicators, scoring, modulation

## Executive Summary

The UpDown signal engine is a well-engineered trend-following momentum system with 7 indicators, 11 timeframes, and 12+ modulation layers. After a thorough code review, I've identified several gaps and improvement opportunities that could meaningfully improve prediction accuracy and signal quality.

## Current Architecture Strengths

- **Adaptive weights** via scorecard feedback loop — indicators that underperform get downweighted automatically
- **Multi-timeframe consensus** across 11 timeframes with weighted composite
- **Trend-aware scoring** — each indicator adjusts behavior based on bullish/bearish/neutral regime
- **Extensive modulation** — divergence, pivot dampening, volume surge, ADX regime, confluence filter, time-of-day weighting
- **Comprehensive backtesting** infrastructure with per-indicator and per-timeframe accuracy tracking

## Identified Gaps & Recommendations

### 1. Missing: Multi-Exchange Order Book Imbalance Signal

**Gap**: The system uses Coinbase tick data for price/volume but ignores order book depth data despite having orderbook data available.

**Why it matters**: Order book imbalance (bid volume vs ask volume at top levels) is one of the strongest short-term directional predictors for BTC. A 3:1 bid/ask ratio at the top 5 levels is a strong bullish signal that precedes price moves by seconds to minutes — exactly the timeframe the UpDown engine operates on.

**Recommendation**: Add an `orderBookImbalance` indicator to the signal engine that:
- Polls Coinbase BTC-USD order book top 10 levels every 5s
- Computes bid/ask volume ratio
- Scores: ratio > 2.0 = bullish (+50), ratio < 0.5 = bearish (-50), linear interpolation between
- Weight: ~0.10, reducing VWAP or Bollinger proportionally

### 2. Missing: Funding Rate / Perpetual Premium Signal

**Gap**: BTC perpetual futures funding rates are a well-known sentiment indicator not currently used.

**Why it matters**: Extreme positive funding rates (>0.05%) indicate overleveraged longs and often precede short-term corrections. Extreme negative funding rates indicate overleveraged shorts and precede bounces. This is a counter-trend signal that complements the momentum indicators.

**Recommendation**: Fetch funding rate from a public API (e.g., Binance or Bybit perpetuals) every 8 hours and use as a regime filter:
- Funding > 0.05%: dampen bullish scores by 10-15% (overcrowded long)
- Funding < -0.03%: dampen bearish scores by 10-15% (overcrowded short)
- This is lightweight — doesn't need a new indicator weight, just a modulation multiplier like pivot dampening

### 3. Gap: Divergence Detection Only Uses RSI

**Current**: `divergence.js` only detects price/RSI divergence.

**Why it matters**: MACD histogram divergence and OBV divergence are equally powerful (sometimes more reliable) divergence signals. The system already computes MACD and OBV per timeframe but doesn't check for divergence between price and these indicators.

**Recommendation**: Extend `detectDivergence()` to accept any oscillator series, not just RSI. Then check for:
- Price/MACD histogram divergence
- Price/OBV divergence
- When 2+ divergence types agree, increase the divergence strength multiplier

### 4. Gap: No Volatility Regime Transition Detection

**Current**: ADX regime is binary (trending >25 / ranging <20) and volatility context is a static ATR ratio.

**Why it matters**: The *transition* from ranging to trending (ADX crossing 20→25) or from low-vol to high-vol (ATR ratio spiking) is more predictive than the absolute level. Breakouts from ranging into trending regimes produce the strongest trend-following signals.

**Recommendation**: Track ADX and ATR ratio over a rolling window (e.g., last 5 readings). When ADX is *increasing* from below 20 to above 20, apply a +20% boost to trend-aligned signals (regime transition bonus). When ATR ratio spikes >1.5x in a single period, it signals a volatility expansion — boost signals aligned with the initial move direction.

### 5. Gap: Stochastic Only Uses Standard (14,3) Settings

**Current**: Single Stochastic calculation with default 14-period %K, 3-period %D.

**Why it matters**: Different timeframes benefit from different Stochastic periods. The standard (14,3) is optimized for daily charts but is noisy on 1m/3m candles and slow on 1h/4h candles.

**Recommendation**: Use timeframe-appropriate Stochastic periods:
- 1m-5m: (5, 3) — faster for short-term momentum
- 15m-1h: (14, 3) — standard
- 4h-1w: (21, 5) — slower for macro trends

This is a low-effort change — just pass different parameters to `calculateStochastic()` based on the timeframe in `computeTimeframeSignals()`.

### 6. Gap: No Bollinger Band Squeeze Detection

**Current**: Bollinger scoring only looks at %B (where price is relative to bands).

**Why it matters**: Bollinger Band squeeze (bandwidth narrowing to multi-period lows) is one of the most reliable volatility breakout predictors. When bandwidth contracts to <50% of its 50-period average, a large move is imminent. The direction of the breakout (first candle outside the bands after squeeze) is highly predictive.

**Recommendation**: Add squeeze detection to `scoreBollinger()`:
- Track Bollinger bandwidth over a rolling window
- When current bandwidth < 50% of average bandwidth: "squeeze active"
- When %B breaks above 1.0 during squeeze: strong bullish signal (+80)
- When %B breaks below 0.0 during squeeze: strong bearish signal (-80)
- Squeeze breakouts should bypass the normal trend-bias dampening since they represent regime changes

### 7. Gap: Score Compression Threshold May Be Too Aggressive

**Current**: Linear compression at 50% rate above score ±50, creating a soft ceiling around ±70.

**Why it matters**: The signal thresholds are STRONG_BUY >30, BUY >15. With compression starting at ±50, the dynamic range for distinguishing STRONG_BUY confidence levels is only 50-70 (20 points). Meanwhile, the useful BUY range is 15-30 (15 points). The compression may be reducing the information content of high-conviction signals.

**Recommendation**: Consider raising the compression threshold from 50 to 60, and reducing compression rate from 50% to 40%. This widens the STRONG_BUY dynamic range without removing the necessary ceiling protection. Test via backtest to verify this doesn't increase false STRONG_BUY signals.

### 8. Gap: Confluence Filter May Be Counter-Productive

**Current**: When 8+ of 11 timeframes agree, the score is dampened by 15%.

**Why it matters**: The rationale (overcrowded signals perform worse) needs validation against actual scorecard data. In trending markets, strong trends *should* have near-unanimous timeframe agreement. Dampening these signals reduces conviction on the highest-quality trend-following setups.

**Recommendation**:
- Review scorecard data to validate whether 8+ timeframe agreement actually correlates with worse outcomes
- If not validated, remove the confluence dampener
- If validated, consider making it ADX-aware: only dampen in ranging markets (ADX < 20), not in strong trends (ADX > 25)

### 9. Gap: No Cross-Exchange Price Divergence Signal

**Current**: Uses Coinbase BTC-USDC as the sole price source for signal generation, despite having Gemini and Crypto.com feeds available.

**Why it matters**: When BTC price on one exchange deviates significantly from others (>0.1%), it often indicates pending arbitrage-driven price movement toward the consensus. If Coinbase lags Gemini+Crypto.com, a catch-up move is likely.

**Recommendation**: Use the existing `exchange-aggregator.js` composite price vs Coinbase spot to detect divergence:
- Composite > Coinbase by >0.1%: bullish bias (Coinbase likely to catch up)
- Composite < Coinbase by >0.1%: bearish bias (Coinbase likely to correct)
- Apply as a lightweight modulation multiplier (±5-10%)

### 10. Backtest Limitation: No Scorecard/Adaptive Weights in Backtest

**Current**: `backtest-updown.js` passes `null` for scorecardMetrics, so adaptive weights and time-of-day weighting are never exercised during backtesting.

**Why it matters**: The live system uses scorecard-driven adaptive weights and ToD weighting, but the backtest doesn't simulate these. This means backtest results may not reflect live performance, and improvements to the adaptive weight system can't be validated.

**Recommendation**: Add a lightweight scorecard simulator to the backtest that:
- Tracks per-indicator accuracy during the simulation
- Recomputes adaptive weights every N candles (e.g., every 100)
- Feeds weights back to the signal engine mid-simulation
- This would make backtest results more representative of live behavior

## Priority Ranking

| # | Recommendation | Impact | Effort | Priority |
|---|---------------|--------|--------|----------|
| 1 | Order book imbalance signal | High | Medium | P1 |
| 6 | Bollinger squeeze detection | High | Low | P1 |
| 4 | Volatility regime transitions | Medium-High | Low | P1 |
| 5 | Timeframe-specific Stochastic | Medium | Low | P2 |
| 3 | Multi-indicator divergence | Medium | Low | P2 |
| 10 | Backtest with adaptive weights | Medium | Medium | P2 |
| 8 | Validate confluence filter | Medium | Low | P2 |
| 9 | Cross-exchange divergence | Low-Medium | Low | P3 |
| 2 | Funding rate signal | Low-Medium | Medium | P3 |
| 7 | Score compression tuning | Low | Low | P3 |

## Implementation Notes

- All recommendations preserve existing architecture patterns (modular indicators, weighted scoring, modulation multipliers)
- P1 items can be implemented independently and validated via the existing backtest infrastructure
- Improvements flow through the existing composite score
- The scorecard will automatically track accuracy of new indicators/changes via the adaptive weight system
