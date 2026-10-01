#!/usr/bin/env bash
set -euo pipefail

# Verifies the BUILT runtime image ships the committed config.example.json and
# that the packaged loader resolves the three starter funds from it. Containers
# run with networking disabled, no credentials, and disposable storage (--rm);
# nothing starts the trading engines or touches exchange APIs.
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
IMAGE="${IMAGE:-critical-mass-seed-smoke-$$}"
BUILT_HERE=0

cleanup() { [[ "$BUILT_HERE" = 1 ]] && docker image rm "$IMAGE" >/dev/null 2>&1 || true; }
trap cleanup EXIT

fail() { printf 'Error: %s\n' "$*" >&2; exit 1; }

command -v docker >/dev/null 2>&1 || fail "Docker CLI is required"
if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  docker build -q -t "$IMAGE" "$REPO_ROOT" >/dev/null
  BUILT_HERE=1
fi

run() {
  docker run --rm --network none --entrypoint node "$IMAGE" "$@"
}

# 1. Exact committed seed is in the image; no operator config or credentials.
EXPECTED="$(shasum -a 256 "$REPO_ROOT/config.example.json" | cut -d' ' -f1)"
ACTUAL="$(docker run --rm --network none --entrypoint sha256sum "$IMAGE" /app/config.example.json | cut -d' ' -f1)"
[[ "$EXPECTED" = "$ACTUAL" ]] || fail "image config.example.json differs from the committed seed (or is missing)"
docker run --rm --network none --entrypoint sh "$IMAGE" -c \
  'test ! -e /app/config.json && test ! -e /app/data/config.json && test -z "$(ls -A /app/keys 2>/dev/null)"' \
  || fail "image contains operator config or credentials"

# 2. Empty data: packaged loader yields the three seeded funds, disabled + dry-run.
run -e '
const c = require("/app/src/config-utils");
const funds = c.getConfiguredFunds();
const ex = [...new Set(funds.map((f) => f.exchange))].sort().join(",");
if (ex !== "coinbase,cryptocom,gemini") throw new Error("unexpected exchanges: " + ex);
const cfg = c.loadConfig();
for (const k of ["coinbase", "gemini", "cryptocom"]) {
  if (cfg.exchanges[k].enabled !== false || cfg.exchanges[k].dryRun !== true) throw new Error(k + " not disabled/dry-run");
}
' || fail "packaged loader did not resolve the seeded funds"

# 3. An existing data/config.json overlays the seed without resetting it.
run -e '
const fs = require("fs");
fs.writeFileSync("/app/data/config.json", JSON.stringify({ exchanges: { gemini: { dryRun: false } } }));
const c = require("/app/src/config-utils");
const cfg = c.loadConfig();
if (cfg.exchanges.gemini.dryRun !== false) throw new Error("overlay not applied");
if (!cfg.exchanges.cryptocom || !cfg.exchanges.coinbase) throw new Error("overlay dropped seeded exchanges");
' || fail "user config overlay failed"

printf 'Docker seed config smoke test passed\n'
