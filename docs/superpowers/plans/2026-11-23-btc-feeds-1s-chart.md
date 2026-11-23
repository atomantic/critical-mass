# BTC Feeds and 1-Second Chart Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show true 1-second BTC candles with buy/sell volume, the Crypto.com index and contract distances on `/updown`.

**Architecture:** A keyless gateway service (`src/btc-feed/`) owns two public sockets, builds 1s bars and index values in memory, records 1m index bars, and serves REST plus a realtime room. The admin panel combines the 1s bars in the browser. Engines are not touched.

**Tech Stack:** Node (CommonJS, `node:test`), existing `createWebSocketFeed` / `createWebSocketLifecycle`, React, vitest.

**Spec:** `docs/superpowers/specs/2026-11-23-btc-feeds-1s-chart-design.md`

## Global Constraints

- Work in a git worktree on a feature branch. The main checkout runs the live PM2 processes: never start a gateway or engine, use PM2, or write under `data/` there.
- No new dependency. No test opens a network connection or writes outside a temp directory.
- No change under `src/adapters/`, `src/websocket-feed.js`, `src/websocket-lifecycle.js`, `src/market-data-service.js`, `src/regime-*.js`, or any order path.
- Coinbase `side` is the MAKER side; inversion lives only in `src/btc-feed/btc-feed-service.js`.
- Retain 3,600 seconds. Drop trades more than 10s older than arrival. Flat bars across at most 5s. Stall reconnect after 30s, at most once per 60s per source. Emit at most every 250ms, only on change.
- Freshness: live under 3s, amber from 3s, stale from 10s. At most 300 candles. The index is always labeled "proxy".
- New `src/` files start with `// @ts-check`; `npm run typecheck` must not add errors.
- Run `/simplify` right before each commit that contains non-test, non-doc code.
- One changelog fragment: `.changelogs/next-btc-second-chart.md`. Never edit `CHANGELOG.md`.

## Review Focus

1. Browser clock differs from the gateway's: age must come from the gateway's `now`, not the browser's wall clock (Task 5).
2. A replaced feed's late callbacks must not add trades, mark disconnects or update freshness (Task 3).
3. Malformed trades (NaN price, zero size, unknown side, timestamp over 5s in the future) must not enter bars (Task 1).
4. An update arriving while the REST window loads, or after a realtime reconnect, must not be overwritten by older REST data (Task 5).
5. Index stale while Coinbase is live: floor/ceiling distances and gap must blank, not show the last value (Task 6).

## File Structure

| File | Responsibility |
|---|---|
| `src/btc-feed/second-bars.js` | Trades to 1s bars; pure |
| `src/btc-feed/index-series.js` | Index values by second; pure |
| `src/btc-feed/index-client.js` | Crypto.com index socket |
| `src/btc-feed/index-history.js` | 1m index bars to JSONL |
| `src/btc-feed/btc-feed-service.js` | Wires sources, stall recovery, emission |
| `src/btc-tick-filter.js` | Which engine ticks may enter BTC series |
| `src/routes/btc-feed-routes.js` | REST window |
| `admin/src/utils/btcSeconds.mjs` | Combine, merge, moves, freshness, bounds; pure |
| `admin/src/hooks/useBtcSeconds.js` | REST + realtime state |
| `admin/src/components/updown/SecondChart.jsx` | Panel |
| `admin/src/components/charts/VolumeRenderer.jsx` | Buy/sell volume bars |

---

### Task 1: 1s bar builder

**Files:** Create `src/btc-feed/second-bars.js`; Test `tests/btc-second-bars.test.js`

**Interfaces:**
- Produces: `createSecondBars({ now = Date.now, retentionSeconds = 3600, maxTradeAgeMs = 10_000, maxFutureMs = 5_000, maxFlatGapMs = 5_000 })` returning
  - `markConnected()`, `markDisconnected()`
  - `addTrade({ tradeId, price, size, side, timestamp })` → `'accepted' | 'duplicate' | 'late' | 'pre-connect' | 'invalid'`; `side` is the taker side, `'buy' | 'sell'`
  - `getBars(seconds)` → `Bar[]` ascending; `drainChanged()` → `Bar[]`
  - `getLastAcceptedAt()` → arrival ms or `null`
- `Bar`: `{ t, open, high, low, close, buyVolume, sellVolume, trades }`, `t` = ms at the start of the second.

Store only traded seconds, each with its connection epoch. Derive flat bars when reading: between consecutive traded bars of one epoch, when next first-trade time minus previous last-trade time is at most `maxFlatGapMs`, fill empty seconds at the previous close with zero volume. An accepted trade marks the range from the previous traded bar through the next one dirty; `drainChanged` returns derived bars in dirty ranges and clears them. Order trades in a second by `(timestamp, numeric tradeId, arrival)`. Check order in `addTrade`: invalid, pre-connect, late, duplicate.

- [ ] **Step 1: Write failing tests** using a helper `at(sec, ms = 0)` = `1_800_000_000_000 + sec*1000 + ms`, injected `now`, and `markConnected()` at `at(0, 500)` (so second 1 is the first kept):

| Test name | Assertion |
|---|---|
| builds OHLCV from taker sides | trades 100 buy 1, 103 sell 2, 99 buy 3 in second 1 → `{t: at(1), open:100, high:103, low:99, close:99, buyVolume:4, sellVolume:2, trades:3}` |
| orders by exchange time, not arrival | later-stamped 105 arrives before earlier-stamped 100 → open 100, close 105 |
| breaks timestamp ties by trade id | ids `'12'` (price 7) then `'9'` (price 5), same ms → open 5, close 7 |
| drops a duplicate id | second add returns `'duplicate'`, `trades` is 1 |
| drops a trade over 10s old | age 10_001 → `'late'`; age 10_000 → `'accepted'` |
| drops the snapshot and partial first second | stamped `at(0, 900)` → `'pre-connect'`; `at(1)` → `'accepted'` |
| rejects malformed trades | price NaN, 0, size 0, size NaN, side `'x'`, timestamp NaN, timestamp now+5_001 → `'invalid'` each; no bars |
| fills up to 5s | trades at `at(1)` and `at(6)` → bars 1..6; 2..5 flat at close with zero volume and `trades: 0` |
| leaves a longer gap empty | `at(1)` and `at(6, 1)` → bars 1 and 6 only |
| never fills across a disconnect | disconnect then connect between `at(1)` and `at(4)` → no bars 2..3 |
| does not add flat bars before the next trade | trade at `at(1)`, now = `at(4)` → one bar |
| revises flat bars on a late trade | `at(1)`=100, `at(4)`=110, then `at(2)`=90 → bar 3 flat at 90 |
| drainChanged returns revisions once | after the row above: bars 1..4 returned, next call `[]` |
| evicts after retention | trades at `at(1)` and `at(3601)` → bar 1 gone; ids older than 10s are also released (assert via a second add of the old id returning `'late'`, not `'duplicate'`) |

- [ ] **Step 2:** Run `node --test tests/btc-second-bars.test.js`. Expected: FAIL, cannot find module.
- [ ] **Step 3:** Implement `second-bars.js` to the interface above.
- [ ] **Step 4:** Run the same command. Expected: all pass.
- [ ] **Step 5:** Commit `feat(btc-feed): build 1s bars from trades`.

### Task 2: Index client, series and history

**Files:** Create `src/btc-feed/index-client.js`, `index-series.js`, `index-history.js`; Test `tests/btc-index.test.js`

**Interfaces:**
- `createIndexClient({ instrument = 'BTCUSD-INDEX', onValue, onConnect, onDisconnect })` → lifecycle object (`connect`, `disconnect`, `getStatus`). `onValue({ value, timestamp })`. URL `wss://stream.crypto.com/exchange/v1/market`, `subscribeDelay: 1000`, channel `index.<instrument>`; answers `public/heartbeat` with `{ id, method: 'public/respond-heartbeat' }`.
- `createIndexSeries({ now, retentionSeconds = 3600 })` → `add({ value, timestamp })` → boolean, `getValues(seconds)` → `{ t, value }[]`, `drainChanged()`, `getLastAcceptedAt()`. Same 10s-late and 5s-future limits as Task 1.
- `createIndexHistory({ dir, logger, append = defaultAppend })` → `add({ value, timestamp })`, `pause(): Promise<void>`, `resume(): void`. Default append makes `dir` (recursive) and appends with mode `0o600`, inside `trackPendingWrite('btc-index-history', …)` from `src/pending-writes.js`; appends run one at a time.

A minute completes when a value from a later minute arrives. Values older than the current minute are ignored. Line: `{"t","open","high","low","close","samples"}`, `t` = minute start ms, file `index-YYYY-MM-DD.jsonl` by UTC date of `t`. While paused, completed minutes are held (at most 1,440, oldest dropped) and written on resume. `pause()` resolves after any in-flight append. A failed append logs a warning and loses that line only. Partial minutes are never written.

- [ ] **Step 1: Write failing tests** with `tests/helpers/fake-websocket.js`, mock timers and a temp dir:
  - client: no frame before 1000ms after open, then exactly `{ id: 1, method: 'subscribe', params: { channels: ['index.BTCUSD-INDEX'] } }`; heartbeat id 7 is answered with id 7; `{result:{channel:'index',data:[{v:'61439.25',t:5000}]}}` → `onValue({ value: 61439.25, timestamp: 5000 })`; `v` of `'x'`, `'0'`, `'-1'`, missing `t`, non-array `data`, and invalid JSON call nothing and do not throw; a `code: 40004` subscribe reply calls nothing.
  - series: same-second values keep the later timestamp; late and future values return false; retention evicts.
  - history: values 10, 12, 9, 11 in one minute, then one in the next → one line `open 10, high 12, low 9, close 11, samples 4`; `23:59` and `00:00` UTC minutes go to different files; a skipped minute writes nothing; a rejected append logs once and the next minute still writes; `pause()` waits for an unresolved append, holds the next minute, and `resume()` writes it.
- [ ] **Step 2:** Run `node --test tests/btc-index.test.js`. Expected: FAIL, cannot find module.
- [ ] **Step 3:** Implement the three modules.
- [ ] **Step 4:** Run again. Expected: all pass.
- [ ] **Step 5:** Commit `feat(btc-feed): read and record the Crypto.com BTC index`.

### Task 3: Feed service

**Files:** Create `src/btc-feed/btc-feed-service.js`; Test `tests/btc-feed-service.test.js`

**Interfaces:**
- Consumes: Tasks 1 and 2; `createWebSocketFeed('coinbase', { productId: 'BTC-USD', publicOnly: true, onTrade, onConnect, onDisconnect })`, whose `onTrade` gives `{ tradeId, price, size, side, timestamp }` with MAKER `side`.
- Produces: `createBtcFeedService(io, { DATA_DIR, now = Date.now, createTradeFeed, createIndexClient, createIndexHistory })` (factories default to the real ones) returning `start()`, `stop()`, `getStatus()`, `getWindow(seconds)`, `pauseHistory(): Promise<void>`, `resumeHistory()`.
- `getStatus()` → `{ running, now, coinbase: { connected, lastEventAt }, index: { connected, lastEventAt } }`.
- `getWindow(n)` → `{ bars, index, status }`. Event: `io.to('btc-feed').emit('btc-feed:update', { bars, index, status })`.

`lifecycle.disconnect()` permanently disables that instance's reconnect, so recovery must disconnect the old instance and create a new one. Guard every callback with a per-source generation number. Stall time counts from the later of start, last accepted event and last recreation. Emission: one 250ms interval; emit when bars, index values or a `connected` flag changed. All timers are `unref`'d and cleared by `stop()`. `start()` twice is a no-op. History is at `path.join(DATA_DIR, 'btc-feed')`.

- [ ] **Step 1: Write failing tests** with fake factories, a fake `io`, and mock timers:
  - maker BUY adds to `sellVolume`, maker SELL to `buyVolume`.
  - Coinbase feed is created with `publicOnly: true` and no `apiKey`/`apiSecret`.
  - three trades within 250ms → one emit; no change for 5s → no emit; a disconnect alone emits once.
  - no accepted trade for 30s (with `connected: true`) → old instance disconnected, a second created and connected; still silent → third only 60s after the second.
  - index stall recreates only the index client.
  - duplicate or late trades do not postpone the stall reconnect or move `lastEventAt`.
  - after recreation, the first instance's `onTrade`, `onConnect` and `onDisconnect` change nothing.
  - 50 trades dropped with none accepted since connect → one warning naming a possible clock error; no second warning until the next connect.
  - a `createTradeFeed` that throws is logged; the index source still starts; retried by the stall path.
  - a throwing `io.emit` or history does not escape the timer or callback.
  - `stop()` disconnects both, clears timers (no emit after), and a late callback changes nothing; `start()` works again.
  - `getWindow(2)` returns only the last 2 seconds relative to `now`.
- [ ] **Step 2:** Run `node --test tests/btc-feed-service.test.js`. Expected: FAIL, cannot find module.
- [ ] **Step 3:** Implement the service.
- [ ] **Step 4:** Run again. Expected: all pass.
- [ ] **Step 5:** Commit `feat(btc-feed): keyless gateway feed with stall recovery`.

### Task 4: Route, gateway wiring and candle-cache fix

**Files:**
- Create: `src/routes/btc-feed-routes.js`, `src/btc-tick-filter.js`
- Modify: `server.js` (rooms ~122, `stopProducers` ~150, `runBackup` ~239, tick listeners ~353 and ~414, route registration ~439, start block ~679), `src/routes/settings-routes.js` (`gatewayWriters` ~52)
- Test: create `tests/btc-feed-routes.test.js`, `tests/btc-tick-filter.test.js`; modify `tests/gateway-shutdown.test.js`, `tests/gateway-startup-order.test.js`, `tests/restore-writer-quiescence.test.js`, `tests/backup-writer-quiescence.test.js`

**Interfaces:**
- `module.exports = (app, { btcFeedService })` registers `GET /api/btc-feed/seconds` → `{ success: true, ...getWindow(n) }`. `seconds` missing → 300; otherwise it must match `/^\d+$/` and be 1-3600, else 400 `{ success: false, error: 'seconds must be a whole number from 1 to 3600' }`. Registered through `routes`, so `/api` authentication applies.
- `acceptsBtcTick(exchange, pair, getDefaultPair)` → boolean. Default pair = `getDefaultPair(exchange)`. False when `pair` is set and differs from the default; otherwise `getBaseCurrency(default ?? pair) === 'BTC'` (from `src/config-utils.js`; null stays accepted, as today).

- [ ] **Step 1: Write failing tests**
  - route: `seconds` of absent/`1`/`3600` pass 300/1/3600; `0`, `3601`, `-1`, `1.5`, `abc`, an array → 400.
  - auth: source assertion that `server.js` registers it as `require('./src/routes/btc-feed-routes')(routes,` after the `/api` `operatorAuth.requireAuth` line.
  - filter: cryptocom default `CRO_USD`, pair `CRO_USD` → false; pair `BTC_USD` → false; coinbase `BTC-USDC` both → true; pair absent with BTC default → true; `ETHUSD` default → false; `CBBTC-USD` default → false; default and pair both null → true.
  - source assertions: both engine tick listeners in `server.js` call `acceptsBtcTick(`.
  - shutdown: `stopProducers` calls `btcFeedService.stop()` in all three existing cases (add the fake; order: after `shadow`, before `logs`).
  - startup: `btcFeedService.start` runs only after the bind (add the fake; name `btcFeed.start`).
  - backup and restore: the writer `BTC index history` is paused before the copy and resumed after, including after a failed copy.
- [ ] **Step 2:** Run `node --test tests/btc-feed-routes.test.js tests/btc-tick-filter.test.js tests/gateway-shutdown.test.js tests/gateway-startup-order.test.js tests/restore-writer-quiescence.test.js tests/backup-writer-quiescence.test.js`. Expected: new assertions FAIL.
- [ ] **Step 3:** Implement the two modules and the wiring: room `'btc-feed'`; start after `arbitrageService.start()`; writer descriptor `{ name: 'BTC index history', stop: () => btcFeedService.pauseHistory(), resume: () => btcFeedService.resumeHistory() }` in `runBackup` (full archives only) and in `gatewayWriters()`.
- [ ] **Step 4:** Run the same command, then `npm test` and `npm run typecheck`. Expected: all pass, no new type errors.
- [ ] **Step 5:** Commit `feat(btc-feed): serve 1s BTC data; keep non-BTC ticks out of BTC candles`.

### Task 5: Browser data layer

**Files:** Create `admin/src/utils/btcSeconds.mjs`, `admin/src/hooks/useBtcSeconds.js`; Test `admin/tests/btc-seconds.test.js`, `admin/tests/use-btc-seconds.test.jsx`

**Interfaces** (`t` in ms):
- `INTERVALS = [1, 5, 15, 30]`, `RANGES = [300, 900, 3600]`, `MAX_CANDLES = 300`, `isAllowed(interval, range)`.
- `mergeByT(existing, incoming, cutoffT)` → ascending, incoming wins, entries before `cutoffT` dropped.
- `buildSlots({ bars, index, interval, range, nowMs })` → `Slot[]` of length `range / interval`, the last containing `nowMs`. `Slot`: `{ chartIndex, t, open, high, low, close, buyVolume, sellVolume, indexValue }`; OHLC and `indexValue` are `null` when no data falls in the slot; volumes are then 0. `indexValue` is the last value in the slot.
- `priceMoves(bars, { stale })` → `{ 10, 30, 60 }`, each last close minus the close exactly that many seconds before the last bar, or `null` (no such bar, or stale).
- `freshness(ageMs)` → `'live' | 'amber' | 'stale'`; null age is `'stale'`.
- `contractBounds(held, contract)` → `{ floor, ceiling, label, note } | null`.
- `useBtcSeconds(rangeSeconds)` → `{ bars, index, nowMs, ages: { coinbase, index }, error }`.

`ages` = `status.now - lastEventAt` at receipt plus elapsed `performance.now()` since receipt. `nowMs` = `status.now` plus the same elapsed time. Both refresh every 500ms, so they keep growing when realtime stops. On mount, on a range change and on realtime `connect`, re-read REST; updates received while a read is pending are buffered and merged after it. A superseded read is ignored.

- [ ] **Step 1: Write failing tests**
  - `isAllowed`: only (1,300), (5,300), (5,900), and 15 and 30 with every range are true.
  - `buildSlots`: 5s combining gives first open, max high, min low, last close, summed volumes; a slot with no bars is null; 1s/300 gives 300 slots; `nowMs` 4s after the last bar leaves 4 trailing null slots.
  - `priceMoves`: `{10: -38, 30: null, 60: 12}` for bars missing exactly the 30s-earlier second; all null when stale.
  - `freshness`: 2_999 live, 3_000 amber, 9_999 amber, 10_000 stale, null stale.
  - `contractBounds`: held HOLD → label `your contract`, no note; `CHECK_APP` → note `check the app`; `EXPIRED` → falls back; contract `{direction:'up', stop, target}` → floor = stop, ceiling = target, label `configured contract`; `direction: 'down'` or null, or missing stop/target → null.
  - hook: browser `Date.now()` mocked an hour off does not change ages; an update during a pending read survives an older REST bar with the same `t`; `connect` triggers a re-read; a late response for a previous range is ignored; with no updates for 11s the Coinbase age exceeds 10_000; a failed read sets `error` and keeps existing bars; unmount unsubscribes room `btc-feed`.
- [ ] **Step 2:** Run `cd admin && npx vitest run tests/btc-seconds.test.js tests/use-btc-seconds.test.jsx`. Expected: FAIL, cannot resolve module.
- [ ] **Step 3:** Implement both files with `apiGet` and `getRealtimeClient` (`subscribe`/`unsubscribe`/`on`/`off`).
- [ ] **Step 4:** Run again. Expected: all pass.
- [ ] **Step 5:** Commit `feat(updown): browser data layer for 1s BTC bars`.

### Task 6: Panel

**Files:**
- Create: `admin/src/components/updown/SecondChart.jsx`, `admin/src/components/charts/VolumeRenderer.jsx`
- Modify: `admin/src/components/charts/HeikinAshiRenderer.jsx`, `admin/src/components/updown/Dashboard.jsx` (first child of the `lg:col-span-2` column)
- Create: `.changelogs/next-btc-second-chart.md`; Modify: `docs/pm2-architecture.md` (realtime room list, one line for the feed service)
- Test: `admin/tests/second-chart.test.jsx`

**Interfaces:**
- `HeikinAshiRenderer({ data, fields = { open: 'haOpen', high: 'haHigh', low: 'haLow', close: 'haClose' } })`; existing call sites unchanged.
- `VolumeRenderer({ data })`: per slot, a green `buyVolume` bar with a red `sellVolume` bar stacked on it.
- `SecondChart({ contract })`. Reads `held` from `GET /api/updown/up-dip` (refresh on `updown:up-dip`, room `updown`, `minIntervalMs: 5000`).

Price chart: `CartesianChart` with an explicit y domain from visible candle highs/lows and index values, a thin index line series, and the candle renderer as overlay. A floor or ceiling `referenceLine` is added only when inside that domain. Volume: second `CartesianChart`, 60px. Disallowed range buttons are `disabled`; choosing an interval that disallows the current range selects that interval's largest allowed range. Test ids: `second-freshness`, `second-index`, `second-moves`, `second-bounds`.

- [ ] **Step 1: Write failing tests** (mock `useBtcSeconds`, `apiGet`, `useRealtimeRefresh`):
  - defaults to 1s/5m; 15m and 1h disabled at 1s; choosing 5s enables 15m; choosing 1s while on 15m returns to 5m.
  - freshness text `live 0.4s`; at 4s the amber class; at 11s `stale` and moves read `10s --- 30s --- 60s ---`.
  - index shows `(proxy)`; with index age 11s the index, gap and bounds all show `---` while Coinbase stays live.
  - held floor 60600 / ceiling 62600, index 61203 → `floor −$603 · ceiling +$1,397 (your contract)`; `CHECK_APP` adds `check the app`; no contract → no `second-bounds`.
  - a null slot draws no candle; a floor outside the visible range draws no reference line, inside draws one.
  - buy bars green, sell bars red: one slot with `buyVolume: 3, sellVolume: 1` → green height is 3x red.
  - no bars and an error → the error text, no crash.
  - existing `cartesian-charts` and `btc-chart-history-error` tests still pass.
- [ ] **Step 2:** Run `cd admin && npx vitest run tests/second-chart.test.jsx`. Expected: FAIL, cannot resolve module.
- [ ] **Step 3:** Implement the components and Dashboard wiring; header rows use `flex-wrap`.
- [ ] **Step 4:** Run again, then from the repo root `npm run test:all`, `npm run lint:admin`, `npm run typecheck`, and `npm run build --prefix admin`. Expected: all succeed.
- [ ] **Step 5:** Write the changelog bullets: the 1s chart; the gateway now opens public Coinbase and Crypto.com market sockets without keys; Crypto.com BTC candles no longer take CRO prices. Commit `feat(updown): 1-second BTC chart`.

### Task 7: Live-data verification

**Files:** Create `scripts/check-btc-feed.js`; no other change.

**Interfaces:** Consumes `createBtcFeedService`. Runs 90s with a stub `io` and a temp `DATA_DIR`, opens no listener, reads no config or keys, then prints one JSON summary and removes the temp directory.

- [ ] **Step 1:** Write the script: `bars`, `gapSeconds`, `indexValues`, `indexHistoryLines`, `emits`, maximum age of each source, and the share of traded bars where `sign(buyVolume - sellVolume)` equals `sign(close - open)`.
- [ ] **Step 2:** Run `node scripts/check-btc-feed.js` from the worktree. Expected: `bars` ≥ 80, `indexValues` ≥ 80, `indexHistoryLines` ≥ 1, `emits` ≤ 361, and the sign share above 0.5. A share below 0.5 means the side inversion is wrong: stop and report it.
- [ ] **Step 3:** Serve the built admin with stubbed `/api/btc-feed/seconds` data and screenshot `/updown` at 390px and 1280px. Expected: no horizontal scroll, candles, volume and index line visible.
- [ ] **Step 4:** Commit `chore(btc-feed): live feed check script`.

Deployment (gateway restart, per `UPGRADE.md`) is the operator's step and is not part of this plan.
