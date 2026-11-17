#!/usr/bin/env bash
# Decide whether a newly-created release should move the `latest` image tag.
#
# Usage: should-promote-latest.sh <release-tag> < existing-tags
#
# Reads existing tag names (one per line) on stdin and prints `true` when the
# release tag is a stable vX.Y.Z version at least as high as every other stable
# version tag, otherwise `false`. Other tags (prereleases, non-version tags, the
# release tag itself) are ignored. Release runs can finish out of order, so an
# older version released second must never move `latest` backwards. The versioned
# tag and GitHub Release are published regardless of this answer.
set -euo pipefail

RELEASE_TAG="${1:?usage: should-promote-latest.sh <release-tag> < tags}"
SEMVER='^v[0-9]+\.[0-9]+\.[0-9]+$'

if ! printf '%s\n' "$RELEASE_TAG" | grep -Eq "$SEMVER"; then
  echo "false"
  exit 0
fi

HIGHEST="$( { grep -E "$SEMVER" || true; } | { grep -vxF "$RELEASE_TAG" || true; } \
  | sort -V | tail -n 1)"

if [ -z "$HIGHEST" ]; then
  echo "true"
  exit 0
fi

TOP="$(printf '%s\n%s\n' "$HIGHEST" "$RELEASE_TAG" | sort -V | tail -n 1)"
if [ "$TOP" = "$RELEASE_TAG" ]; then echo "true"; else echo "false"; fi
