# Auto-Aggressiveness via Long-Term Bias

Goal: extend the bot's lookback beyond the current ~20-day macro window so it can scale aggressiveness to long-term position-in-range, instead of being structurally blind to multi-month/yearly cycles. Couples aggressiveness sizing to multi-year position-in-range so the bot leans heavier when an asset is depressed — rolled out in three phases to avoid the "max-buy all the way to zero" failure mode.

## Signal design (decided)

- **Percentile-of-range (60% weight)** over trailing 365–730d daily closes — robust to trend, doesn't chase price down like an MA does
- **Drawdown from trailing 365d high (30% weight)** — intuitive cap at 0%, naturally bounded
- **Z-score vs 200d mean (10% weight)** — statistical sanity check
- Output: a single continuous "depression score" 0–1 plus component breakdown
- Lives inside `src/macro-regime.js` as a new field on `getState()` — feeds existing dashboard plumbing for free

**Why not 200d MA distance:** the MA descends with price in sustained downtrends, so "10% below 200d MA" is steady-state for months. CRO has lived under its 200d MA for most of its history.

**Why not preset switching:** the four aggressiveness presets are a UX abstraction for humans. Internally, auto mode should output a smooth scalar that multiplies `baseSize` and `cautionScale` — no whiplash on threshold crossings.

## Phase 1 — Observe-only (shipped)

- Multi-year daily candle fetcher with on-disk cache (no refetch on restart, daily refresh)
- `computeDepressionScore()` exposed on macro state
- Dashboard "Long-Term Bias" panel showing the score, component breakdown, and a `Suggested: <level>` badge
- Config keys: `autoAggressivenessEnabled` (default false), `longTermLookbackDays` (default 365), `longTermUpdateIntervalMs` (default 1h)
- Zero impact on sizing — purely advisory
- **Risks to watch:** signal correlation across assets (does it agree with what you'd manually pick?), candle-fetch reliability (Gemini caps at ~500 candles, no pagination), restart behavior (cache must survive PM2 restarts cleanly)

## Phase 2 — Advisory (in progress)

- Shipped: one-click "Apply suggested aggressiveness" button on the panel — user stays in the loop
- Remaining: divergence toast and optional Telegram alert — [#1677](https://github.com/atomantic/critical-mass/issues/1677)

## Phase 3 — Auto (gated on Phase 2 confidence)

Tracked in [#1678](https://github.com/atomantic/critical-mass/issues/1678).

- `autoAggressivenessEnabled: true` — bot multiplies sizing/scales by the depression-score curve
- **Capital governor (mandatory before flipping on):** dampen aggression as a function of `(deployed capital) / (total capital)` so the bot can't max-buy into a death spiral
- Initial deployment: cap auto-multiplier range narrowly (0.5x–1.5x of moderate baseline), widen as trust grows
- **Open question:** market-backdrop co-signal (BTC/ETH percentile) to distinguish broad-market lows from idiosyncratic decline. Cheap to add, valuable signal — defer unless Phase 1 shows the per-asset signal is too noisy.
