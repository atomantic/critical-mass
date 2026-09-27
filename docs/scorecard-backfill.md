# Scorecard historical replay

Run `node scripts/backfill-scorecard.js --from YYYY-MM-DD --to YYYY-MM-DD`
for a dry run. It computes and validates replay records and existing daily
history without writing anything. Add `--apply` to explicitly publish them.
`--step 5` controls minutes between predictions.

Deploy the scorecard maintenance-lock code to every UpDown writer and restart
those services before applying a replay. Older processes do not honor the lock.
The script reports its mode, lock path and resume manifest. Apply refuses a busy
lock; retry after the current writer finishes. Live appends wait while publication
holds the lock, then append to the newly published daily file.

Each day is staged beside its destination, flushed, validated and renamed
atomically. The original bytes are retained in a hidden `.backfill-*.backup`
file before replacement. Hidden `.backfill-*.manifest.json` files record completed
days, keyed by the generated replay contents. Rerunning the same command and
candle inputs resumes those days without duplicates. If interruption happens
between a day replacement and its manifest update, semantic record keys make
that day safe to retry. Changing replay inputs starts a separate manifest.
These backup and manifest files are not daily journals and are not automatically
pruned; retain them until the replay has been checked.

An interrupted process can leave `.maintenance-lock/` and hidden staging files.
Locks are never automatically stolen. Stop every UpDown process and replay
process, inspect the lock's `owner.json`, then remove the stale lock directory
and obsolete `*.tmp` files before restarting or resuming. A lock without owner
metadata must also be treated as occupied. Never clear it while a writer may
still be running. Malformed daily history fails closed; repair or restore it
while all engines are stopped before retrying.
