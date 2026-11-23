# BTC feeds and 1-second chart (project 1)

Status: approved by the operator 2026-11-23. Written against main `e23872bc`.

Labels: **[operator]** = decided by the operator. **[proposal]** = the author's call, open to correction.

## Intent

The operator sells UpDown (Up) options by hand. At a recent sale TradingView's 1m chart
looked stable while price swung within the minute, so the exit was partly blind. They want
to see sub-minute BTC direction while deciding to sell. TradingView is not involved.

## Goals

- **[operator]** True 1s BTC bars built from every trade (approach B).
- **[operator]** Use Crypto.com realtime data; it drives the Up predictor in project 2.
- **[operator]** Read-only gateway service with no keys, independent of which funds are open.
- **[proposal]** Gemini BTC is not subscribed. In an 8 minute sample (index range $98) it
  traded in 13% of seconds (Coinbase 100%, Crypto.com 36%). Revisit in a busier market.

## Non-goals

- No change to signals, scorecard, paper books, regime/DCA engines, or any order path.
- No reset of paper books (project 2), no predictor input from these feeds (project 2).
- No correction of Coinbase trade side in the live engine (see Findings).

## Anti-goals (failure even if it works)

- A chart that looks live when its feed is stalled.
- Buy/sell colors reversed.
- Presenting `BTCUSD-INDEX` as the confirmed contract index.
- A feed failure that disturbs the gateway or an engine.

## Approaches

- A. Draw the existing ~1s samples. Smallest, but the engine keeps only the latest price per
  second (median gap 1.07s, p95 1.33s), so moves inside a second are lost.
- **B. Build 1s bars from every trade. Picked [operator].** Originally in the engine; moved
  to the gateway **[operator approved]** because engines stream only their own funds and
  this way no engine code changes.
- C. Browser connects to Coinbase. True bars, but history only while the tab is open, and it
  bypasses gateway authentication.

## Design

### Feeds (`src/btc-feed/`, gateway process)

| Source | Channel | Use |
|---|---|---|
| Coinbase `BTC-USD` | `market_trades`, via `createWebSocketFeed` with `publicOnly: true` and no credentials | bars, volume, early warning |
| Crypto.com `BTCUSD-INDEX` | `index.BTCUSD-INDEX` (observed 1/s, `{v, t}`) | index line |

The Crypto.com adapter has no index channel. Add a small index client on
`createWebSocketLifecycle`: wait 1s after open, answer `public/heartbeat`, reject
non-finite or non-positive values.

Starts beside `arbitrageService.start()` and stops in the gateway's `stopProducers`.
On by default, no setting **[proposal, stated to operator]**.

### Coinbase side is the MAKER side

Measured 2026-11-23 over 100s: of 996 Coinbase trades, 852 (86%) were BUY at the bid or SELL
at the ask; 141 were the reverse. Crypto.com: 225 of 225 matched the taker side. The bar
builder therefore inverts Coinbase's side (maker SELL = aggressive buy). The inversion lives
in the new service only, with a test that pins it.

### 1s bars

- Pure module: trades in, bars out, injected clock, no I/O.
- Bar: `{t, open, high, low, close, buyVolume, sellVolume, trades}`. `t` is the second of the
  exchange's trade time.
- Trades are ordered by exchange time within a bar (open/close do not depend on arrival).
- Duplicates are dropped by trade ID. A trade more than 10s older than its arrival is dropped.
- `onTrade` does not distinguish the connect snapshot from updates. After each connect, keep
  only trades stamped in or after the first whole second following `onConnect`. This drops the
  snapshot and the partial first second without changing the shared feed. Count dropped trades
  and log when every trade is being dropped (a local clock error looks like this). **[proposal]**
- Flat bars are written only once a later trade arrives: if it is at most 5s after the previous
  trade with no disconnect between, the empty seconds become flat bars (previous close, zero
  volume). Otherwise they are a gap, never filled. Nothing is retracted. **[proposal]**
- The socket's `connected` flag is not evidence of data: it stays true through 60-90s of silence,
  and indefinitely if trades stall while ticker or heartbeats continue. Only an accepted trade
  (Coinbase) or accepted value (index) counts as an event. With none for 30s, the service
  reconnects that source, at most once per minute. **[proposal]**
- Retain 3,600 seconds in memory, for bars and for index values. A gateway restart empties it.

### Index history on disk [proposal]

Crypto.com's index history API returns irregular points, so history starts when we record it.
Append completed 1m index bars `{t, open, high, low, close, samples}` to daily files
`data/btc-feed/index-YYYY-MM-DD.jsonl` (UTC). Minutes with no samples are absent. A failed
write is logged and never stops the feed. The writer is stopped during full backup and
restore alongside the other gateway writers. Files are not pruned (about 40 MB/year).

### Transport

- `GET /api/btc-feed/seconds?seconds=N` (1-3600, default 300): bars, index values, status.
  Operator authentication like every other `/api` route.
- Realtime room `btc-feed`, event `btc-feed:update`, at most 4 per second and only on change:
  bars and index values changed since the last event, plus per-source status.
- Status per source: `connected`, `lastEventAt` (last accepted trade or value). The client re-reads the REST window after a
  reconnect, then applies events by `t`.

### Panel (top of `/updown` chart column)

```
BTC 1s [1s|5s|15s|30s]  [5m|15m|1h]   ● live 0.4s
$61,203 ▼  10s −$38   30s −$71   60s +$12    Index $61,210 (proxy)  gap −$7
│ true candles, index as a thin line                              │
│ volume: buy / sell                                              │
floor −$603 · ceiling +$1,397 (your contract)
```

- True OHLC candles, not Heikin Ashi. Reuse the existing SVG renderer by letting it take
  field names; do not add a chart library.
- 5s/15s/30s are combined from 1s bars in the browser. At most 300 candles: 1s allows 5m;
  5s allows 5m, 15m; 15s and 30s allow all. Other combinations are disabled. Default 1s/5m.
- 10s/30s/60s moves are Coinbase last price minus the close that many seconds earlier; shown
  as `---` when that second falls in a gap.
- Y axis fits visible data only. Floor/ceiling come from the operator's held contract
  (`held` on `GET /api/updown/up-dip`), else the configured contract's stop/target, and are
  shown as distances **from the index price**. A line is drawn only if already in view.
  An `EXPIRED` holding is ignored; `CHECK_APP` is shown with "check the app". The fallback is
  used only for an Up contract and is labeled "configured contract". **[proposal]**
- Index is labeled "proxy" until confirmed as the contract's index. The help article says
  CDNA's index updates once per second from bid/ask midpoints but does not name it.
- Freshness: live under 3s since the last accepted Coinbase trade, amber from 3s, red "stale" from
  10s with moves blanked. The index has its own indicator with the same limits.
- Works at phone width.

### Candle-cache fix

`server.js` feeds each exchange's default-pair price into a cache seeded with BTC. With
Crypto.com's default pair `CRO_USD`, CRO prices would enter a BTC series. Accept a tick into
the cache only when it is from the default pair (unchanged) **and** that pair's base asset is BTC.
Consequence: with a `CRO_USD` default, Crypto.com's cached BTC candles get no live ticks; they
are not replaced by another pair. `updownService.handlePriceTick` already takes only Coinbase's
default pair; add the same BTC check there for a non-BTC Coinbase default.

## Findings outside this project

Because Coinbase side is the maker side, `marketState.tradeImbalance` in the live Coinbase
engine appears inverted where `src/regime-detector.js:177` uses it in momentum, as does the
"taker side" comment at `src/market-data-service.js:370`. It affects trading, so it needs its
own change and review.

## Tests

- Bars: ordering, duplicates, late trades, connect snapshot, empty seconds up to and past 5s,
  disconnect gap, stall reconnect, retention, side.
- Index client: heartbeat reply, malformed frames. Index writer: minute roll, write failure.
- Route: bounds, authentication. Cache fix: CRO tick rejected, BTC tick accepted.
- Panel: combining bars, disabled combinations, gap rendering, stale state, no contract.
- No test opens a network connection.

## Left to the builder

File split inside `src/btc-feed/`, batching internals, styling within existing components,
changelog fragment name, test fixtures.
