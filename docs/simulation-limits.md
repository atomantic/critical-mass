# Simulation endpoint limits

Backtest and optimizer routes are read-only simulations, but they still fetch
market data and execute CPU-intensive calculations. The gateway validates them
at the HTTP boundary; the admin UI is not the authority for those limits.

- `GET /api/:exchange/backtest/prices` accepts only supported interval types and
  the bounded history each current UI preset supports (from seven days at one
  minute through four years of daily candles).
- `POST /api/:exchange/backtest/run` accepts finite, bounded numeric fields and
  the same history and interval limits.
- `POST /api/:exchange/optimizer/run` accepts only the UI's supported interval,
  markup, and period choices. Selections must be non-empty and unique, and no
  request can exceed 216 combinations.

The gateway permits at most two active simulations process-wide and one active
simulation per fund. A duplicate fund request returns `409`; exhausted process
capacity or a recent cache-bypassing optimizer request returns `429`. Rejections
include a stable `code`, JSON `error`, and `Retry-After` header/value. Cached
optimizer results remain available while a simulation is active.
