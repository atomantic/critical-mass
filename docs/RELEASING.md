# Releasing Critical Mass

Critical Mass uses a single release branch: `main`. The Release workflow runs on pushes to `main`, reads the root `package.json` version, and publishes a matching `vX.Y.Z` tag and GitHub Release only when that tag does not already exist. After a new release is created, it invokes the reusable Docker workflow with that exact tag. Ordinary merges with an unchanged version intentionally do not publish another release or republish its image.

## Prepare and publish

1. Fetch `origin/main` and tags. Check published GitHub Releases and any open release PR before preparing another version; resume an existing preparation where possible.
2. Create an isolated worktree with a temporary `release/vX.Y.Z` branch based on `origin/main`. Keep the running application's checkout and data untouched.
3. Review commits since the latest published version, including commit bodies. Choose the semantic version from those changes. Update the root `package.json` and both root version fields in `package-lock.json`; no dependency update is needed. The private admin package and Umbrel packaging have separate version histories.
4. Write grouped, user-facing notes to `.changelogs/vX.Y.Z.md`, including upgrade requirements. The historical `CHANGELOG.md` Unreleased section contains entries from earlier releases too, so use the tag comparison to establish scope.
5. Run `npm test` and `npm run build`. In a worktree, dependencies may be linked from the primary checkout; never run an installer through those links. Resolve failures before proceeding.
6. Commit the preparation, run the configured optional code review with enforced read-only permissions, and open a PR from `release/vX.Y.Z` into `main`. Include the previous-tag comparison so reviewers can inspect the full release scope beyond the version-bump diff.
7. Wait for the PR's CI build to succeed, then merge. Do not merge on an empty checks response while expected checks are still attaching.
8. Watch the Release workflow run for the merge commit (`gh run list --workflow release.yml --commit <merge-sha>`). It must succeed with its **Publish release image** job run, not skipped: a skipped publication means the tag already existed and nothing new was released. `gh release view vX.Y.Z` then confirms the GitHub Release. A merged PR alone is not completion.
9. Confirm the image: `docker buildx imagetools inspect ghcr.io/atomantic/critical-mass:vX.Y.Z` must list both `linux/amd64` and `linux/arm64`. It reads the registry manifest without pulling either image. The Docker Build workflow already fails unless its checkout is the tag's commit and stamps that commit as `org.opencontainers.image.revision` on both platforms, so do not pull each platform to re-compare the label.

## Automation compatibility

This is a version-bump PR workflow, not promotion from `main` into a second long-lived branch. A generic release helper that detects `main → main` and aborts does not support this repository's topology. Use the procedure above rather than creating a permanent release branch or redirecting the existing publication workflow. The release task owns pushing its temporary branch, opening and merging its PR, and verifying publication; a generic completion instruction that forbids pushing cannot complete this task.

If publication was interrupted, inspect the existing tag and release before retrying. Never overwrite a version tag. If a verified tag and GitHub Release exist but its image publication failed, run **Actions → Docker Build → Run workflow** with that existing `vX.Y.Z` tag. The recovery workflow checks out the immutable tag, validates the checked-out commit, and republishes only the versioned image and leaves `latest` unchanged (only a newly-created release promotes `latest`, via `publish_latest: true` in `release.yml`), without creating a new release or bumping the version. If a verified tag exists without its GitHub Release, publish that tag using its checked-in `.changelogs/vX.Y.Z.md` notes; do not bump the version again just to recover publication.

## Umbrel packaging

The Umbrel manifests (`umbrel/docker-compose.yml`, `umbrel/umbrel-app.yml`) have their own version history and are not bumped by the Release workflow. They must select a published, immutable release image, not `latest` or an unversioned build. Update them only after step 9 above has verified that release's image.

1. Resolve the multi-platform manifest digest for the verified tag and pin it: `docker buildx imagetools inspect ghcr.io/atomantic/critical-mass:vX.Y.Z` prints the index digest; set `image:` to `ghcr.io/atomantic/critical-mass:vX.Y.Z@sha256:<digest>`.
2. Set `version:` in `umbrel/umbrel-app.yml` to the same `X.Y.Z` and write user-facing `releaseNotes` for the Umbrel update.
3. Run `npm test`. `tests/umbrel-packaging-contract.test.js` checks, offline and without credentials, that the image is digest-pinned, that both manifests record the same version, that the selected release is not older than the gateway port migration, and that `APP_PORT`, `umbrel-app.yml` `port`, the Dockerfile `EXPOSE` and `ecosystem.config.cjs` `PORTS.API` all agree.
4. Smoke-test the pinned image the way Umbrel runs it: start it with a fresh disposable data directory bound to `/app/data`, confirm `GET /` on the gateway port returns the dashboard and a protected API route returns HTTP 401, then read `data/operator-bootstrap-secret` from the mounted directory and complete operator enrollment. Restart the container against the same data directory and confirm the enrolled operator and configuration survive the upgrade path.

The Umbrel store copies these manifests verbatim, so a mismatch between the pinned version and the proxy port ships an installation that cannot reach its own dashboard.
