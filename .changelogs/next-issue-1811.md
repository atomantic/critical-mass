## Improvements

- Restore refuses accounting payloads the readers would reject (issue #1811): full-archive and hourly-snapshot preflight (before stop-all), the staged generation immediately before apply, and hourly snapshot publication apply the fill-ledger, fund-state and UpDown readers' format rules (non-array or malformed ledgers, newer format markers, invalid JSON, non-object state) through a shared side-effect-free validator.
- A refusal leaves every live file untouched, publishes no snapshot and prunes no recovery point. Unversioned legacy and fee-only ledgers still restore, with no quarantine or normalization.
