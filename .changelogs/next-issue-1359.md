## Improvements

- Consolidated APY start-of-tracking backfill into one writer (`backfillEngineStart` in `apy-calculator.js`) shared by the engine's ledger backfill and `initializeApyTracking`, and merged the duplicated "restored" branches. Behavior is unchanged; the APY denominator fields now have a single place to change.
