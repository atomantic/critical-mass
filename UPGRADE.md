# Upgrade Notes

Step-by-step instructions for breaking changes that require operator action.

## Node.js minimum (22.12.0)

Update native Node.js installations to 22.12.0 or newer before upgrading
Critical Mass. Production accounting requires synchronous loading of shared
ESM modules, and the locked admin toolchain requires 22.12 or newer on the
Node 22 line. Container users should use an image with Node.js 22.12.0 or newer.

---

## Hourly Snapshots Carry Placement Intents (Unreleased)

Hourly fund-state snapshots now include each fund's `placement-intents.json`, so a
restored fund still refuses new placements until normal reconciliation resolves
an order POST whose outcome was unknown. Intents are safety metadata, not
accounting: a snapshot without the file never removes the destination's intents,
and restore merges snapshot and destination rows by intent id (a restore can add
blockers, never clear one). The intents file is staged in the same transaction
as the accounting files, so a failed restore rolls both back. Placement ownership
locks (`placement-intents.json.lock*`) are never captured or restored.

Snapshots taken before this change cannot recover intents. They are listed with
`placementIntentsCaptured: false`, and restoring one is refused (code
`placement-intents-not-captured`, before any engine stops) unless the request sets
`acceptMissingPlacementIntents: true`. Check the exchange for open or duplicate
orders on the fund before restarting it.

---

## Restores Reproduce Missing Fund Accounting State (Unreleased)

Hourly fund snapshots and full archives now reproduce the presence or absence of
the accounting files listed below for each included fund. If a snapshot predates
a file, restore removes the newer
`closed-trades.json`, `manual-trades.json`, `pending-corrective-buys.json`,
`fill-ledger.json`, `regime-state.json`, or `state.json`. Missing closed trades and
an explicit empty trade list therefore both produce zero later trades and P&L.
Missing `dry-run-state.json` writes the same reset tombstone as clearing a
simulation, preventing an old application-root simulation from being re-imported.

Only these accounting files for restored funds receive absence operations. Other
funds, rebuildable caches, and machine-local credentials are not removed. Full
archives still replace any non-excluded files they actually contain. The archive's
configured funds (including empty funds), plus fund directories carrying accounting
state after legacy layout translation, define its restored fund set. Hourly restore
affects only the selected fund.

Replacements, removals, and resets share one durable rollback transaction. Failure
or interrupted startup recovery restores previous bytes and permissions. New
journals use version 2; this build still recovers existing version 1 journals.
Finish recovery with this build before switching back to an older build that does
not understand version 2 journals.

### Recovery limits to check before restoring

These file replacements do not rewind orders or fills at the exchange. Hourly
snapshots made by this version capture `placement-intents.json` when present,
and full archives preserve it too. Older hourly snapshots lack that evidence and
cannot recover a lost fund's unresolved placement blockers; restoring one requires
the acknowledgement described above. Neither recovery path establishes the current
exchange outcome. Preserve available intent records and reconcile unresolved
submissions against the exchange before resuming trading; do not treat any
snapshot as proof of the current exchange state.
See [issue #1810](https://github.com/atomantic/critical-mass/issues/1810).

An interrupted DCA import is another recovery boundary. A pending
`.dca-import-journal.json` would replay newer accounting over an older restore, or
block the next fund start when the restored bytes differ, and a snapshot taken
under it would capture a partially published import without its journal. So
hourly snapshots refuse (`dca-import-pending`) while any configured fund has a
pending import, publishing and pruning nothing; hourly and full restores refuse
before stopping any engine when a fund they would restore has one; and a full
archive carrying a journal refuses (`archive-dca-import-pending`). Funds the
restore does not touch are not checked. Finish ordinary import recovery — start
the fund or retry the import — then retry. Preserve the journal and accounting
files; deleting the journal to bypass recovery is not a repair. Verify uncertain
recovery on an isolated copy before using it on a live fund
([issue #1809](https://github.com/atomantic/critical-mass/issues/1809)).

---

## Rollback Over Newer Trading Data Is Not Supported (Unreleased)

Running an older Critical Mass build over trading data written by a newer one is
**unsupported**. Some fields change meaning between releases (for example the fill
ledger's `consumedBy` and `bodyBookedSize` markers, first shipped in v2.26.0, and the
UpDown paper book's `contractSizeBtc`). An older build keeps those fields but does
not maintain them, so a later re-upgrade would misread what it left behind: sold
quantity counted as held again, booked fills treated as unbooked, paper P&L rescaled
twice.

`fill-ledger.json` rows and `updown-state.json` now carry a `formatVersion`. A build
that finds a version newer than it understands refuses to start with a "written by a
newer build" error and leaves the file untouched (a live ledger reload keeps its
in-memory state instead). Files with no version are treated as the oldest format and
load normally.

To roll back, restore a backup taken **before** the upgrade rather than pointing the
older image at the current `data/` directory. Builds older than this change cannot
check the marker, so the guard only protects rollbacks from this release onward.

---

## Base Defaults Stay Pinned Across Upgrades (Unreleased)

Gateway and engine startup now record the full parsed base configuration in
`data/config-base.snapshot.json`. Before loading fund settings, a later startup
compares that snapshot with the current root `config.json` (or the image's
`config.example.json`). Changed or removed defaults absent from `data/config.json`
are pinned to their previous values in that override file. Each pin produces a
warning naming the setting and its old/new defaults; credential values are redacted.
Explicit overrides win, unchanged values are untouched, and newly introduced
settings receive their new defaults. Arrays are treated as a single setting.

The first startup only records a baseline. **It cannot recover defaults from an
older image that never wrote a snapshot.** Check risk limits on this first upgrade
against your previous configuration or backup. Subsequent upgrades preserve them.
A later settings save retains explicit pins, even if a future base temporarily
matches their value.

To adopt a new default for one setting, stop the gateway and then the engines
using the ordered shutdown below, remove that leaf from `data/config.json`, and
restart the engines followed by the gateway. Do this **after** the upgrade's first
successful startup has advanced the snapshot; otherwise reconciliation will pin
that setting again. Keep the snapshot intact. For example, remove only
`regime.maxDrawdownPercent` inside the relevant exchange/pair override to adopt
its current base value. Other settings remain selected.

Snapshot and override writes are atomic, and concurrent startup/settings writes
are serialized by `data/.config-write.lock`. Settings writes re-read
`data/config.json` after taking the lock, so concurrent engine and gateway updates
to different keys all persist. A crash may leave that lock directory.
Startup then refuses to proceed after a bounded wait. Stop **all** Critical Mass
writers, inspect/repair the configuration files, and remove only the empty lock
directory before restarting. Locks are never stolen merely because they are old.
A corrupt override or snapshot blocks startup without replacing either file.
An unreadable base skips reconciliation and retains the existing config reader's
last-good/cold-start failure behavior.

The snapshot is private configuration (0600 when created) and can contain secrets.
Application backup archives continue to carry the non-secret effective settings
in their existing manifest, excluding the raw base snapshot and lock artifacts.
Restore reconstructs the override and records the destination base snapshot in
the same rollback transaction. A foreign snapshot in an archive is replaced with
the destination base, so it cannot repin source defaults after restoration.
Whole-volume filesystem backups should retain the snapshot with the data directory
and protect it as carefully as `data/config.json`.

---

## Dry-Run State Moves Into the Data Directory (Unreleased)

**Affects dry-run funds only. No operator action required.**

Dry-run simulation state used to be written to a single `dry-run-state.json` at the application root — outside `data/`. That location is not on the Docker/Umbrel volume (`docker-compose.yml` mounts only `/app/data` and `/app/logs`), so a container recreate during an update silently discarded every dry-run fund's simulated ladder, filled orders and P&L. It was also never included in a backup archive, and all three engine processes read-modify-wrote the same file with a non-atomic write, so concurrent saves lost each other's updates.

It is now a per-fund artifact like every other piece of state:

```
data/<exchange>/<pair>/dry-run-state.json
```

- **Survives upgrades**: it lives on the mounted data volume, so `docker compose down && docker compose up` (or an Umbrel container recreate) keeps it.
- **Included in backups and restores**: `createBackup` captures the per-fund simulation file, and restore replaces its bytes. Resuming the simulation still follows the age check below.
- **Atomic and per-fund**: every write is a temp-file + rename through `atomicWriteSync`, and each engine process only ever writes the funds it owns — no cross-process merge, no lost updates, and a torn write can no longer take every fund's state down at once.

### The one-time import

The first time a dry-run fund reads its state after the upgrade:

1. If `data/<exchange>/<pair>/dry-run-state.json` already exists, it is used and nothing is imported.
2. Otherwise, if a legacy root `dry-run-state.json` exists, that fund's slot is copied out of it into the new location. Both key forms the old writer produced are recognized — the composite `exchange::pair` and the bare `exchange` used by pre-multi-pair installs.
3. The legacy root dry-run file is **never modified or deleted**. It stays exactly where it is as your fallback copy. Key migration is different: it copies legacy `keys.json` to `data/coinbase-keys.json` and renames the root file to `keys.json.migrated` so a deleted key cannot be re-imported on restart. Protect that renamed file as a credential. Delete the legacy dry-run file yourself once you're satisfied the funds came across.

The import is idempotent: it only runs when a fund has no file of its own, so it can never overwrite state an engine has already written, and resetting a dry-run fund does not resurrect its pre-upgrade state from the legacy file.

If the legacy file is unreadable or carries an unexpected version, it is left untouched and the affected funds simply start fresh — the same behavior as before, minus the data loss.

### Simulation age limit

On startup, the dry-run loader rejects a simulation whose `savedAt` is more than
seven days old, or has no usable timestamp, and starts a fresh simulation. This
also applies to files recovered from a full archive, an hourly snapshot, or the
legacy root import. Restore preserves `savedAt`; it does not refresh the simulation's
age. The loader leaves the rejected bytes on disk, but subsequent simulation saves
can replace them. Preserve the recovery point before starting the fund if you need
to inspect an older simulation; restoring its file is not a promise that it will
resume. See `src/dry-run-state.js` and `src/regime-state-persistence.js`.

---

## Multi-Pair Funds (Unreleased)

**Affects everyone.** This release reorganizes on-disk state into per-fund subdirectories so a single exchange can host multiple trading funds (e.g. BTC-USDC and ETH-USDC on Coinbase). The migration runs automatically the first time an engine starts after the upgrade. Stop the Critical Mass processes in the order below before pulling the new version.

### TL;DR

```bash
pm2 stop critical-mass                                   # 1. drain the gateway first
pm2 describe critical-mass                               #    wait until status is "stopped"
pm2 stop critical-mass-coinbase critical-mass-gemini critical-mass-cryptocom critical-mass-ui   # 2. then stop engines (and dev UI, if running)
git pull                                                 # 3. pull this version
npm ci && npm --prefix admin ci && npm run build         # 4. install both locked dependency sets, rebuild the admin UI
pm2 start ecosystem.config.cjs --only critical-mass-coinbase,critical-mass-gemini,critical-mass-cryptocom   # 5. engines first
pm2 logs critical-mass-coinbase --lines 50 --nostream    # 6. inspect startup/migration errors (repeat for each engine you run)
pm2 start ecosystem.config.cjs --only critical-mass      # 7. then the gateway
pm2 start ecosystem.config.cjs --only critical-mass-ui   # 8. development UI only, if you use it
```

For every native upgrade, refresh both projects from their committed lockfiles, even when only the root version changes. The production UI build needs the admin project's build dependencies.

Order matters. The gateway drains its admitted commands before it disconnects from the engines (up to 30 seconds; its PM2 `kill_timeout` is 35 seconds), so it must be fully stopped **before** any engine stops. Stopping the whole ecosystem at once, or `pm2 restart all`, cannot provide that ordering: PM2 applies multi-process actions concurrently, so an engine can go away while the gateway still has a command waiting on it, and that command returns HTTP 503 (`IPC connection closed`). `pm2 restart all` also touches unrelated applications sharing your PM2 daemon. Always name the Critical Mass processes as above. Keep any supervisor stop grace longer than the gateway's 35 seconds; see [docs/pm2-architecture.md](docs/pm2-architecture.md) for the drain and deadline details.

Starting engines first does not prove fund readiness. PM2's `online` status can
precede migration, and `Pair migration complete` is logged only when files were
moved; an already-migrated install need not emit it. Engines finish synchronous
recovery and migration before admitting IPC commands, but individual funds
auto-resume asynchronously. After starting the gateway, sign in and inspect each
expected running fund in the dashboard or authenticated `GET /api/health`:
`funds.<exchange>.<pair>.startup` exposes `starting`, `retrying`, or `blocked`
starts, including the error and next retry time. Resolve those states before
issuing fund mutations. Intentionally stopped or disabled funds need not become
running. See [Gateway health](docs/pm2-architecture.md#gateway-health-get-apihealth).

If you only run some exchanges, list only those engine names. The process names and `--only` selectors come from `ecosystem.config.cjs`.

### Why

The system now treats a "fund" as a `(exchange, pair)` tuple instead of an `exchange` alone. State files move from `data/<exchange>/state.json` (etc.) into `data/<exchange>/<pair>/state.json` so multiple funds on the same exchange don't collide. The per-fund subdirectories also hold the regime state, fill ledger, chart buffer, transactions log, and the regime-engine-running auto-resume flag. The long-term candle store and the backtest price caches stay at the exchange level — they're shared context (not per-fund state) and their filenames already carry the productId.

### What the migration does

For each configured exchange (`coinbase`, `gemini`, `cryptocom`):

1. Detects the legacy layout by looking for per-fund files at `data/<exchange>/`.
2. Reads the exchange's `productId` from `config.json` to determine the default pair name (e.g. `BTC-USDC` for coinbase, `BTCUSD` for gemini, `CRO_USD` for cryptocom).
3. Moves these per-fund files into `data/<exchange>/<defaultPair>/`:
    - `state.json`, `regime-state.json`, `fill-ledger.json`
    - `transactions.tsv`, `chart-data-buffer.json`
    - `optimizer-cache.json`, `pending-corrective-buys.json`
    - `regime-engine-running.json` (the auto-resume flag — moves so resume still works)
    - `dry-run-state.json`
    - `closed-trades.json`, `manual-trades.json`, and `placement-intents.json`
    - All `.backup-*` files associated with the above
4. Migration is idempotent — running it twice is a no-op.

Note: `long-term-candles-*.json` is **not** moved — it's read and written at the exchange level (the productId is already in the filename, so funds on the same exchange don't collide). An earlier release incorrectly relocated it into the pair subdirectory; the migration now also does a one-time move-back for any install stuck in that state, skipping (and logging) the move if a rebuilt exchange-level copy already exists.

The same applies to `*price-cache-*.json` (e.g. `btc-price-cache-5min.json`, `btcusd-price-cache-1hour.json`). These are **not** moved either — `getCacheFile` in `backtest-engine.js` has always resolved them at `data/<exchange>/`, and `GET /api/:exchange/backtest/prices` is exchange-scoped with no pair at all. An earlier release of this migration did relocate them, which stranded the entire accumulated candle history: the backtester logged `No cached data` and re-fetched the full range from the exchange REST API in 300-candle batches on every cold interval, and any depth older than the exchange's retention window was gone for good (backups exclude `*-price-cache*.json`, so no archive held a copy either). The migration now does a one-time un-stranding for any install in that state, and it runs even on installs that are otherwise fully migrated.

Unlike the candle store, a price cache with copies on **both** sides is **merged**, not skipped — the stranded copy is usually the deeper one (months of history) while the exchange-level copy was rebuilt from whatever the exchange still serves, so discarding either would lose candles. The two `prices` arrays are unioned by timestamp (exchange-level rows win a collision, since they're the fresher generation), written through an atomic temp-file-plus-rename, and only then is the stranded copy deleted — a crash in between simply re-merges to the identical union on the next start. A cache file that doesn't parse, or that carries no `prices` array, is left exactly where it is and logged rather than merged. Re-running is a no-op.

Separately, an earlier release of this same multi-pair migration moved `transactions.tsv` into the pair subdirectory above, but its reader/writer (`getLogFile`) had not yet been updated to look there — it kept resolving `data/<exchange>/transactions.tsv` and quietly recreated an empty file there on the next trade, so the Transactions page appeared to lose all history predating the upgrade. `getLogFile` now resolves the per-fund path like every other per-fund file, and the migration does a one-time reconciliation of any install left with both copies: if only the exchange-level file exists, it's moved into the pair directory; if both exist, the exchange-level file's rows (which are all necessarily newer than the move) are appended onto the per-fund file and the exchange-level copy is deleted. This reconciliation runs even on installs that are otherwise already fully migrated, and is idempotent — running it again is a no-op.

### Safety guarantees

- Each engine claims its configured local IPC port before it runs recovery or the migration, so a second engine process for the same exchange on that port fails without touching fund data. This is exclusion by configured port only. The migration does not check for other writers (for example an engine configured on a different port, or a manual script), so follow the stop order above to make sure nothing else is writing the data directory.
- If the migration fails for any reason, the engine process logs an error and `process.exit(1)` — it will NOT silently continue with mixed-layout state.
- The migration uses `fs.renameSync` (atomic move) and refuses to overwrite existing files at the target path. Most conflicts are skipped, but if `state.json`, `regime-state.json`, `fill-ledger.json`, `closed-trades.json`, `manual-trades.json`, or `placement-intents.json` exists at both the exchange and fund levels, the engine refuses to start and names both paths. For accounting files, preserve the copies and identify the authoritative generation before restarting. For placement intents, preserve both copies and reconcile every unresolved submission against the exchange before restarting; selecting just one copy could discard a blocker.
- The migration resumes after an interruption: it runs whenever any per-fund file is still at the exchange level, so a crash after the state files moved but before `fill-ledger.json` did finishes moving the ledger on the next start instead of leaving the fund on an empty ledger.
- It also cleans up empty pair subdirectories that the API server might have accidentally created before the engine ran (e.g. from gateway requests using `?pair=` before migration completed).

### After upgrading

- The admin UI Overview shows one card per fund. Existing single-pair installs see exactly one card per exchange (matching the old behavior).
- The **+ Add Fund** button in the Overview header lets you create a new pair on any existing exchange. New funds start `enabled=false` and `dryRun=true` for safety — review the regime config in the new fund's Config tab before enabling.
- All existing API routes (e.g. `/api/coinbase/regime/status`) continue to return data for the exchange's default fund. Routes accept an optional `?pair=ETH-USDC` query parameter to target a non-default fund.

### Restoring an archive taken before this release

Backup archives store data files at the paths they had on the source machine, so an archive taken before this release holds its per-fund files at `data/<exchange>/` — where nothing reads them any more. Restore now **translates the archive into the per-fund layout while it is still staged**, before a single destination file is written:

- Per-fund files at `<exchange>/` are relocated into `<exchange>/<pair>/`, so a recovery lands where `resolveFundDataDir` reads it even when the destination has already migrated. (Before this, the restore reported success while the engine kept running on the pre-restore state.)
- The pair comes from the archive's own configuration manifest when it carries one, and from this machine's default fund for a manifest-less data-only restore.
- If neither names a fund for an exchange the archive carries, the restore is **refused before any destination is touched** (`legacy-layout-unresolvable-pair`) rather than applying a half-translated tree. Configure the fund, then retry.
- The translation is part of the same all-or-nothing transaction as every other replacement, so a rollback reverts the relocated files too.
- An archive with both exchange-level and per-fund placement-intent files is refused before stopping engines. Preserve both copies and reconcile unresolved submissions against the exchange before restoring.
- The restore confirmation screen (Settings → Backups) discloses the `exchange → pair` mapping it would apply before you commit to it.

An archive already in the per-fund layout restores exactly as it does today.

### Backwards compatibility

- **Config file**: untouched. The legacy flat format (`exchanges.coinbase.productId`, `.regime`, etc.) keeps working. When you add a second fund via the Add Fund modal, the exchange block is converted to the new nested `pairs` map — single-fund exchanges stay flat.
- **State files**: migrated automatically as described above.
- **Backup archives**: pre-release archives are relocated into the per-fund layout on restore (see above).
- **API**: all existing routes work unchanged for default-pair access.
- **PM2**: still one process per exchange. Multiple funds share the same engine process and the same API key set.

### Fund tooling and current limits

- API key isolation per fund (all funds on an exchange share the exchange's API key).
- A UI for moving capital between funds.

Backtest, optimizer, charts, and transactions now follow the selected fund. Their
per-fund API routes accept `?pair=` for a non-default fund; the optimizer also
keeps caches and progress events scoped to that fund. API keys remain shared by
every fund on the exchange: changing or deleting keys from any fund's API Keys
page affects the whole exchange.

---

## Backup Archives Carry Their Configuration (v2.24.1)

**Affects anyone restoring a backup onto a different machine or a fresh clone.**

### Why

`data/config.json` stores only the *difference* between your effective configuration and the machine-local base `config.json` (or, on a fresh clone, the shipped `config.example.json`). If your funds are defined in the base file — the normal native-install layout — then saving an unchanged configuration produces an empty override, and a backup of the data directory carried **no fund identity at all**.

Restoring such an archive onto a fresh clone recovered the state files of, say, `coinbase/ETH-USDC` with a `1234` allocation, while the destination's effective configuration still said `BTC-USDC` at `10000`. The original fund was stranded and its capital settings were lost.

### What changed

- Archives now contain **`backup-manifest.json`**: a versioned, schema-allowlisted snapshot of the *effective* non-secret configuration — every configured pair identity, its capital settings and its full regime (strategy) block, already materialized so it depends on no base file.
- Restore validates the manifest, reconstructs `data/config.json` against **the destination's** base config, and verifies in memory that loading the result reproduces the archived funds — all **before** a single destination file is written.
- Secrets never enter the manifest: `notifications` (Telegram bot token) and `sentinel` (AI classification credentials) are excluded by allowlist, and a restore leaves the destination's own copies of both untouched. API keys (`*-keys.json`) are excluded from the archive as before.
- The restore confirmation screen (Settings → Backups) shows a pre-flight compatibility report listing exactly which funds the archive would restore.

### Restoring an OLD archive (taken before this release)

Old archives have no manifest, so they cannot be made portable on their own. Restore refuses them by default rather than silently letting the destination's defaults win. You have two options:

**Oldest flat-layout archives are translated.** Archives with accounting files
directly at the data root (`state.json`, `transactions.tsv`, `optimizer-cache.json`,
`btc-price-cache*.json`) predate exchange namespacing. Restore maps that root to
`coinbase`, places per-fund files in `coinbase/<pair>/` (the pair comes from
`legacyBaseConfig` when supplied, otherwise this machine's coinbase fund), and
leaves no root file behind to block the next startup. The restore confirmation
screen lists each translation. Restore refuses, before writing anything, when
no coinbase fund can be resolved or when the archive carries two differing
generations of the same file (for example a root `state.json` and a different
`coinbase/<pair>/state.json`); remove the stale copy from the archive and retry.

1. **Recommended — supply the source machine's base config.** Copy the *source* install's root `config.json` and pass it to the restore API as `legacyBaseConfig`:

   ```bash
   curl -X POST http://localhost:5570/api/backups/backup-2026-01-01T00-00-00.zip/restore \
     -H "Authorization: Bearer $OPERATOR_PASSWORD" \
     -H 'Content-Type: application/json' \
     -d "{\"legacyBaseConfig\": $(cat /path/to/source/config.json)}"
   ```

   Set `OPERATOR_PASSWORD` to your operator password in your local shell first (and use your configured gateway URL if it differs). The archive's stored override is merged onto that base to recover what the source machine actually ran.

2. **Data-only restore.** Tick *"Restore data files only and keep this machine's current fund configuration"* in the restore dialog (or send `{"acceptLegacyWithoutBase": true}`). Your state files are recovered, but **you must configure the destination's funds yourself** so their pair identities match the restored state directories.

Archives created by this release and later need neither step.

### Future archives

An archive whose **manifest version** is newer than the running build is rejected with an actionable error and no destination changes — upgrade critical-mass before restoring it.

Inside the manifest, the configuration snapshot carries **two** markers, and they answer different questions:

| Marker | Meaning | Bump it when |
| --- | --- | --- |
| `version` (`CONFIG_SNAPSHOT_VERSION`) | The snapshot's *shape*. A mismatch is fatal — the reader cannot interpret the payload at all. | A field is **removed**, **re-typed**, or **moved**. |
| `fieldRevision` (`CONFIG_SNAPSHOT_FIELD_REVISION`) | How many fields the snapshot allowlists carry. | A field is **added** to `DEFAULTS`, `REGIME_DEFAULTS` or `GLOBAL_DEFAULTS`. Never bump `version` for this. |

**The rule for contributors: adding a config field bumps the field revision, never the snapshot version; removing or re-typing one bumps the version.** A test asserts the field-revision constant equals the combined allowlist size, so adding a key without bumping it fails CI.

This makes restoring *across* builds work in both directions:

- **Older archive → newer build.** Its fields are a subset of what this build knows; it restores unchanged.
- **Newer archive → older build** (the multi-machine and rollback cases). Because the archive's field revision is strictly greater than the running build's, a setting the build has no concept of is **ignored rather than fatal**: it is dropped from the reconstructed configuration, the machine keeps its own default for it, and the restore dialog lists the dropped settings as a pre-restore warning (`droppedFields`). The restore itself proceeds. Upgrade the destination first if you need those settings applied.

Tolerance stops at the allowlist: a dropped field is **never** written to `data/config.json`, so a crafted archive still cannot smuggle a credential in through an unknown key. At an equal or older field revision an unknown key remains a hard rejection, as before.

---
