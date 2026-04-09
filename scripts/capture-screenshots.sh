#!/usr/bin/env bash
# capture-screenshots.sh — Generate marketing / Umbrel gallery screenshots.
#
# Produces 2880x1800 PNGs (16:10 retina) of the admin UI using Chrome
# headless=new, matching the resolution used by the bitwatch Umbrel gallery.
#
# Prereqs:
#   - Google Chrome installed at /Applications/Google Chrome.app
#   - Admin UI reachable at $CM_BASE_URL (default http://localhost:5563)
#   - Regime engines running with live data for best results
#
# Usage:
#   ./scripts/capture-screenshots.sh                 # capture to umbrel/gallery/
#   CM_BASE_URL=http://localhost:5564 ./scripts/capture-screenshots.sh
#   CM_WAIT_MS=12000 ./scripts/capture-screenshots.sh  # longer render wait

set -euo pipefail

CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
BASE_URL="${CM_BASE_URL:-http://localhost:5563}"
WAIT_MS="${CM_WAIT_MS:-8000}"

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT_DIR="${REPO_ROOT}/umbrel/gallery"
DOCS_DIR="${REPO_ROOT}/docs"

if [[ ! -x "${CHROME}" ]]; then
  echo "error: Google Chrome not found at ${CHROME}" >&2
  exit 1
fi

if ! curl -fsS -o /dev/null "${BASE_URL}/api/exchanges"; then
  echo "error: admin API not reachable at ${BASE_URL} — is the 'critical-mass' PM2 process running?" >&2
  exit 1
fi

mkdir -p "${OUT_DIR}" "${DOCS_DIR}"

# Each entry: "<route>|<output_filename>|<description>"
SHOTS=(
  "/coinbase/BTC-USDC|screenshot-1.png|Coinbase Regime Dashboard (hero)"
  "/|screenshot-2.png|Overview"
  "/coinbase/BTC-USDC/charts|screenshot-3.png|Coinbase Charts"
)

capture() {
  local route="$1" out="$2" desc="$3"
  local url="${BASE_URL}${route}"
  local path="${OUT_DIR}/${out}"

  echo "→ ${desc}"
  echo "  url:    ${url}"
  echo "  out:    ${path}"

  # --headless=new enables WebGL for the Three.js celestial scene.
  # --window-size=1440x900 with --force-device-scale-factor=2 yields a 2880x1800 PNG.
  # --virtual-time-budget lets charts + orbit animations settle before capture.
  (
    cd "${OUT_DIR}"
    "${CHROME}" \
      --headless=new \
      --disable-gpu \
      --hide-scrollbars \
      --no-sandbox \
      --window-size=1440,900 \
      --force-device-scale-factor=2 \
      --virtual-time-budget="${WAIT_MS}" \
      --screenshot="${path}" \
      "${url}" 2>/dev/null
  )

  if [[ ! -s "${path}" ]]; then
    echo "  ✗ capture failed (empty or missing file)" >&2
    return 1
  fi

  local dims
  dims=$(sips -g pixelWidth -g pixelHeight "${path}" 2>/dev/null | awk '/pixel(Width|Height)/ {print $2}' | paste -sd'x' -)
  echo "  ✓ ${dims}"
}

for entry in "${SHOTS[@]}"; do
  IFS='|' read -r route out desc <<<"${entry}"
  capture "${route}" "${out}" "${desc}"
done

# Mirror hero shot to docs/app_1.png (referenced by README.md).
cp "${OUT_DIR}/screenshot-1.png" "${DOCS_DIR}/app_1.png"
echo "→ mirrored hero to docs/app_1.png"

echo
echo "Done. Review the images before committing:"
echo "  open ${OUT_DIR}/*.png ${DOCS_DIR}/app_1.png"
