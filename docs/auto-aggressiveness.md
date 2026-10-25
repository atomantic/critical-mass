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

## Phase 2 — Advisory (shipped)

- Shipped: one-click "Apply suggested aggressiveness" button on the panel — user stays in the loop
- Sustained divergence toast: one advisory per stable current/suggested preset pair, scoped to exchange and fund. A suggestion must differ by at least one level for `aggressivenessSuggestionHours` (default **6**, range **0.01–720** hours), configurable in each fund's regime config through the config editor/API.
- Optional Telegram alert: enable **Notifications → Aggressiveness Suggestions (advisory)**. Off by default, using the existing notifier queue, quiet hours and Telegram channel.
- Timing uses server observations, so the browser need not stay open. Flapping, missing observations, custom sizing, operator config changes and engine restarts reset the dwell period. Alerts occur on the first macro refresh after the threshold; dashboard toasts are deduplicated for the browser session. Enabling Telegram after an advisory has already fired waits for the next sustained suggestion.
- All alerts are advisory only; sizing changes still require the operator's Apply action.

## Phase 3 — Auto (shipped, off by default)

Tracked in [#1678](https://github.com/atomantic/critical-mass/issues/1678). Gated on Phase 2 confidence: leave `autoAggressivenessEnabled` off until the advisories agree with what you would pick manually.

- `autoAggressivenessEnabled: true` — each entry's size is multiplied by a smooth curve over the depression score (`src/auto-aggressiveness.js`), on top of the macro-regime multiplier. No preset switching, so no whiplash at thresholds. Neutral (×1.0) while the score is not ready or macro data is stale.
- **Curve:** linear from `autoAggressivenessMinMult` (score 0, default **0.5**) to `autoAggressivenessMaxMult` (score 1, default **1.5**). Initial range is deliberately narrow; widen only as trust grows.
- **Capital governor (mandatory):** `deployed = totalCostBasis / maxUsdcDeployed`. The boost above ×1.0 fades linearly from full strength at `autoAggressivenessGovernorStart` (default **0.4**) to zero at `autoAggressivenessGovernorEnd` (default **0.9**), so the bot can't max-buy into a death spiral. The governor only removes boost; a below-neutral multiplier is never shrunk further by it. The boosted size is also capped at the remaining budget.
- **Scope:** reactive entries only (`entryMode: 'reactive'`). Ladder entries (including `ladderAutoSwitch`) place their rungs through a separate path and are not scaled; extending the multiplier and governor to ladder construction is follow-up work.
- Auto sizing also requires the newest long-term daily candle to be at most 3 days old, so a failing history refresh falls back to neutral sizing instead of acting on an old score.
- Each placed entry logs `auto=×<mult>(gov <g>)` and emits `autoSizeMult` on the `entry_placed` event.
- **Decided — deferred:** the market-backdrop co-signal (BTC/ETH percentile) is NOT part of Phase 3. Ship with the per-asset score, the capital governor and the narrow multiplier range; revisit only if Phase 1/2 data shows the per-asset signal is too noisy.
