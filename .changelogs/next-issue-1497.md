## Fixes

- **[issue-1497] Regime metrics ticks no longer stack during an exchange stall** — The metrics updater skips a tick while the previous `updateMetrics` run is still waiting on candle requests, so a hanging exchange sees one candle fetch per fund instead of one per missed minute. The next tick after the stalled run settles resumes the TP safety net and drawdown refresh.
