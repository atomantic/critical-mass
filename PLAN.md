# Development Plan

For completed work, see [DONE.md](./DONE.md).

## Next Up

1. **Per-engine memory tuning** — Profile each PM2 process under load, set `max_memory_restart` per-engine in ecosystem.config.cjs (currently uniform 512M)
2. **Auto-Aggressiveness via Long-Term Bias** — Couple aggressiveness sizing to multi-year position-in-range so the bot leans heavier when an asset is depressed. Designed as a 3-phase rollout to avoid the "max-buy all the way to zero" failure mode. See [Auto-Aggressiveness Roadmap](#auto-aggressiveness-roadmap) below.
3. **Sentinel service test coverage** — Unit tests for classifier and feed-poller to catch parsing edge cases

## Backlog

- [ ] Upgrade Vite build toolchain (5.4 -> 8.x) and `@vitejs/plugin-react` (4.7 -> 6.x)
- [ ] Complete `src/paths.js` adoption — file exists but is not imported in most modules (15+ `path.join(__dirname, ...)` remain)
- [ ] Complete `src/routes/async-handler.js` adoption — file exists but is not imported in any route
- [ ] Make the gemini `makeRestRequest` 429 backoff injectable (`src/adapters/gemini/api.js:177`) like `createRestThrottle`'s `sleep`, so the 429 integration tests can use fake timers instead of ~2s of real sleep (review #194/codex finding #3 — test ergonomics only, no production bug)

## Future / Ideas

- Split `regime-engine.js` (4,095 lines) into orchestrator + specialized modules
- Split `config-utils.js` (1,012 lines) into domain-specific config services
- Extract sub-components from `RegimeDashboard.jsx` (2,983 lines)
- Extract shared base from `order-executor.js` / `dry-run-executor.js`
- Split `state-tracker.js` persistence from domain logic

## Auto-Aggressiveness Roadmap

Goal: extend the bot's lookback beyond the current ~20-day macro window so it can scale aggressiveness to long-term position-in-range, instead of being structurally blind to multi-month/yearly cycles.

**Signal design (decided):**
- **Percentile-of-range (60% weight)** over trailing 365–730d daily closes — robust to trend, doesn't chase price down like an MA does
- **Drawdown from trailing 365d high (30% weight)** — intuitive cap at 0%, naturally bounded
- **Z-score vs 200d mean (10% weight)** — statistical sanity check
- Output: a single continuous "depression score" 0–1 plus component breakdown
- Lives inside `src/macro-regime.js` as a new field on `getState()` — feeds existing dashboard plumbing for free

**Why not 200d MA distance:** the MA descends with price in sustained downtrends, so "10% below 200d MA" is steady-state for months. CRO has lived under its 200d MA for most of its history.

**Why not preset switching:** the four aggressiveness presets are a UX abstraction for humans. Internally, auto mode should output a smooth scalar that multiplies `baseSize` and `cautionScale` — no whiplash on threshold crossings.

### Phase 1 — Observe-only (current)
- [x] Multi-year daily candle fetcher with on-disk cache (no refetch on restart, daily refresh)
- [x] `computeDepressionScore()` exposed on macro state
- [x] Dashboard "Long-Term Bias" panel showing the score, component breakdown, and a `Suggested: <level>` badge
- [x] Config keys: `autoAggressivenessEnabled` (default false), `longTermLookbackDays` (default 365), `longTermUpdateIntervalMs` (default 1h)
- [x] Zero impact on sizing — purely advisory until Phase 2
- **Risks to watch in this phase:** signal correlation across assets (does it actually agree with what you'd manually pick?), candle-fetch reliability (Gemini caps at ~500 candles, no pagination), restart behavior (cache must survive PM2 restarts cleanly)

### Phase 2 — Advisory (in progress)
- [x] One-click "Apply suggested aggressiveness" button on the panel — user stays in the loop
- [ ] Toast notification when suggested level diverges from current by ≥1 step for >N hours
- [ ] Optional Telegram alert for level-change suggestions

### Phase 3 — Auto (gated on Phase 2 confidence)
- `autoAggressivenessEnabled: true` — bot multiplies sizing/scales by the depression-score curve
- **Capital governor (mandatory before flipping on):** dampen aggression as a function of `(deployed capital) / (total capital)` so the bot can't max-buy into a death spiral
- Initial deployment: cap auto-multiplier range narrowly (0.5x–1.5x of moderate baseline), widen as trust grows
- **Open question:** market-backdrop co-signal (BTC/ETH percentile) to distinguish broad-market lows from idiosyncratic decline. Cheap to add, valuable signal — defer to Phase 3 unless Phase 1 shows the per-asset signal is too noisy.

## Documentation

- [PM2 Architecture](./docs/pm2-architecture.md)
- [Fill Ledger Sell Linkage](./docs/fill-ledger-sell-linkage.md)
