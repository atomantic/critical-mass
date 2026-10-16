# Development environment audit, 2026-10-16

The pre-fix baseline was `85c3c84c88060ef535fbd01cbb74630e76aa18ca`.
Measurements began on October 15 UTC and finished on October 16. The audit
used Node 20.20.2, synthetic fixtures, and the documented development commands.

## Discovery and ranking

`git ls-files` supplied 692 eligible first-party text files. Every eligible
file was included in one category signal scan for temporary paths, process
creation, timers, listeners, watchers, caches, home writes and Git configuration.
Roots: root files (21), `.github` (4), `admin` (132), `docker` (2), `docs` (12),
`engines` (3), `scripts` (71), `shared` (7), `src` (148), `tests` (289), and
`umbrel` (3). Lockfiles, the generated quality snapshot, release-note archives,
dependencies, binary assets and build/data output were excluded.

Risk ranking before implementation:

| Rank | Candidate | Measurement, reach and decision |
| --- | --- | --- |
| 1 | `scripts/test.js`: surviving descendants, severity 5, high confidence | A successful injected parent left one owned process and one ephemeral listener alive after the runner deleted its root. Every `npm test` uses this supervisor. Fixed with group termination before fixture removal. |
| 2 | `scripts/dev.js`: unbounded shutdown, severity 4, high confidence | Two SIGTERM requests over 1,200ms left a stubborn child and launcher alive; source had no later deadline. Added a 40-second grace period, longer than the gateway's 30-second drain, followed by group SIGKILL. |
| 3 | Recovery fixtures: production backoff, severity 4, high confidence | The orphaned-entry and startup terminal-entry groups took 16,328.67ms and 6,577.01ms. Empty/stub failures enter the real two-second fallback. Tracked separately in [#1119](https://github.com/atomantic/critical-mass/issues/1119). |
| 4 | `scripts/test.js`: forwarded options, severity 4, high confidence | `npm test -- --test-name-pattern=…` exited 1 because Node treated the option as a filename after 281 test paths. Moved options before file paths and added an actual CLI regression. |
| 5 | `admin/vite.config.js`: shared cache/idle cost, severity 0, high confidence | An isolated 60-second UI start produced a finite 42-file, 30,867,640-byte cache. CPU time stayed at 1.87s from second 10 to 55. No persistence or idle churn reproduced; documented worktree dependency links were preserved. |
| 6 | `scripts/dev.js`: sibling continues after failure, severity 0, high confidence | Closed issue #496 and existing tests explicitly preserve independent child lifetimes, including after spawn failure. Retained that contract. |

Severity and recurring workflow impact put process ownership ahead of easier
option placement. The existing fixture cleanup, fill-retry clock and batched
ledger fixes from #1017–#1019 were already present; their closed issues and
merged PRs were checked rather than duplicated. The all-state inventory had
418 issues; active issues and PRs were checked again before filing.

## Measurements and fixes

Before/after snapshots covered both system temp locations, process tables,
listening TCP ports, checkout status, Git configuration, named home dotfiles and
npm/Vite cache metadata. No credentials, live data, engines or production
listeners were changed. Ports 5570/5571 were occupied, so the UI ran from a
credential-free disposable copy with a local dependency/cache directory and an
ephemeral loopback port. The combined gateway was not started.

The ordinary baseline test invocation left no attributable temp root, child or
listener. Legacy prefix counts across the two temp locations remained
`race2-` 300 → 300, `tags-` 201 → 201, `mds-corrupt-test-` 80 → 80, and
`cm-test-` 11 → 11; `route-error-handling-` was 0 → 0. Those existing entries
were preserved. Concurrent agents produced unrelated after-minus-before entries;
they were not attributed to this run or removed. Named Git/home configuration
files were unchanged. npm wrote its normal diagnostic logs; later commands used
an audit-owned log directory.

During post-fix validation the shared Git config gained another checkout's
branch-tracking metadata, while this task branch still had no tracking entries;
no test or audited launcher writes Git config. The admin build touched the
existing `.vite-temp` directory but retained no new config-temp files. These
shared metadata changes were recorded rather than attributed to test leakage.

Fault injection exposed defects beyond the ordinary clean run. Both launchers
now share `scripts/lib/process-group.js`: after their direct child closes, they
kill and wait for remaining members of that owned POSIX group. The test runner
retains its root and reports failure if termination cannot be confirmed. Dev
shutdown has a bounded grace period; siblings retain independent lifetimes.

Independent lifecycle review also reproduced a dev parent returning success
while an ignored-stdio descendant survived, severity 5. That is fixed and covered
for success, nonzero exit and interruption. Review then caught a signal arriving
during asynchronous close that could create an obsolete escalation timer,
severity 4; running membership is now removed before cleanup awaits, and a
regression checks that no timer fires afterward. This latter defect was caught
in the working patch and is excluded from the pre-fix score.

The baseline completed in 323.28s with 4,597/4,598 passing. Its one failure was
the pre-existing one-millisecond maintenance-expiry fixture racing real Date
before installing its mock. That test-quality failure is recorded as severity 3
in [#1120](https://github.com/atomantic/critical-mass/issues/1120), without changing
production maintenance or broadening this PR into accounting/clock migration.
At the conservative ten-runs/day cadence previously evidenced in #1017, the
two deferred recovery groups alone spend about 3.8 minutes/day. Process-leak
costs are conditional on the reproduced failure modes, not a claim that each
ordinary full run leaks.

For legacy cleanup, an owner should first confirm an entry is unused, then
remove only that explicitly selected fixture, for example
`python3 -c 'import shutil,sys; shutil.rmtree(sys.argv[1])' "$CONFIRMED_UNUSED_FIXTURE"`.
This audit did not perform legacy cleanup. Its own fixture processes, UI copy,
cache and newly created temporary entries were removed.

## Validation and review

- Post-fix documented `npm test`: **4,605 passed, zero failed/skipped/cancelled**, 303.12s.
- Focused launcher, runner and environment suites: **35 passed**, including real listeners, watch descendants, concurrent roots, signals, forced shutdown, option selection and cleanup ordering.
- `npm run build`, Node 20 syntax checks for changed scripts, and `git diff --check` passed. The existing large-chunk build advisory remains.
- Independent lifecycle review: both reproduced issues resolved; its signal-during-cleanup probe completed with no descendant, listener, signal handler or delayed escalation warning left behind.
- Host self-review covered option placement, exit/error handling, fixture copying, default grace timing and documentation. The focused lifecycle lens was selected because process closure, timers and cleanup cross modules. Other lenses were not separately delegated.
- Convention encoding: shared process-group cleanup and comments explain why closed stdio is insufficient; lifecycle and actual-CLI regressions enforce those boundaries.

## Assessment and limits

The pre-fix category score is **78/100**, worst severity **5/10**, broad signal
coverage with medium assessment confidence: localized supervisor defects and
unusable filtered invocations coexist with effective ordinary fixture cleanup,
finite UI caching and low idle cost. Fixing or filing findings does not raise
that pre-fix score or certify every file.

Deep review was bounded to `scripts/test.js`, `scripts/dev.js`, the process-group
helper, their lifecycle/environment tests, fixture isolation and live-fund guards,
Vite configuration, performance fixture ownership, runtime paths/configuration,
gateway shutdown, recovery/backoff callers, release tag cleanup and relevant
history. The rest of the 692-file inventory received signal scanning, not
substantive file-by-file review. Docker smoke tests, trading engines, real
exchange paths, Windows process-tree behavior and a combined gateway start
were not exercised. A process that deliberately creates a different session or
group, SIGKILL of the supervisor, and power loss remain outside these orderly
same-group cleanup guarantees. Investigation stopped after the highest-value
supervisor fixes, measured UI behavior, independent review and tracker-backed
disposition of the remaining supported findings.
