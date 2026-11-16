#!/usr/bin/env bash
# Install the pinned Syft and Grype release binaries used by the image
# vulnerability scans into <dest-dir>, verifying each tarball against the
# SHA-256 recorded here before it is extracted. Bump versions and hashes
# together (hashes come from each release's *_checksums.txt); the Image Security
# workflow and docs/IMAGE_SECURITY.md both go through this script, so a local
# reproduction runs the same scanner builds as CI.
#
# Usage: scripts/install-image-scanners.sh <dest-dir>
set -euo pipefail

SYFT_VERSION="1.55.0"
GRYPE_VERSION="0.121.0"

# Plain `case` instead of an associative array: macOS ships bash 3.2.
pinned_sha256() {
  case "$1" in
    "syft_${SYFT_VERSION}_linux_amd64") echo bb65249542db5fedeeb4d3f9b018b75e7264dbfbbb10486f044581a92f90490d ;;
    "syft_${SYFT_VERSION}_linux_arm64") echo 929bd163db2d7cd2255d3bcb8967208079813d7b46b0c952f7b794d8e2c7d304 ;;
    "syft_${SYFT_VERSION}_darwin_amd64") echo e2e5831cbabaec9a36fe65c34755c1113982c842a685edce3ce0b54a0ded8003 ;;
    "syft_${SYFT_VERSION}_darwin_arm64") echo 1217c258bd5eb91ef3189cf22a82e02f9cac07e4ce934350f428e93aff674625 ;;
    "grype_${GRYPE_VERSION}_linux_amd64") echo 64e07133d3486115de647a66581461dccf5c732748a0a3119077395565f15519 ;;
    "grype_${GRYPE_VERSION}_linux_arm64") echo 86f570f75ca947ea3dd6486309232bcff6d78e44ba081ae75ab14eab72be3dae ;;
    "grype_${GRYPE_VERSION}_darwin_amd64") echo 27eef17e42f0340af6582cdbc33ad18faf9f601c613ab81d2e1658a94cbc357f ;;
    "grype_${GRYPE_VERSION}_darwin_arm64") echo 7be39d3a0428c664ce0183e4aba31ed9accffce9eda7e7f6fa84e9c512285f27 ;;
  esac
}

DEST="${1:?usage: install-image-scanners.sh <dest-dir>}"
case "$(uname -s)" in
  Linux) OS=linux ;;
  Darwin) OS=darwin ;;
  *) echo "Unsupported OS: $(uname -s)" >&2; exit 1 ;;
esac
case "$(uname -m)" in
  x86_64|amd64) ARCH=amd64 ;;
  arm64|aarch64) ARCH=arm64 ;;
  *) echo "Unsupported architecture: $(uname -m)" >&2; exit 1 ;;
esac

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$DEST"

install_tool() {
  local tool="$1" version="$2"
  local asset="${tool}_${version}_${OS}_${ARCH}"
  local expected
  expected="$(pinned_sha256 "$asset")"
  [ -n "$expected" ] || { echo "No pinned hash for $asset" >&2; exit 1; }
  curl -fsSL --retry 3 -o "$WORK/$asset.tar.gz" \
    "https://github.com/anchore/${tool}/releases/download/v${version}/${asset}.tar.gz"
  local actual
  actual="$(sha256_of "$WORK/$asset.tar.gz")"
  if [ "$actual" != "$expected" ]; then
    echo "Checksum mismatch for $asset: expected $expected, got $actual" >&2
    exit 1
  fi
  mkdir -p "$WORK/$asset"
  tar -xzf "$WORK/$asset.tar.gz" -C "$WORK/$asset" "$tool"
  install -m 0755 "$WORK/$asset/$tool" "$DEST/$tool"
  echo "Installed $tool $version to $DEST/$tool"
}

install_tool syft "$SYFT_VERSION"
install_tool grype "$GRYPE_VERSION"
