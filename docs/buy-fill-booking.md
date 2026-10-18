# Buy-fill booking

`handleOrderFill` serializes each exchange order before the buy path runs.
`resolveBuyBookingBatch` selects unbooked rows, bounds recovery against known
body tranches and consumption, and registers the existing WS/poll dedup key.
It returns either the batch and its trade IDs or one of four skip reasons.
Terminal `settled` and `recommit` skips retire the tracked entry and acknowledge
the executor; `no-fills` and `duplicate` skips return without acknowledgement.
A terminal order with no discoverable fills still throws an incomplete-fill error.

`prepareBuyBodyBooking` captures the batch summary, prior order ownership,
merge candidate and once-only accounting closure before merge cancellation.
`commitBuyIntoBody` owns body creation/merging and the shared TP/notification
sequence. No await separates body ownership, annotation and accounting commit.
The live cycle is read at accounting commit, after any merge-cancel await.
The shared step invokes synchronous finalization after log/emit, so pending-entry
updates, persistence and acknowledgement complete before its promise resolves.

The existing synchronous prefixes deliberately differ:

- Merge: replace body, annotate rows, check promotions, sync aggregate state,
  commit accounting, place TP with retry, repair stale TP size, log and emit.
- New body: push body, sync aggregate state, annotate rows, commit accounting,
  place TP, warn if placement returns false, log and emit.

A rejected TP leaves the body, row annotations and accounting committed.
Replaying that buy cannot create a second body or increment the order count;
reconciliation repairs the missing TP. `tests/buy-booking-tp-rejection.test.js`
pins this behavior through `engine._test.handleOrderFill`. The existing
buy-merge cancellation ordering tests remain unchanged.
