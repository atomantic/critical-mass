# UpDown validation and code inventory

## Reproduce without production writes

```sh
node scripts/validate-updown.js /absolute/path/to/candles.json 0.15 1 > /tmp/updown-report.json
```

Arguments are input file, USD fee per contract **per side**, adverse slippage in basis points, optional warmup minutes (default 10080), and optional fold count (default 3). The input is an array or `{candles: [...]}` of timestamp/open/high/low/close/volume rows. Timestamps are minute bucket starts. The script reads only that file, has no adapter imports or credential access, and writes only stdout. Store output outside live data. Costs are explicit assumptions, not a quoted broker fee schedule.

It fails on gaps, duplicates, unordered timestamps, nonfinite/malformed OHLCV, or insufficient rows. It does not silently repair data. Partial higher-timeframe buckets are discarded. Each signal sees only completed candles; its earliest fill is the following minute open. Replay has an instance clock, not a process-wide Date.now replacement. Each evaluation starts flat and liquidates at the final close with costs. Dollar drawdown includes unrealized P&L and fees at minute closes. No account-equity percentage, Sharpe ratio or leveraged return is invented.

The initial post-warmup block trains the fixed threshold candidates 0/20/30; each subsequent disjoint block tests the choice made on all earlier blocks. Threshold 0 is the published baseline. Higher thresholds suppress weak BUY calls (including closing if already long). This is a policy experiment, not a live engine setting. Ties favor baseline. Signal state is continuous, but trade books reset at fold boundaries. Every fold also reports baseline, one-contract buy-and-hold, and cash. Non-overlapping 15-minute direction targets report coverage, ties, accuracy and always-up accuracy on the same directional samples. SELL counts as a bearish forecast for that diagnostic, not as a simulated short.

## Limits and promotion criteria

This uses BTC spot candles as a proxy for a 0.01 BTC perpetual contract. [Coinbase specifications](https://help.coinbase.com/en/derivatives/perpetual-style-futures/contract-specifications) confirm the size; [Coinbase examples](https://help.coinbase.com/en/derivatives/perpetual-style-futures/examples) distinguish trading from funding P&L. Funding, futures basis, market closures, liquidity/latency, margin/liquidation, tick momentum and adaptive live weights are not modeled. Weekly/daily slow indicators may lack warmup; seven days cannot warm a 200-hour EMA or a long daily SMA. Minute sampling is not live five-second execution parity. Net P&L includes the stated fees and slippage only. Production paper-book rounding is retained.

Do not promote a threshold because aggregate P&L or hit rate looks good. Require independent unseen periods across bullish, bearish and choppy markets, sufficient completed trades, realistic fee/funding and execution sensitivity, stable drawdown/exposure, and prospective paper evaluation of the full live adaptive path. Repeatedly inspecting a holdout makes it development data. Directional observations can remain dependent despite disjoint horizons; these counts are not statistical confidence or calibrated probabilities. No candidate is automatically activated.

## Observed offline evidence (2026-09-05 audit)

Input SHA-256: `a7e501a23b865253361afd9ae16ea65518aabee96633a94420552e43d52d3bc7`.
20,162 contiguous minute candles, 2026-08-08 04:10 through 2026-08-22 04:11 UTC. These are historical cached data, not current live results. Seven days warmup; three test folds; $0.15 per contract per side and 1 bp slippage.

| Test interval (UTC) | Selected threshold | Selected net USD | Baseline net USD | Buy-and-hold net USD |
| --- | ---: | ---: | ---: | ---: |
| Aug 16 22:10 – Aug 18 16:10 | 0 | -1.21 | -1.21 | 18.45 |
| Aug 18 16:10 – Aug 20 10:10 | 20 | 34.61 | 40.91 | 70.14 |
| Aug 20 10:10 – Aug 22 04:12 | 0 | -18.22 | -18.22 | 65.26 |
| Sum of separate flat-start folds | | 15.18 | 21.48 | 153.85 |

A cost stress run at $0.30 per contract per side and 3 bp slippage produced **-$4.83 baseline / -$10.59 selected** across the same test folds, demonstrating that the apparent aggregate edge is cost-sensitive.

Baseline completed 45 trades. Two of three folds lost money. The threshold candidate underperformed baseline; baseline underperformed buy-and-hold on this rising-price sample, with very different exposure. No return-seeking coefficient changes were promoted. Directional samples numbered only 14/28/9 per fold, with 71.4%/71.4%/44.4% hit rates: insufficient evidence of a reliable edge. A second, larger cache was rejected for invalid continuity at row 12,562 rather than generating a misleading result.

## Inventory and findings

Inventory found 104 source/engine files. This was a focused behavioral audit with a full regression-suite run, not a claim that all code or exchange interactions are defect-free.

| Area | Producer/consumer path inspected | Outcome |
| --- | --- | --- |
| Market data | adapters → candle aggregator → completed timeframe replay | New strict offline input checks and complete-bucket aggregation; live market feed untouched |
| Predictor | indicators/divergence/pivots → signal engine → gates/stability → service | Fixed expired expiry becoming Infinity; added isolated replay clock; no speculative weight tuning |
| Paper execution | signal actions → perp book → service/scorecard | Invalid close previously erased lots; now preserves all state for a valid retry |
| Existing backtest | cached candles → baseline simulation → stats/output | Fixed warmup-only evaluation and backdated fill timestamps; replaced invalid percentage drawdown with `maxDrawdownUsd` (JSON field change) |
| Evaluation | scorecard outcomes → adaptive weights/by-hour metrics → engine | Live adaptive loop remains outside baseline harness; outcome accuracy is not proof of net profitability |
| Active DCA | adapter cancellation → partial fill ingestion → body resizing/tracking | Unconfirmed partial-sell cancellation result is ignored; tracked separately as [issue #316](https://github.com/atomantic/critical-mass/issues/316), no live order mutation in this audit |
| Runtime | PM2 gateway and three exchange engines plus UI | All five online at initial inspection; data/configuration files not modified |

The older `backtest-updown.js` remains a zero-cost, same-close diagnostic; use the new validator for execution-cost comparisons. The active DCA finding needs terminal-status reconciliation and polling/WS/restart race fixtures before rollout. No production orders, balances, grants or state files are edited by this work.
