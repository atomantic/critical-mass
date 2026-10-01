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
8. Watch the Release workflow for the merge commit. Verify the PR is merged, the merge commit is on `origin/main`, the remote version tag points to that release lineage, and `gh release view vX.Y.Z` reports a published, non-draft, non-prerelease release. A merged PR alone is not completion.
9. Verify the container publication for the same tag:
   - `docker buildx imagetools inspect ghcr.io/atomantic/critical-mass:vX.Y.Z` must list both `linux/amd64` and `linux/arm64`.
   - Pull each platform explicitly and compare `org.opencontainers.image.revision` from `docker image inspect` with `git rev-parse vX.Y.Z^{commit}`. For example:
     ```sh
     EXPECTED_REVISION="$(git rev-parse 'vX.Y.Z^{commit}')"
     for PLATFORM in linux/amd64 linux/arm64; do
       docker pull --platform "$PLATFORM" ghcr.io/atomantic/critical-mass:vX.Y.Z
       test "$(docker image inspect ghcr.io/atomantic/critical-mass:vX.Y.Z --format '{{index .Config.Labels "org.opencontainers.image.revision"}}')" = "$EXPECTED_REVISION"
     done
     ```
     The revision must match for both platforms, and the version label/tag must be `vX.Y.Z`.
   - Confirm the versioned image exists before treating the release as deployable through the container path.

## Automation compatibility

This is a version-bump PR workflow, not promotion from `main` into a second long-lived branch. A generic release helper that detects `main → main` and aborts does not support this repository's topology. Use the procedure above rather than creating a permanent release branch or redirecting the existing publication workflow. The release task owns pushing its temporary branch, opening and merging its PR, and verifying publication; a generic completion instruction that forbids pushing cannot complete this task.

If publication was interrupted, inspect the existing tag and release before retrying. Never overwrite a version tag. If a verified tag and GitHub Release exist but its image publication failed, run **Actions → Docker Build → Run workflow** with that existing `vX.Y.Z` tag. The recovery workflow checks out the immutable tag, validates the checked-out commit, and republishes only the versioned image and leaves `latest` unchanged (only a newly-created release promotes `latest`, via `publish_latest: true` in `release.yml`), without creating a new release or bumping the version. If a verified tag exists without its GitHub Release, publish that tag using its checked-in `.changelogs/vX.Y.Z.md` notes; do not bump the version again just to recover publication.
