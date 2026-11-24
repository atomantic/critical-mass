# Up dip: real costs, Crypto.com prices, fresh paper book (project 2)

Status: approved by the operator 2026-11-24. Written against main `ba622a17`.

Labels: **[operator]** = decided by the operator. **[proposal]** = the author's call, open to correction.

## Intent

The Up dip paper book, contract panel and backtests price Crypto.com Up contracts at the
market, with no bid-ask spread. The app's quotes have one, large enough to change whether the
rule makes money. The operator wants the paper book started fresh on Crypto.com data, with
numbers the app would actually pay. The operator's recorded trades already include the spread
and are not affected.

## Evidence

- App screenshots, 2026-11-23, $2,000 range: 14:58 shown 61,118.69, Up 61,172, Down 61,074;
  14:59 shown 61,138.68, Up 61,192, Down 61,094, on a different contract. Both gaps are $98.
- Recorded app fills (124 with candles, Feb-Nov 2026): buys a median $34 above Coinbase, sells
  $35 below; stable under clock shifts of up to a minute. Eight $500-range fills: about $0.
- Contract price equals `maxPayout / range x (quote - floor)`: $486 and $896 match exactly.
- Shipped rule, out of sample (May-Nov): +$791 with no spread, -$6,342 at $35 a side,
  -$7,980 at $49. 7% and 10% targets also lose at $35 and $49.
- $2,000 floors use one $400 grid per expiry week in all 13 weeks traded. Grid offset changes
  weekly. On 2026-11-23 four were listed (59,400-60,600).
- Not established: which price the app knocks out on, that the Down price is the Up close
  price, and why the size of the spread changes.

## Goals

- **[operator]** Crypto.com prices drive the Up dip book.
- **[operator]** Spread in the paper book, contract panel and backtests, measured from the
  operator's screenshots; $35 for $2,000 ranges when the latest measurement is old.
- **[operator]** Suggest only contracts the app lists.
- **[operator]** Log the app's shown price against our sources before choosing a knock-out
  source; until then show both distances.
- **[operator]** Archive and reset the main Up dip book. Entry rules stay the same.

## Non-goals

- New entry or exit rules, or use of the Coinbase lead or 1s data as a rule input (project 3,
  once 1s history exists).
- The composite signal, scorecard, perp book, regime/DCA engines, any order path.
- Resetting the shadow or perp books **[operator]**.

## Anti-goals (failure even if it works)

- Paper P&L the app would not have paid.
- One tally mixing trades priced with and without the spread.
- The reset hiding the old book's result or its open loss.
- A misread screenshot silently changing prices.

## Approaches

- A. Crypto.com prices, no spread. Smallest; keeps reporting wins the app would not pay.
- **B. A plus measured costs. Picked [operator].**
- C. B plus new rules now. No tested rule is profitable after the spread.

## Design

### Quotes (`src/updown/app-quotes.js`)

State `data/updown/app-quotes.json`, newest 500: `{capturedAt, recordedAt, source: 'screenshot'|'manual',
range, shown, up, down, floor, ceiling, expiry, halfSpread, coinbase, index}`.
`halfSpread = (up - down) / 2`. `coinbase` and `index` are the gateway's latest values, null if
older than 5s or if `capturedAt` is more than a minute before recording.

- Nothing is recorded automatically. The screenshot preview shows the spread it would record and
  the operator clicks **Record quote**; or they fill a manual form (range, shown, up, down, floor,
  captured time, expiry). Both call `POST /api/updown/app-quotes`. **[proposal]** This is the guard
  against a misread screenshot.
- Only Up-selected `select` screens qualify; a Down screen asks for an Up one. For Up, floor is
  Stop and ceiling is Target.
- Rejected with the reason shown unless: range is 500 or 2000; `ceiling - floor` equals range;
  floor is a multiple of 100; `down <= shown <= up`; `0 <= halfSpread <= 200`; for gaps of $10 or
  more, `(up - shown)` is 35-65% of the gap (the two screenshots are 54%); floor < down, up < ceiling; `shown` is
  within 0.3% of the latest Coinbase price unless an earlier captured time is given; for a $2,000
  range, the floor is on the $400 grid of any earlier quote for that expiry. Screenshots must also
  match Max Loss, `maxPayout / range x (up - floor)`, within $1.
- Expiry snaps to the nearest Saturday 04:00 New York within 12h of the value read, else rejected.
- `halfSpread(range, now)`: newest quote for the range captured under 24h ago, else $35 for 2000
  and $0 for 500 **[proposal: 24h, and the $0]**. Returns value, source and age.
- At launch the two screenshots (2026-11-23, 14:58 and 14:59 Pacific) are entered with the manual form. $49 then
  applies only until 24h after capture; later launches start at $35 until a new quote.

### Pricing (`src/updown/app-pricing.js`)

Pure, used by every place that prices a contract:
`buyValue(mid, contract, h)` = `contractValue(mid + h)`; `sellValue` = `contractValue(mid - h)`;
the $1.99 fee is unchanged. Opening and closing cross the spread. Knock-outs and expiry do not.
`markPosition`, `targetFor`, entry cost, the exit test and P&L all use it, so the 4% target is
after real costs. The half-spread in force is stored on each paper fill. An open position is
marked and closed at the larger of its entry half-spread and the current one, so a quote
expiring cannot create profit. **[proposal]**

`up-dip-held.js`: the entered cost is the operator's real cost; only the closing value changes.
Its implied entry price keeps the fee-only formula, since app fills already include the spread.

### Listed contracts

`listedFloors(price, expiry, quotes)`: the $400 grid through the newest quote floor for that
expiry; candidates are grid floors from `price - 1900` to `price - 300` **[proposal]**. Pick the
one nearest `price - floorOffset` (unchanged at 1500). At 61,138 with a floor of 60,200 seen,
that is 59,800. With no quote for the expiry the rule stands aside: "no listed contract seen
this week". This makes one screenshot or manual entry a week a requirement to paper-trade; the panel says so.

### Crypto.com candles (`src/updown/up-dip-candles.js`)

A dedicated aggregator fed by accepted `BTCUSD-INDEX` values from the btc-feed service (new
`onIndexValue` subscription), seeded from Crypto.com `BTC_USD` candles for 1m, 5m, 15m, 1h and
1d. Recorded index minutes in `data/btc-feed/` with at least 30 samples replace seeded 1m candles.
`BTC_USD` was a median $7.6 above the index in one 8-minute sample, small beside the 0.6% entry threshold.
Both Up dip books and the contract panel's advice use these candles; `candleCache` and every
other consumer are untouched.

A minute with at least 30 index values is final when it ends. Otherwise the books wait up to
two minutes for its `BTC_USD` candle (a **substitute**), then record a gap **[proposal]**:

- A substitute feeds indicators and fills a pending EXIT at its open. It makes no ENTER or ADD decision, and
  knocks out only if Coinbase touched the bound in the same minute.
- A gap, wherever it falls in a replay, drops a pending ENTER or ADD but keeps a pending EXIT for the next bar's
  open. This changes today's behavior, which checks only the first new bar and drops exits too.

Knock-outs **[proposal, provisional until the comparison below]**: the book settles on these
candles. Every bound touched by only one of index and Coinbase is logged, in both directions, whichever
the book used. On the operator's own contract, CHECK_APP fires if **either** source touched a bound since the fill,
and names which; Coinbase keeps today's 1m, 15m and 1h check.

### Source comparison

Each quote keeps shown, Coinbase and index. The panel lists, per source, the median and 90th
percentile of `shown - source` once there are 10 quotes, and says "not enough yet" before. Nothing switches
automatically. Screenshot time is upload time, so quotes uploaded late are noisy; the panel says so.
The 1s chart's bounds line shows floor/ceiling distance from the index and from Coinbase.

### Book stamping and reset

- Book state gains `pricing: {spread: true, source: 'cryptocom-index'}`. An unstamped book with
  any cycle, pending fill or open position reports `needsReset`: it still evaluates the market, so the contract panel keeps
  its advice, but does not trade. An empty unstamped book (the shadow today) is stamped in place.
- A book file that exists but cannot be read is quarantined and reports `needsReset`; it is never
  treated as empty.
- If the shadow has traded by launch it also reports `needsReset`. It is reset only if the operator asks, with the
  script's `--book shadow`.
- `scripts/reset-up-dip-paper.js` (`--book main` by default): dry run by default. `--apply` refuses while the gateway is
  online, copies the state file to `data/updown/archive/up-dip-paper-<ts>.json` with a summary
  (closed cycles, P&L, and any open position with its mark and source), then writes an empty stamped book.
- The panel shows the archived summary in one line, open position included, e.g. "Previous book
  (no spread): 14 closed, +$714.55, open -$527.63 at archive".

### Backtests

`scripts/backtest-up-dip.js` and `research-up-selection.js` take `--spread` (BTC dollars a side for $2,000
ranges, default 35) and use the pricing module. The report records it; `--spread 0` must reproduce today's published
numbers. `--listing legacy|grid` chooses floors: `legacy` (default) rounds to $100 as today; `grid` uses the $400 grid for the
13 weeks whose offset is known and skips the rest. The panel's backtest line states the spread (or "no spread" for an older report) and the listing mode.

### Panel

Spread in use with source and age; round-trip cost in dollars and as a share of cost; contract
P&L after the spread; "not seen this week" when no quote exists; the archived-book line; and a
standing note that the rule lost money out of sample after costs.

## Failure behavior

- Candles unseeded: no decisions. Index stale: as for substitutes and gaps above. The panel says why.
- Unreadable quotes file: quarantined; default spreads apply and the rule stands aside for lack of a listing.
- Backup and restore cover `app-quotes.json`; the service re-reads it on each call.

## Tests

Pricing (buy, sell, clamps, no spread on settlement, larger-half-spread mark); quote validation
including both screenshots, a Down read as 60,974, an old re-upload, an off-grid floor and a zero
gap; freshness boundary; listed floors incl. the 61,138 case;
stamping, refusal and reset; archived summary with an open position; candle seeding, thin
minute, substitute knock-out rules, gap mid-replay, kept EXIT; CHECK_APP per source; held P&L; backtest at spread 0 and 35 on fixtures. No network in tests.

## Rollout

Deploy requires a gateway drain and restart per UPGRADE.md. Order: stop the gateway, run the
reset, start it, enter a current quote, regenerate the backtest report.

## Left to the builder

File layout inside these modules, form styling, changelog fragment name, test fixtures.
