# Image vulnerability scans

The npm lockfiles say nothing about what is inside the container images: the Dockerfile installs Alpine packages and `pm2-logrotate`'s dependency tree at build time, and the Umbrel manifest ships a separately pinned, older release image. The **Image Security** workflow (`.github/workflows/image-security.yml`) scans those images and keeps the evidence for dependency audits.

## What is covered

Targets come from `node scripts/image-security-scan.js plan`, which reads the checked-in recipes rather than copying image references:

| Target | Source | Architectures |
| --- | --- | --- |
| `runtime-*` | Final stage of `Dockerfile` (also used by `docker-compose.yml`), built in CI from the checked-out commit. Must contain `pm2` and the dynamically installed `pm2-logrotate` tree. | amd64, arm64 |
| `builder-*` | Builder stage of `Dockerfile` (admin UI toolchain). | amd64 only. arm64 is recorded as **unavailable (expected)**: the stage is pinned to `$BUILDPLATFORM` and never shipped. |
| `umbrel-*` | The exact `image: …@sha256:` in `umbrel/docker-compose.yml`, pulled by digest. A fresh build of today's Dockerfile does not cover it. | amd64, arm64 |
| `fixture-alpine-*`, `fixture-node-*` | Default helper images of `scripts/docker-storage-smoke-test.sh` (test-only, not shipped). | amd64, arm64 |

Not covered: native PM2 installations. Their dependency sets are operator-managed and outside the images.

## How it runs

The workflow runs Mondays and Thursdays and on demand (**Actions → Image Security → Run workflow**). It installs Syft and Grype at the versions and SHA-256 hashes pinned in `scripts/install-image-scanners.sh`, inventories each target with Syft, then matches the inventory against the Grype database. Findings of every severity are exported; they never fail the run by themselves.

A scanner **control job** runs alongside: a deliberately vulnerable lockfile must produce findings, and an unreachable image and a missing scanner must each be reported as `unavailable`. If a control misbehaves the run fails.

Each target ends as exactly one of:

- `scanned`: `os-inventory.json`, `app-inventory.json`, `findings.json`, the raw `syft.json` / `grype.json`, and a `result.json`.
- `unavailable`: a `result.json` with `unavailableReason` (`build_failed`, `authentication_failed`, `image_not_found`, `architecture_mismatch`, `architecture_unsupported`, `scanner_unavailable`, `scanner_database_unavailable`, `scanner_failed`, `inventory_failed`) and **no findings file**. An empty inventory counts as `inventory_failed`, never as a clean image.

`result.json` records the source commit, workflow run, image digests (requested, per-platform manifest, image ID), Syft and Grype versions, the Grype database build time, inventory and finding counts, hashes of every exported file and SHA-256 hashes of the recipe files (`Dockerfile`, `docker-compose.yml`, `docker-entrypoint.sh`, both Umbrel/compose manifests, the three package manifests and lockfiles, the smoke test). Any unexpected `unavailable` target turns the run red. The `image-security-evidence` artifact holds every target plus `coverage-summary.json`, and the job summary shows a table.

## Reviewing findings

1. Open the latest run's job summary and read the coverage table. Resolve any `UNAVAILABLE` row first: it is a coverage gap, not a clean result.
2. Download `image-security-evidence` (`gh run download <run-id> -n image-security-evidence -D evidence`) and read `<target>/findings.json`. Triage by severity, `fixState` and `fixedIn`.
3. Fix by updating the pinned base image digest, the apk package pins, `docker/pm2/package-lock.json` or the Umbrel digest (after a release, per `docs/RELEASING.md`), then rerun the workflow. Do not add suppressions to make the table green.

## Using the evidence in a dependency audit

Evidence is only citable if this passes against the checkout being audited:

```bash
node scripts/verify-image-scan-evidence.js evidence
```

It exits non-zero and lists every problem when evidence is **older than 14 days**, was produced from **different recipe hashes**, names a **different Umbrel digest** than `umbrel/docker-compose.yml`, lacks a target, has an empty inventory, has files that are unrecorded or no longer match their recorded hashes, records unavailable coverage, or lacks a passing scanner control run (`selftest/selftest.json`, which the aggregate job copies into the bundle). `--max-age-days` can only tighten the 14-day limit, and `--now` is a diagnostic override; a citation must pass without it. Otherwise state the run, its source commit and the Grype database date alongside the results.

## Reproducing a scan locally

Nothing here touches a running checkout or its data. From a clean worktree:

```bash
scripts/install-image-scanners.sh "$PWD/.scanners"
export PATH="$PWD/.scanners:$PATH"
grype db update
node scripts/image-security-scan.js scan --target umbrel-arm64 --out evidence/umbrel-arm64
```

Built targets need a local image archive: `docker buildx build --platform linux/amd64 --output type=oci,dest=image.tar .` (add `--target builder` for the builder stage), then add `--source oci-archive:image.tar` to the `scan` command. `node scripts/image-security-scan.js selftest --out selftest` runs the detection and failure controls. `npm test` covers the evidence contract offline with stub scanners (`tests/image-scan-evidence.test.js`).
