# Unreleased — Backups exclude the scorecard maintenance lock

## Bug Fixes

- Backups no longer capture the UpDown scorecard maintenance lock, and restoring an archive skips it, so a restore taken during a scorecard backfill no longer leaves UpDown and journal appends waiting on a lock no process owns.
