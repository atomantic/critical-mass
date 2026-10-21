## Fixes

- Scorecard backfill now clamps `--from` to the 30-day live retention window (shared `SCORECARD_RETENTION_DAYS`) so UpDown's startup prune no longer deletes backfilled history, and a resume treats completed manifest days older than the window as satisfied instead of throwing "Completed backfill day is missing records".
