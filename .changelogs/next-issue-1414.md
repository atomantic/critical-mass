## Fixes

- Reclaim the scorecard maintenance lock automatically when its owner process is dead (same host, past a short grace period) instead of dropping every scorecard write until an operator deletes the lock. Live, foreign-host and unreadable owners are still never stolen.
