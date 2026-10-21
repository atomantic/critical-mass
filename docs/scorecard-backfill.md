# Scorecard historical replay

Run `node scripts/backfill-scorecard.js --from YYYY-MM-DD --to YYYY-MM-DD`
for a dry run. It computes and validates replay records and existing daily
history without writing anything. Add `--apply` to explicitly publish them.
`--step 5` controls minutes between predictions.

UpDown keeps only the newest 30 daily journals (`SCORECARD_RETENTION_DAYS` in
`src/updown/scorecard.js`) and prunes the rest at every start and daily. The
script therefore clamps `--from` to the oldest retained UTC day (today and the
previous 29) and prints when it does; older days would be deleted on the next
UpDown start. A rerun after such a prune treats completed manifest days older
than the window as satisfied rather than failing with "Completed backfill day is
missing records".

Deploy the scorecard maintenance-lock code to every UpDown writer and restart
those services before applying a replay. Older processes do not honor the lock.
The script reports its mode, lock path and resume manifest. Apply refuses a busy
lock; retry after the current writer finishes. Live appends wait up to two minutes
while publication holds the lock, then append to the newly published daily file;
an append that times out, or is still waiting when UpDown stops for a backup or
restart, is dropped and marks the scorecard journal unhealthy.
Retention pruning skips a busy lock after a few seconds and retries daily; UpDown
startup waits up to two minutes for publication before loading history; if a
replay publishes for longer than that, restart UpDown once it completes.

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
A lock whose `owner.json` names a dead process on this host (older than 5s) is
reclaimed automatically and logged. Locks with a live, foreign-host or unreadable
owner are never stolen; the gateway logs the lock path and owner
when a journal write or prune gives up waiting. Stop every UpDown process and replay
process, inspect the lock's `owner.json`, then remove the stale lock directory
and obsolete `*.tmp` files before restarting or resuming. A lock without owner
metadata must also be treated as occupied. Never clear it while a writer may
still be running. Malformed daily history fails closed; repair or restore it
while all engines are stopped before retrying.
