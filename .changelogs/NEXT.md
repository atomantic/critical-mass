# Unreleased Changes

## Dev UI
- The admin Dev UI now loads when accessed over a private Tailscale network hostname (e.g. a `*.ts.net` MagicDNS address), instead of being blocked with a "host is not allowed" error.

## Market data candles
- **[issue-145] No duplicate candles at the seed/live boundary** — after seeding historical candles on startup, the still-open candle is now continued by live ticks instead of being duplicated, so charts and trend signals read clean, single-timestamped candles with complete volume rather than two overlapping candles per timeframe.

## Gemini market data
- **[issue-144] Accurate Gemini live bid/ask** — Gemini's real-time best bid and ask now track the live order book instead of drifting one-way over a session, so entry orders are priced off the current market rather than a stale, too-high bid.

## Fund configuration
- Saving a fund's configuration can no longer change its traded asset. Switching the platform on the config page could previously leave the editor holding another fund's stale settings and write them over the current fund — e.g. saving a Coinbase BTC product onto the Gemini ETH fund, which then showed the BTC price for ETH. Such cross-market saves are now rejected and the fund keeps its own market. (Quote-currency changes like USD→USDC are still allowed.)
