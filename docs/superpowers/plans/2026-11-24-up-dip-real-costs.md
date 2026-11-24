# Up Dip Real Costs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Price the Up dip book, contract panel and backtests with the app's measured spread, on Crypto.com data, from a fresh book.

**Architecture:** One pure pricing module is used everywhere a contract is priced. A quotes store holds operator-confirmed app quotes and supplies the spread and listed floors. A dedicated candle source built on the btc-feed index feeds both books, with explicit substitute and gap rules.

**Tech Stack:** Node (CommonJS, `node:test`), React, vitest. No new dependency.

**Spec:** `docs/superpowers/specs/2026-11-23-up-dip-real-costs-design.md`

## Global Constraints

- Work in the worktree on `feat/up-dip-real-costs`. Never start a gateway or engine, use PM2, or write under the main checkout's `data/`.
- Run server tests as `npm test -- <files>`. No test opens a network connection or writes outside a temp directory.
- Nothing here may touch `src/regime-*.js`, adapters, `src/candle-cache.js`, the signal engine, scorecard, perp book, or any order path. The shadow book is never reset by default.
- Entry rules and `UP_DIP_PARAMS` values stay unchanged. $1.99 fee unchanged.
- Spread: quote fresh under 24h; else $35 a side for 2000, $0 for 500. Grid $400. Candidate floors `price - 1900` to `price - 300`.
- No spread on knock-outs or expiry. Nothing is recorded from a screenshot without the operator's click.
- New `src/` files start with `// @ts-check`; typecheck and admin lint (47 warnings) must not get worse.
- Run `/simplify` right before each commit containing non-test, non-doc code.
- Changelog: one fragment, `.changelogs/next-up-dip-real-costs.md`.

## Review Focus

1. Deployed without the reset: the old book must not trade or lose its record, and the contract panel must still advise (Task 5).
2. A quote captured in the future, or with an expiry already past, must not set the spread or the listing (Task 2).
3. A $500-range quote must never change the $2,000 spread, nor the reverse (Task 2).
4. Restart during an index outage: the same minute must not fill, knock out or count twice (Task 5).
5. Double-clicking **Record quote** must store one quote (Task 2).

## File Structure

| File | Responsibility |
|---|---|
| `src/updown/app-pricing.js` | Spread-aware contract values; pure |
| `src/updown/app-quotes.js` | Quote validation, storage, spread, listing, source comparison |
| `src/updown/up-dip-candles.js` | Index-built candles with substitutes and gaps |
| `src/updown/up-dip-paper.js` | Book: pricing, stamping, substitute/gap/knock-out rules |
| `src/updown/up-dip-held.js` | Operator contract: spread and either-source check |
| `scripts/reset-up-dip-paper.js` | Archive and reset |
| `admin/src/components/updown/AppQuoteForm.jsx` | Manual entry and Record quote |

---

### Task 1: Pricing module and rule

**Files:** Create `src/updown/app-pricing.js`; Modify `src/updown/up-dip-setup.js`; Test create `tests/updown-app-pricing.test.js`, modify `tests/updown-up-dip-setup.test.js`

**Interfaces — Produces** (`h` = BTC dollars per side):
- `buyValue(mid, contract, h)`, `sellValue(mid, contract, h)`; `entryCost(mid, contract, h, qty = 1)` = `qty * (buyValue + 1.99)`; `exitProceeds(mid, contract, h, qty = 1)` = `qty * (sellValue - 1.99)`; `effectiveHalfSpread(position, h)` = `max(position.halfSpread ?? 0, h)`. Non-finite or negative `h` throws `TypeError`.
- `markPosition(pos, price, h)` uses `effectiveHalfSpread`.
- `decideUpDip({ features, position, now, lastExitAt, params, halfSpread, pick })`: `halfSpread` is required (TypeError if not finite); `pick(price, now, params)` → contract or `null`, default the existing `pickContract`. `expected` fields and the exit test use the spread. A `null` pick on an otherwise valid ENTER returns STAND_ASIDE with reason `no listed contract seen this week`; days-to-expiry then uses `nextExpiryMs`.

- [ ] **Step 1: Write failing tests**
  - contract 60200-62200, mid 61118.69, h 53.31: `buyValue` 486.00; contract 59400-61400, mid 61138.68, h 53.32: 896.00.
  - `sellValue(61118.69, 60200-62200, 44.69)` = 437.00; clamps: sell within h of the floor → 0; buy within h of the ceiling → 1000.
  - `entryCost`/`exitProceeds` for qty 2; `h` of `-1`, `NaN`, `undefined` throw.
  - `effectiveHalfSpread({ halfSpread: 49 }, 35)` = 49; `({}, 35)` = 35.
  - decide: a position that EXITs at h 0 HOLDs at h 35 for the same price; `targetBtc` at h 35 is exactly 35 higher than at h 0; null pick → the reason above; no `halfSpread` → TypeError.
- [ ] **Step 2:** `npm test -- tests/updown-app-pricing.test.js tests/updown-up-dip-setup.test.js`. Expected: new tests FAIL.
- [ ] **Step 3:** Implement; update existing setup-test calls to pass `halfSpread: 0`.
- [ ] **Step 4:** Same command. Expected: PASS.
- [ ] **Step 5:** Commit `feat(updown): price Up contracts with the app's spread`.

### Task 2: Quotes store

**Files:** Create `src/updown/app-quotes.js`; Test `tests/updown-app-quotes.test.js`

**Interfaces**
- Consumes: `expiryMs` (app-order-history), `nextExpiryMs` (up-dip-setup), `quarantineIfUnreadable`.
- Produces `createAppQuotes({ statePath, readJSON, writeJSON, getLatest, clock = Date.now, logger })`:
  - `check(input)` → `{ error } | { quote }`; `record(input)` → same, and saves. `input`: `{ source, range, shown, up, down, floor, ceiling?, expiry?, capturedAt?, maxLoss?, direction? }`.
  - `halfSpread(range)` → `{ value, source: 'quote' | 'default', capturedAt, ageMs }`.
  - `pick(price, now, params)` → contract like `pickContract`'s, or `null`.
  - `getStatus()` → `{ spread: { 2000, 500 }, listingSeen, comparison: { n, coinbase, index }, last }`; each comparison is `{ median, p90 }` or `null` under 10 quotes with that source.
- `getLatest()` → `{ coinbase: { value, at } | null, index: { value, at } | null }`.

Validation order and messages follow the spec's list; `capturedAt` more than 60s ahead is rejected; default `capturedAt` is now and default expiry is `nextExpiryMs(capturedAt)`; a read expiry snaps to the nearest Saturday 04:00 New York within 12h. An identical `(capturedAt to the minute, range, floor, up, down)` returns the stored quote without adding one. Spread uses the newest `capturedAt`, listing uses quotes whose expiry equals `nextExpiryMs(now)`. `coinbase`/`index` are stored as null if older than 5s or captured over a minute earlier. File is re-read on each call.

- [ ] **Step 1: Write failing tests** (clock 2026-11-23T22:59:30Z, latest Coinbase 61,140)
  - both screenshots record with halfSpread 49; maxLoss `'-$486.00'` and `'-$896.00'` accepted, `'-$468.00'` rejected.
  - rejected: Down 60,974; direction Down; floor 60,250; ceiling − floor ≠ range; `down > shown`; gap 402; range 1000; floor 60,000 after 60,200 for the same expiry; shown 1% from Coinbase with no captured time; captured 61s ahead; expiry 13h from a Saturday.
  - a $500 quote with up = shown = down records with halfSpread 0.
  - freshness: 23h59m → quote; 24h → default 35; $500 default 0; a $500 quote leaves 2000 at its default and the reverse.
  - `pick(61138, …)` after floor 60,200 → floor 59,800, ceiling 61,800; after a quote for a past expiry only → null; no candidates in the window → null.
  - the same input twice → one stored quote; 501 quotes → newest 500.
  - a corrupt file is quarantined, defaults apply, `pick` is null.
  - comparison null at 9, `{ median, p90 }` at 10.
- [ ] **Step 2:** `npm test -- tests/updown-app-quotes.test.js`. Expected: FAIL, cannot find module.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Same command. Expected: PASS.
- [ ] **Step 5:** Commit `feat(updown): store operator-confirmed app quotes`.

### Task 3: Feed hooks and quote routes

**Files:** Modify `src/btc-feed/btc-feed-service.js`, `src/routes/updown-routes.js`; Test modify `tests/btc-feed-service.test.js`, create `tests/updown-app-quotes-routes.test.js`

**Interfaces — Produces**
- `btcFeedService.getLatest()` (shape above; `at` = last accepted arrival) and `btcFeedService.subscribeIndex(fn)` → unsubscribe; `fn({ value, timestamp })` for accepted values only; a throwing subscriber is logged and does not stop the others.
- `POST /api/updown/app-quotes`: body as `record`'s input plus `preview: true` to check only → `{ success: true, quote }` or 400 `{ success: false, error }`; 503 when `appQuotes` is not wired. `GET /api/updown/up-dip` gains `quotes: appQuotes.getStatus()`.

- [ ] **Step 1: Write failing tests:** subscriber gets accepted but not rejected values; unsubscribe; a throwing subscriber leaves history and a second subscriber working; `getLatest` null before any event; preview saves nothing; record saves and emits `updown:up-dip`; a rejected quote is 400 with its reason; the screenshot route records nothing.
- [ ] **Step 2:** `npm test -- tests/btc-feed-service.test.js tests/updown-app-quotes-routes.test.js`. Expected: new tests FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Same command. Expected: PASS.
- [ ] **Step 5:** Commit `feat(updown): quote endpoints and index subscription`.

### Task 4: Crypto.com candles

**Files:** Create `src/updown/up-dip-candles.js`; Test `tests/updown-up-dip-candles.test.js`

**Interfaces — Produces** `createUpDipCandles({ subscribeIndex, readIndexMinutes, fetchCandles, clock, logger })` → `start()`, `stop()`, `isReady()`, `getCandles(tf)`, `getStatus()` → `{ ready, waitingFor, substitutes, gaps }`.
- `fetchCandles(tf, count)` → BTC_USD candles; default implementation calls Crypto.com `get-candlestick` with `CANDLE_FETCH_TIMEOUT_MS`. `readIndexMinutes(fromMs)` → recorded bars; default reads `data/btc-feed/` files, skipping torn lines.
- Candle: existing shape plus `substitute: true` on every 1m bar not built from 30+ index values (seeded ones included).

Minutes finalize in order, 2s after they end. 30+ values → index bar. Otherwise fetch that minute every 20s for up to 120s, then skip it as a gap; later minutes wait. Higher timeframes roll up from finalized 1m bars and complete when the bucket's last minute finalizes. Keep 180/180/180/220/365. `isReady` needs all five timeframes seeded; failed seeds retry every 30s.

- [ ] **Step 1: Write failing tests** with a fake clock and fetch: 60 values → exact OHLC, no flag; 29 values → substitute from fetch; 30 → index; a minute that never resolves → missing, and the next minute appears only after the 120s; recorded index minutes replace seeded ones, a 29-sample one does not; a 5m bar completes with its fifth minute and not before; no bar for the in-progress minute; `isReady` false until every seed succeeds; `stop()` unsubscribes and clears timers.
- [ ] **Step 2:** `npm test -- tests/updown-up-dip-candles.test.js`. Expected: FAIL, cannot find module.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Same command. Expected: PASS.
- [ ] **Step 5:** Commit `feat(updown): Crypto.com index candles for the Up dip book`.

### Task 5: Paper book

**Files:** Modify `src/updown/up-dip-paper.js`, `src/updown/up-dip-trend-filter.js` only if its decide call needs the new inputs; Test modify `tests/updown-up-dip-paper-gap.test.js`, `tests/updown-up-dip-signal.test.js`, `tests/updown-up-dip-trend-filter.test.js`; create `tests/updown-up-dip-paper-costs.test.js`

**Interfaces**
- Consumes Tasks 1, 2, 4.
- `createUpDipPaper` gains `getHalfSpread(range)` → number, `pick`, `getCoinbaseBar(ts)` → 1m candle or null, `archiveDir`. `getStatus()` gains `needsReset`, `pricing`, `archived` (newest archive's summary or null).

Rules: state is stamped `pricing: { spread: true, source: 'cryptocom-index' }`. Unstamped with any cycle, pending or position → `needsReset`: evaluate and report `latest`/`signal`, but save nothing and trade nothing. Unstamped and empty → stamp. Unreadable file → quarantine and `needsReset`. Fills store `halfSpread`; ADD keeps the larger. Mid-replay timestamp skip = gap: record it, drop pending ENTER/ADD, keep pending EXIT. Substitute bar: no ENTER/ADD decision (reason `waiting for index data`), EXIT allowed; knock-out only if `getCoinbaseBar` touched the same bound. Cycles closed by knock-out carry `coinbaseTouched`. A bound touched by only one source while a position is open records one `TOUCH_MISMATCH` event per bound, source and position.

- [ ] **Step 1: Write failing tests**
  - ENTER fill costs `entryCost(open, contract, 35)`; EXIT proceeds use the larger of entry 49 and current 35; knock-out and expiry proceeds have no spread.
  - an open position's P&L does not rise when the spread drops 49 → 35.
  - unstamped state with 14 cycles: the file's bytes are unchanged after ten steps, `needsReset` true, `latest.features` present, `signal` present.
  - unstamped empty → stamped and trading; corrupt file → quarantined copy exists, `needsReset`.
  - gap in the middle of a replay is counted; pending ENTER dropped; pending EXIT fills at the next bar's open (replaces the existing EXIT-dropped assertion).
  - substitute: wick through the floor with Coinbase above → no knock-out, one `TOUCH_MISMATCH`; with Coinbase below → knock-out; ENTER signal becomes STAND_ASIDE.
  - index-only touch on an index bar → knock-out with `coinbaseTouched: false`; Coinbase-only touch → no knock-out, one mismatch event over three bars.
  - restart: step, save, rebuild from the file with the same candles → no second fill, cycle or gap.
  - null `pick` → STAND_ASIDE reason from Task 1.
- [ ] **Step 2:** `npm test -- tests/updown-up-dip-paper-costs.test.js tests/updown-up-dip-paper-gap.test.js tests/updown-up-dip-signal.test.js tests/updown-up-dip-trend-filter.test.js`. Expected: new tests FAIL.
- [ ] **Step 3:** Implement; update existing callers in these tests with `getHalfSpread: () => 0`.
- [ ] **Step 4:** Same command. Expected: PASS.
- [ ] **Step 5:** Commit `feat(updown): real costs and Crypto.com rules in the paper book`.

### Task 6: Reset script

**Files:** Create `scripts/reset-up-dip-paper.js`; Test `tests/reset-up-dip-paper.test.js`

**Interfaces — Produces** `resetUpDipPaper({ statePath, archiveDir, apply, now, gatewayOnline })` → `{ archivePath, summary, applied }`; CLI `--book main|shadow` (default main), `--apply`. Summary: `{ book, archivedAt, pricing, closedCycles, wins, pnl, openPosition: null | { contract, contracts, cost, markBtc, pnl, markedAt } }`. The open mark uses the state's own `latest.features.price` at h 0, matching how that book priced. An unknown online state (PM2 unreachable) counts as online.

- [ ] **Step 1: Write failing tests:** dry run writes nothing; `--apply` refused while online or unknown; apply writes `up-dip-paper-<ts>.json` containing `{ summary, state }` with the original state intact, then an empty stamped book; summary of 14 cycles, +714.55 and an open position equals the archived numbers; a missing or unreadable state is refused; an existing archive name is never overwritten; `--book shadow` touches only the shadow file; mode 0o600.
- [ ] **Step 2:** `npm test -- tests/reset-up-dip-paper.test.js`. Expected: FAIL, cannot find module.
- [ ] **Step 3:** Implement with `atomicWriteSync`; archive first, then reset.
- [ ] **Step 4:** Same command. Expected: PASS.
- [ ] **Step 5:** Commit `feat(updown): archive and reset the Up dip paper book`.

### Task 7: Operator contract

**Files:** Modify `src/updown/up-dip-held.js`; Test modify `tests/updown-up-dip-held.test.js`

**Interfaces:** `createUpDipHeld` gains `getCoinbaseCandles(tf)` and `getHalfSpread(range)`; `getCandles` is now the index source. Status adds `halfSpread`, `pnlBeforeSpread`. CHECK_APP reason: `<Coinbase|Crypto.com index|Both> touched the <floor|ceiling> since this fill: the app may have knocked it out`. Coinbase keeps 1m/15m/1h; the index checks non-substitute 1m bars only.

- [ ] **Step 1: Write failing tests:** the existing fill at 61,375 is EXIT +33.52 at h 0 and HOLD at h 35 with `pnlBeforeSpread` 33.52 and `pnl` 16.02; each single source and both trigger CHECK_APP with the right name; an index substitute wick does not; implied entry validation unchanged.
- [ ] **Step 2:** `npm test -- tests/updown-up-dip-held.test.js`. Expected: new tests FAIL.
- [ ] **Step 3:** Implement. **Step 4:** Same command. Expected: PASS.
- [ ] **Step 5:** Commit `feat(updown): real closing value for the operator's contract`.

### Task 8: Backtests

**Files:** Modify `scripts/backtest-up-dip.js`, `scripts/research-up-selection.js`; Test create `tests/backtest-up-dip-costs.test.js`

**Interfaces:** `simulate(candles, features, from, to, params, { decide, halfSpread = 35, pick })`; CLI `--spread N` (default 35, scaled 0 for 500 ranges), `--listing legacy|grid` (default legacy). Report adds `spread` and `listing`. Grid offsets come from the `--orders` file per expiry; weeks without one produce no entries.

- [ ] **Step 1:** Before changing code, run the current `simulate` on a committed synthetic fixture (3 weeks of 1m bars with dips, a floor knock-out, a ceiling knock-out and an expiry) and save its cycles as the golden file.
- [ ] **Step 2: Write failing tests:** spread 0 reproduces the golden cycles exactly; at 35 a non-settled cycle that closes at the same bars is exactly $35 lower; settled cycles are $17.50 lower; grid mode enters only on-grid floors and skips an unknown week; the report carries both fields.
- [ ] **Step 3:** `npm test -- tests/backtest-up-dip-costs.test.js`. Expected: new tests FAIL.
- [ ] **Step 4:** Implement. Re-run. Expected: PASS.
- [ ] **Step 5:** Read-only check from the worktree: `node scripts/backtest-up-dip.js --candles ../../../data/updown/backtest/btc-usd-1m.json --orders ../../../data/updown/import/order-history.jsonl --spread 0`. Expected: train 158 cycles +$5,158, test 223 cycles +$791, rounded to the dollar as in the docs. Never pass `--out` to the main checkout.
- [ ] **Step 6:** Commit `feat(updown): backtest Up dip with the app's spread`.

### Task 9: Wiring, panel and docs

**Files:** Modify `server.js`, `src/routes/settings-routes.js`, `admin/src/components/updown/UpDipPanel.jsx`, `UpDipHeld.jsx`, `ContractSetup.jsx`, `SecondChart.jsx`, `docs/updown-up-dip-setup.md`; Create `admin/src/components/updown/AppQuoteForm.jsx`, `.changelogs/next-up-dip-real-costs.md`; Test modify `tests/gateway-shutdown.test.js`, `tests/gateway-startup-order.test.js`, `tests/restore-writer-quiescence.test.js`, `admin/tests/updown-up-dip-panel.test.jsx`, `updown-up-dip-held.test.jsx`, `second-chart.test.jsx`, `ContractSetup.test.jsx`; create `admin/tests/app-quote-form.test.jsx`

Server: both books use `upDipCandles.getCandles`, `appQuotes.pick`, `appQuotes.halfSpread(2000).value`, and `candleCache.getCandles('coinbase', '1m')` for `getCoinbaseBar`. `upDipCandles.start()` runs after the bind and `stop()` in `stopProducers`. `src/candle-cache.js` consumers are unchanged.

Panel text: `Spread $49 a side (your quote, 3h old)` or `Spread $35 a side (default: no quote in 24h)`; `Round trip $52.98 a contract (10.9% of cost)`; `No contract seen this week: record a quote to paper-trade`; `Previous book (no spread): 14 closed, +$714.55, open -$527.63 at archive`; `Needs reset: run scripts/reset-up-dip-paper.js`; `This rule lost money out of sample after costs`. Backtest line appends `spread $35` or `no spread`, and the listing mode. Comparison shows `not enough yet (n/10)` under 10 and notes that late uploads are noisy. The chart's bounds line gives distances as `index −$603 / Coinbase −$610`; each blanks when its own source is stale.

- [ ] **Step 1: Write failing tests** for each line above, plus: Record quote appears only for an Up `select` preview, shows the spread first, sends nothing until clicked, disables while saving, and shows a rejection; the manual form posts `capturedAt` and expiry; startup, shutdown and restore fakes cover `upDipCandles`.
- [ ] **Step 2:** `npm run test:all`. Expected: only the new assertions FAIL.
- [ ] **Step 3:** Implement; update the doc's Data, Market signal and Operator contract sections and add the costs evidence.
- [ ] **Step 4:** `npm run test:all`, `npm run typecheck`, `npm run lint:admin`, `npm run build --prefix admin`. Expected: all succeed, lint at 47.
- [ ] **Step 5:** Commit `feat(updown): Up dip panel with real costs`.

### Task 10: Live-data verification

**Files:** Create `scripts/check-up-dip-candles.js`

- [ ] **Step 1:** Run `createBtcFeedService` and `createUpDipCandles` for 5 minutes in a temp data directory with no listener, keys or config; print seeded counts, index bars, substitutes, gaps and the median absolute difference between each index bar's close and the same BTC_USD candle's close.
- [ ] **Step 2:** `node scripts/check-up-dip-candles.js`. Expected: all five timeframes seeded, at least 3 index bars, 0 gaps, median difference under $40.
- [ ] **Step 3:** Serve the built admin from a throwaway loopback page server with stubbed data; screenshot `/updown` at 390px and 1280px. Expected: no horizontal scroll; spread, reset and archive lines readable.
- [ ] **Step 4:** Commit `chore(updown): live check for Up dip candles`.

Rollout (gateway drain, reset, start, enter a quote, regenerate the backtest report) is the operator's step per `UPGRADE.md`.
