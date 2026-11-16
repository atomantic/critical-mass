# UpDown Up-only dip setup (paper)

`src/updown/up-dip-setup.js` turns the operator's manual Crypto.com UpDown method
into explicit ENTER / ADD / EXIT / HOLD / STAND_ASIDE recommendations. It is Up-only
and **paper-only**: `src/updown/up-dip-paper.js` keeps a simulated book on the
gateway's Coinbase candles and `/updown` shows it (Up Dip Setup panel). No code path
places, modifies or cancels an order.

## Data

- Trades: 44 app orders → 51 buy→sell cycles (Feb 19 – Nov 15 2026), 50 wins,
  1 loss, +$3,638.08. Imported into the trade log by
  `scripts/import-updown-app-history.js` (dry run by default).
- Candles: Coinbase BTC-USD 1m, Jan 15 – Nov 16 2026 (439k bars), fetched from the
  public market endpoint by `scripts/fetch-updown-candles.js`. The app prices off
  Crypto.com's index; the basis between the two is not modeled.

## Contract model (verified on every app fill)

- Up value = maxPayout × (BTC − floor) / (ceiling − floor), clamped to
  [0, maxPayout]; maxPayout 1000 on $2000 ranges, 500 on $500 ranges; no time decay.
- $1.99 per contract per side, already inside the app's fill amounts.
- Floor touch → 0, ceiling touch → maxPayout − fee, otherwise settle at the
  expiry price. Expiry: Saturday 04:00 America/New_York.
- "Widest range, lowest listed floor" is modeled as floor ≈ price − $1,500
  (the operator's $2000-range entries sat a median $1,440 above the floor). That
  puts the ceiling ~$500 above entry and makes one contract a $0.50/BTC-dollar
  long whose round-trip fee equals an $8 BTC move.

## What the operator's trades look like (labels at each fill)

| | n | drop from 60m high | vs 1m EMA20 | vs 15m EMA20 | vs 1d EMA20 | 1m RSI |
|---|---|---|---|---|---|---|
| entry | 51 | median 0.40% | 0.00% | +0.09% | −3.2% | 49 |
| add | 28 | 0.60% | −0.09% | −0.38% | −4.7% | 44 |
| exit | 51 | 0.15% | +0.13% | +0.31% | −3.1% | 63 |

Entries are turns after a dip back to the 1m EMA (35/51 on a green 1m bar), not deep
oversold prints. Exits are recoveries above the 1m EMA. 20 of 51 entries had fewer
than 3 days to expiry; the only loss was entered ~11h before expiry.

## Backtest (`scripts/backtest-up-dip.js`)

Decide at each 1m close, fill at the next 1m open, formula + fees, knock-outs on the
bar's high/low (floor first when both), expiry settlement. Every dip in the period
is eligible, not only the operator's. Train Feb 15 – Apr 30, held out May 1 – Nov 16.
Parameters were selected on train only (pnl / drawdown over a 108-point grid);
`minDaysToEnter` 3 is the operator's stated rule (train preferred 1).

| params | set | cycles | win rate | P&L | worst | max DD | floor KOs |
|---|---|---|---|---|---|---|---|
| shipped defaults (3 days) | train | 158 | 98.1% | +$5,158 | −$796 | $1,507 | 3 |
| shipped defaults (3 days) | **test** | 223 | 94.6% | **+$791** | −$790 | **$3,473** | 12 |
| train-selected (1 day) | train | 251 | 98.0% | +$8,160 | −$796 | $1,331 | 5 |
| train-selected (1 day) | **test** | 390 | 93.3% | **−$2,295** | −$790 | $4,393 | 26 |
| baseline: any green 1m bar | test | 1,410 | 93.5% | −$7,318 | −$802 | $9,942 | 90 |
| train-selected + 30% stop | test | 451 | 82.9% | −$1,100 | −$347 | $2,559 | 0 |

Monthly (defaults): Feb −$1,398, Mar +$3,498, Apr +$1,788, May +$453, Jun −$1,584,
Jul −$474, Aug +$1,388, Sep +$642, Oct +$387, Nov −$183.

Operator entries caught (a simulated fill within ±30 min): 6 of 43 in train and
2 of 7 in test with defaults; about 95% of simulated entries were not near an
operator entry.

## Verdict

**The edge is not robust out of sample.** The high win rate is a short-volatility
payoff: ~$30 wins against full-cost floor knock-outs of ~$790, so break-even
needs ~96% wins. Out of sample the train-selected rule lost money. The shipped
3-day variant was slightly positive (+$3.55/cycle with a $3.5K drawdown), but that
is within noise and four of its ten months lost money. Loss stops made it worse.
The dip filter beats random green-bar entries, but in test it earned about the same
per trade. The operator's real record (51 selective trades, 50 wins) implies
discretion the rule does not capture: which weeks to trade, and when not to.
Watch the paper panel for consistency before considering anything live. Do not
automate it.

## Selection research (`scripts/research-up-selection.js`)

Features at each entry: MA20/50/200 distance and slope on 1m–1d, drawdown from the
1h/4h/24h high, 1h/24h realized volatility, RSI on 5m/15m/1h, calendar, days to
expiry, and floor distance in 24h-volatility units. Three groups are compared: the
operator's 51 entries; 537 stateless rule ENTER signals (first per hour), each traded
standalone (514 wins, 23 floor knock-outs, only 4 of those in train); and 3,000 random minutes.

**Operator vs rule (stable in both halves, AUC 0.75–0.83).** The operator enters
after the dip has stabilized, while the rule fires mid-dip:

| | operator median | rule median |
|---|---|---|
| 5m RSI | 53 | 36 |
| 1m MA50 slope | 0.00% | −0.06% |
| vs 3m MA20 | −0.01% | −0.28% |
| drop from 1h high | 0.40% | 0.74% |

The operator also trades when 1h volatility is high (AUC 0.70 train, 0.77 test vs random).

**Winners vs knock-outs: no stable separator.** With 4 train knock-outs, the
train-best features (1d MA50 distance and slope, hour) fall to AUC 0.55–0.63 in test.

**Train-only filter fit (1–2 thresholds over the top features):** the selected
`hourUtc >= 4` is an artifact of those 4 knock-outs. Test +$1,423 vs +$819 unfiltered,
but hour ≥ 1 gives +$444 and hour ≥ 6 gives +$727: not robust.

**Stabilization filters copied from the operator** lose money or rarely trade:

| filter | test cycles | test P&L |
|---|---|---|
| 5m RSI ≥ 45 | 52 | −$1,549 |
| 1m MA50 slope ≥ 0 | 10 | +$411 |

The operator's edge is not reproduced by entering at the same moment on every dip.

**Daily-trend filter (post hoc; test was visible when it was chosen).** Requiring
price ≥ 4% below the 1d MA50 at most gives test 125 cycles, 96.8% wins, +$2,672,
drawdown $1,803 and 4 knock-outs (vs 226, 94.3%, +$819, $3,473, 12). Thresholds of
−3% and −5% are similar. It works by standing aside through whole downtrends: June
and November in test. That is two regime episodes, not a clear edge. The 1d MA50 is
undefined before about Mar 6 in this candle set, so its February result is missing
data, not a signal. It would also have blocked the operator's winning February and
November trades. **Not shipped.**

**Floor and exit variants (unfiltered, test):**

| variant | P&L | drawdown | knock-outs | worst loss |
|---|---|---|---|---|
| floor offset $1,000 | −$143 | — | — | — |
| floor offset $1,440 (operator median) | +$376 | — | — | — |
| floor offset $1,850 (≈ lowest floor the operator used) | +$1,286 | $2,552 | 8 | −$977 |
| momentum-fade exit (exit on the first red 1m bar once at target), offset $1,440 | +$1,121 | — | — | — |
| momentum-fade exit, offset $1,000 | −$1,846 | — | — | — |

Train ranks these differently from test, so none is a robust improvement.
