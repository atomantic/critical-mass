#!/usr/bin/env bash
set -euo pipefail

# Run this with a Linux container engine and the Node image already available
# locally. The container has networking disabled; it runs the real
# docker-entrypoint.sh with stubs standing in for pm2-runtime and
# scripts/pm2-stack.js, then `docker stop`s it and checks the stop order:
# gateway stopped -> engines stopped -> pm2-runtime receives SIGTERM.
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
ENTRYPOINT="$REPO_ROOT/docker-entrypoint.sh"
NODE_IMAGE="${NODE_IMAGE:-node:22-alpine}"
TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/critical-mass-docker-stop-order.XXXXXX")"
CONTAINER="critical-mass-stop-order-smoke-$$"

cleanup() {
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  rm -rf "$TMP_ROOT"
}
trap cleanup EXIT

fail() {
  printf 'Error: %s\n' "$*" >&2
  exit 1
}

command -v docker >/dev/null 2>&1 || fail "Docker CLI is required"
docker image inspect "$NODE_IMAGE" >/dev/null 2>&1 || fail "Docker image '$NODE_IMAGE' is not available locally"

mkdir -p "$TMP_ROOT/bin" "$TMP_ROOT/scripts" "$TMP_ROOT/data" "$TMP_ROOT/logs"
# The container runs as UID 1000; the host directories only need to be writable.
chmod 777 "$TMP_ROOT/data" "$TMP_ROOT/logs"

# Stub pm2-runtime: stays alive until SIGTERM, then logs and exits 0.
cat > "$TMP_ROOT/bin/pm2-runtime" <<'STUB'
#!/bin/sh
trap 'echo "pm2-runtime received SIGTERM"; exit 0' TERM INT
echo "pm2-runtime started"
while :; do sleep 1 & wait $!; done
STUB
chmod 755 "$TMP_ROOT/bin/pm2-runtime"

# Stub pm2-stack: the delays make a concurrent (unordered) stop observable.
cat > "$TMP_ROOT/scripts/pm2-stack.js" <<'STUB'
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
(async () => {
  await wait(1000);
  console.log('gateway stopped');
  await wait(1000);
  console.log('engines stopped');
})();
STUB

docker run -d --name "$CONTAINER" --network none --user 1000:1000 \
  --mount "type=bind,source=$ENTRYPOINT,target=/docker-entrypoint.sh,readonly" \
  --mount "type=bind,source=$TMP_ROOT/bin,target=/tmp/critical-mass-bin,readonly" \
  --mount "type=bind,source=$TMP_ROOT/scripts,target=/app/scripts,readonly" \
  --mount "type=bind,source=$TMP_ROOT/data,target=/app/data" \
  --mount "type=bind,source=$TMP_ROOT/logs,target=/app/logs" \
  -e PATH=/tmp/critical-mass-bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
  --entrypoint /bin/sh "$NODE_IMAGE" /docker-entrypoint.sh >/dev/null

# Wait until the entrypoint has installed its trap and started the stub.
for _ in $(seq 1 50); do
  docker logs "$CONTAINER" 2>&1 | grep -q 'pm2-runtime started' && break
  sleep 0.2
done
docker logs "$CONTAINER" 2>&1 | grep -q 'pm2-runtime started' || fail "container did not start"
sleep 0.5

docker stop --time 20 "$CONTAINER" >/dev/null
EXIT_CODE="$(docker inspect --format '{{.State.ExitCode}}' "$CONTAINER")"
LOGS="$(docker logs "$CONTAINER" 2>&1)"

[[ "$EXIT_CODE" = 0 ]] || fail "container exited with $EXIT_CODE, expected 0"$'\n'"$LOGS"

line_of() { printf '%s\n' "$LOGS" | grep -n -m1 -F "$1" | cut -d: -f1; }
GATEWAY_LINE="$(line_of 'gateway stopped')"
ENGINES_LINE="$(line_of 'engines stopped')"
SIGTERM_LINE="$(line_of 'pm2-runtime received SIGTERM')"
[[ -n "$GATEWAY_LINE" && -n "$ENGINES_LINE" && -n "$SIGTERM_LINE" ]] || fail "missing stop log lines"$'\n'"$LOGS"
(( GATEWAY_LINE < ENGINES_LINE && ENGINES_LINE < SIGTERM_LINE )) || fail "stop order was not gateway -> engines -> pm2-runtime"$'\n'"$LOGS"

printf 'Docker stop-order smoke test passed: gateway, engines, then pm2-runtime SIGTERM; exit 0\n'
