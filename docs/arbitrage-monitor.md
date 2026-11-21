# Cross-pair Arbitrage Monitor

The **Arbitrage** page watches for BTC trading at a different implied price
across currency pairs on the *same* exchange, for example BTC/CAD drifting far
below BTC/USD once CAD is converted through that exchange's own USD/CAD market.

**Monitoring only.** The monitor reads public order books. It never reads API
keys, never touches an order path and never places, cancels or sizes an order.

## Venues

| Venue | Public endpoints | 1:1 parity |
|---|---|---|
| Coinbase | `api.exchange.coinbase.com` `/products`, `/products/{id}/book?level=2` | USDC = USD |
| Gemini | `api.gemini.com` `/v1/symbols`, `/v1/book/{symbol}` | GUSD = USD |
| Crypto.com Exchange | `api.crypto.com/exchange/v1/public` `get-instruments`, `get-book` | none |
| Kraken (monitor only) | `api.kraken.com/0/public` `AssetPairs`, `Depth` | none |

Reference FX (indicative only) comes from `api.frankfurter.app` (ECB rates).

## How a poll works

1. Each venue's market list (cached for an hour) is filtered to BTC pairs whose
   quote is in `quoteCurrencies`.
2. For each quote currency the monitor finds the shortest on-venue conversion
   path from the home currency (at most two markets, parity links first).
3. Only the books on those paths are fetched (`bookDepth` levels).
4. Per pair: the implied home-currency mid and its deviation from the venue
   reference (the median implied price, or BTC/home when fewer than three
   pairs are priced). A quote with no on-venue path is priced at reference FX
   and marked not executable.
5. Per ordered pair (buy via A, sell via B): the full loop
   home → A quote → BTC → B quote → home is walked through real depth as a
   taker, paying `takerFeeBps` on every non-parity leg. Sizes from $100 to $1M
   are scanned for the most profitable size and the largest size that still
   clears `alertMinNetBps`.

## Alerts

* **Opportunity** (critical): best route clears `alertMinNetBps` net at a size
  of at least `minAlertNotionalUsd`. One alert per anomalous pair.
* **Dislocation**: a pair's implied price is at least `dislocationAlertBps`
  from the venue reference, executable or not.

An alert opens after `confirmPolls` polls in a row, tracks its current and
peak edge while it lasts, and closes after `closeAfterPolls` polls without the
condition. A venue that fails to load does not count as a miss. Telegram
events: `arbitrage_opportunity`, `arbitrage_dislocation` (only when not
executable) and `arbitrage_closed` (off by default).

State lives in `data/arbitrage-state.json`; settings in `config.global.arbitrage`.
The monitor is off by default; enable it from the page.
