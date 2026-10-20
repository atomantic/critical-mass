# Regime fill reads

`GET /api/:exchange/regime/fills` requires `paged=true`. Page size is capped at 100 rows; an omitted or false paging flag returns HTTP 400. The Transactions view uses this endpoint.

Dashboard, Charts, and Cost Basis use `GET /api/:exchange/regime/fills/cycles`. The engine computes it from the same revision-cached fill snapshot as Transactions paging. `totalPnl`, `totalHoldback`, fill counts, and cycle counts cover the full ledger. Sell P&L follows the shared cycle pairing rules and counts each order-level annotation once across partial fills. Cost Basis cycle cost/proceeds retain the previous per-fill net-fee calculation.

The response includes at most 250 cost-basis cycles, 250 filled-order cycle summaries, 500 chart points, 500 recent detail fills, and 100 unpaired open-buy fills. `cyclesTruncated`, `fillCyclesTruncated`, `pnlPointsTruncated`, `detailsTruncated`, and `openFillsTruncated` report omissions. Large sell orders are omitted from details as whole groups. The UI keeps exact totals visible while labelling sampled or omitted details; it suppresses open-buy relation rows when their source fills are truncated.
