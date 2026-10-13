# Cognitive load audit — 2026-10-13

## Scope and method

Pre-fix baseline: `cdb5717`. Inventory: 713 tracked files; 646 eligible first-party
code files, all included in the signal scan. Roots: `src` (148), `admin` (127),
`tests` (287), `scripts` (70), `shared` (6), `engines` (3), repository root (4),
and `umbrel` (1 empty shell file). `docker/pm2` contains only package manifests.
Eligibility includes JS/JSX/CJS/MJS/TS/TSX, shell, CSS, and HTML. Images, SVGs,
lockfiles, JSON/YAML manifests, documentation, dependencies, and build output
are excluded. Generated/dependency directories were not traversed.

Discovery used `git ls-files`, a Python text scan of every eligible file,
relative-import resolution, `git log -100 --format= --name-only`, `rg`, and
bounded source/test/history reads. Signals count branch-like tokens, fallback
operators (`||`, `?.`, `??`), flag-like names, indentation, imports, and recent
changes. These include comments/JSX and are navigation aids, not complexity
measurements or findings. Fan-in below counts distinct static importers,
including tests; churn counts appearances in the last 100 commits.

Started with `index.js`, `server.js`, `engines/coinbase-engine.js`, and the
high-fan-in configuration/state modules. Followed live fill callbacks, polling,
startup recovery, buy serialization, fill gates, merge cancellation, ledger
annotation, and cycle recovery. Read `CLAUDE.md`, `docs/pnl-architecture.md`,
relevant tests, and file history before choosing the change.

## Ranked candidates

| Rank | Path and measured signals | Impact, reader cost, and decision | Confidence |
| --- | --- | --- | --- |
| 1 | `src/regime-engine.js`: 1,232 branch-like tokens, 623 fallback operators, 377 flag-like names; 36 importers; 13 recent changes | Fill booking coordinates live bodies, retry guards, entry counters, and ledger cycle attribution. A misleading local counter helper hides effects and the distinction between pre-await ownership and commit-time cycle state. Highest verified actionable cost; fix below. | High for the selected slice |
| 2 | `src/fill-ledger.js`: 396 branch-like tokens, 215 fallbacks; 28 importers; 0 recent changes | Synthetic reconciliation changes the incoming row's meaning from reported execution to excess quantity while returning a separate coverage plan. All ingestion/recovery consumers depend on this financial contract. Verified deferred reader debt below; inactivity does not reduce its importance. | High for the cited transition |
| 3 | `src/manual-trade-import.js`: 178 branch-like tokens, 118 fallbacks; 6 importers; 2 recent changes | Manual-buy recovery must reconcile store intent, ledger ownership, live bodies, and persisted/retired bodies. Traced importer wiring and resumed intent paths. Existing `findCommittedBody`, `resumeBodyIntent`, and `commitBodyIntent` already name the relevant transitions; no further bounded readability defect established. | Medium |
| 4 | `src/order-executor.js`: 187 branch-like tokens, 131 fallbacks; 9 importers; 1 recent change | Cancellation combines terminal status and cumulative execution: `filled: false` can coexist with `filledSize > 0`. Challenged against callers, partial-cancel tests, and history. Existing `classifyBodyTpCancellation` already expresses this distinction in critical body-merge consumers. No new behavioral defect established; a wider public result redesign is not justified here. | Medium |
| 5 | `src/config-utils.js`: 91 branch-like tokens, 72 fallbacks; 104 importers; 0 recent changes | Highest fan-in makes precedence/layout changes consequential. Inspected loading, normalization, and fund mutation plus tests/history. Legacy/nested compatibility and tombstone handling are already named and documented; generic fallbacks alone do not justify a refactor. | Medium |

Bounded source passages reviewed: the entry points above, `src/regime-engine.js`,
`src/fill-ledger.js`, `src/order-executor.js`, `src/manual-trade-import.js`,
`src/config-utils.js`, `src/state-tracker.js`, `src/cancellation-result.js`,
and the scoring entry section of `src/updown/signal-engine.js`. Test passages
reviewed included cycle-turnover, incomplete-fill recovery, ledger counting,
and order-executor cancellation contracts. Other inventory received signal
scanning only, except dependencies followed by the executed integration tests.

Other signals included `src/state-tracker.js` (54 importers),
`src/updown/signal-engine.js` (227 branch-like tokens), and
`admin/src/components/RegimeDashboard.jsx` (320 fallbacks). Their shape alone is
not a reader-cost finding. UI nesting and function/file size belong to sibling
categories. No tracker issue was created.

## Finding 1 — misleading, implicitly captured buy-accounting commit (7/10)

Pre-fix `src/regime-engine.js:5526`: `const commitBuyCounter = () => {`.
Despite the name, the closure updates `lastEntryPrice`/`lastEntryTime`, counts a
buy, reads the live cycle, and calls `fillLedger.updateFillCycleId` for booked
rows (`src/regime-engine.js:5566` before the fix).

To safely change one line, a reader had to retain all of these facts:

- Ownership and bookable rows are determined before merge-related awaits;
  advancing partials must not count the same order again in the same cycle.
- The cycle must be read when committing, after those awaits; it may have
  changed since ingestion, including from null on the first cycle.
- Recovered rows can predate even this pass's ingestion cycle.
- The body must own the buy before accounting commits, with no intervening
  await; TP placement can fail after that ownership is committed.
- The closure is once-only within one pass; separate retries are protected by
  caller guards, and the final safety-net invocation must remain a no-op.

Transformation: extract `createBuyAccountingCommit` with named booking inputs
and return `commitBuyAccounting`. Keep the idempotency guard, statement order,
mutable references, and all three invocation positions unchanged. The
orchestrator now exposes which values cross the await, and its commit name
states that accounting changes extend beyond a counter. The implementation
still reads engine/ledger cycle state only when the returned closure runs.
This deletes the need to rediscover hidden captures and ledger mutations while
reviewing merge/new-body orchestration. Necessary temporal constraints remain
explicit in the helper's contract. No trading/accounting behavior was changed.

## Finding 2 — incoming execution changes meaning during reconciliation (6/10)

`src/fill-ledger.js:1088`: `const reconcileSyntheticCoverage = (fill) => {`;
`src/fill-ledger.js:1198`: `fill.size = newSize;`.
`ingestFill` then uses that mutated object for insertion and indexing while
using the returned allocation plan to update synthetic rows/correction
journals (`src/fill-ledger.js:1347`). A reader must remember that `fill.size`
after this call means excess unbooked quantity, whereas `reportedExecution`
retains the exchange execution and coverage allocations retain prior ownership.
This is a reader-cost finding, not a newly reproduced accounting failure.

Proposed future shape: return an explicitly named prepared ledger execution
alongside the coverage plan, keeping reported execution and bookable tranche
identities distinct at the caller. Preserve all journals, atomic writes, and
replacement semantics. Deferred because this crosses the ledger's recovery
contract and is independent of the selected buy-commit fix.

## Validation and limits

- Node 20.20.2, matching CI's Node 20 major.
- Focused existing public engine tests: 111/111 passed before and after the
  extraction (cycle turnover, null initial cycle, advancing/recovered partials,
  merge cancellation, retries, and consumption).
- One-off Acorn AST comparison: the extracted closure body and guard match
  after identifier normalization; explicit input aliases match; inlining the
  factory reconstructs the entire original engine AST, preserving call/wait
  placement. Both ledger/test comment updates have unchanged ASTs.
- Local `npm test` became unresponsive during `url-validator.test.js`: no
  assertion failure was reported, the parent was consuming CPU with an exited
  worker, and output did not progress for over a minute. Terminated through
  the owned runner (exit 137); this run is **incomplete**, not a full-suite pass.
  The root cause is unconfirmed. A diagnostic run of URL validation and the
  remaining volatility/WebSocket files passed 190/190 in about one second.
- `npm run build` passed, with the existing large-chunk warning.
  `git diff --check` passed. The PR requires the full CI test/build job before
  merge; its result is recorded in the completion handoff.

Pre-fix category assessment: **68/100**, worst verified severity **7/10**,
coverage **broad**, confidence **medium**. Significant reader burden remains at
financial state transitions, supported by the two concrete contracts above;
well-named existing recovery/classification helpers moderate the assessment.
The score rates the baseline, not the fix or scan count.

Stopping reason: one coherent, high-value, behavior-preserving slice is ready
for delivery after broad discovery and bounded contract verification. All 646
files received signals; most did not receive substantive review. Adapter
internals, strategy calculations, most UI/scripts, deployment manifests, and
most persistence consumers were not deeply audited. No live exchange orders,
PM2 operations, private records, or production data changes were used. Broad
signal coverage does not certify the repository or prove a global maximum.
