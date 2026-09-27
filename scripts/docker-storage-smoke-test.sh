#!/usr/bin/env bash
set -euo pipefail

# Run this with a Linux container engine and the two images already available
# locally. Every container below has networking disabled; the Node image is
# used only to run the real entrypoint with a harmless PM2 stub.
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PREPARE_SCRIPT="$SCRIPT_DIR/prepare-docker-storage.sh"
ENTRYPOINT="$REPO_ROOT/docker-entrypoint.sh"
ALPINE_IMAGE="${ALPINE_IMAGE:-alpine:3.20}"
NODE_IMAGE="${NODE_IMAGE:-node:22-alpine}"
TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/critical-mass-docker-storage.XXXXXX")"
VOLUME_PREFIX="critical-mass-storage-smoke-$$"
STORAGE_VOLUME="${VOLUME_PREFIX}-prepared"
ABSENT_VOLUME="${VOLUME_PREFIX}-absent"
UNWRITABLE_VOLUME="${VOLUME_PREFIX}-unwritable"
INCOMPATIBLE_VOLUME="${VOLUME_PREFIX}-incompatible"
VOLUMES=("$STORAGE_VOLUME" "$ABSENT_VOLUME" "$UNWRITABLE_VOLUME" "$INCOMPATIBLE_VOLUME")
COMPOSE_PROJECT_NAME="${VOLUME_PREFIX}-compose"
COMPOSE_FILE="$TMP_ROOT/missing-bind-compose.yml"
COMPOSE_MISSING_DIR="$TMP_ROOT/compose-missing-data"

cleanup() {
  docker compose --project-name "$COMPOSE_PROJECT_NAME" --file "$COMPOSE_FILE" down --volumes --remove-orphans >/dev/null 2>&1 || true
  docker volume rm "${VOLUMES[@]}" >/dev/null 2>&1 || true
  rm -rf "$TMP_ROOT"
}
trap cleanup EXIT

fail() {
  printf 'Error: %s\n' "$*" >&2
  exit 1
}

command -v docker >/dev/null 2>&1 || fail "Docker CLI is required"
docker image inspect "$ALPINE_IMAGE" >/dev/null 2>&1 || fail "Docker image '$ALPINE_IMAGE' is not available locally"
docker image inspect "$NODE_IMAGE" >/dev/null 2>&1 || fail "Docker image '$NODE_IMAGE' is not available locally"
docker compose version >/dev/null 2>&1 || fail "Docker Compose is required"

run_alpine() {
  local user="$1"
  local volume="$2"
  shift 2
  docker run --rm --network none --user "$user" \
    --mount "type=volume,source=$volume,target=/workspace" \
    --mount "type=bind,source=$PREPARE_SCRIPT,target=/prepare,readonly" \
    "$ALPINE_IMAGE" /bin/sh -eu -c "$*"
}

mkdir -p "$TMP_ROOT/bin"
printf '#!/bin/sh\nexit 0\n' > "$TMP_ROOT/bin/pm2-runtime"
chmod 755 "$TMP_ROOT/bin/pm2-runtime"

# A fresh preparation creates both directories with the numeric runtime owner
# and private permissions, without requiring host user-name lookups.
run_alpine 0:0 "$STORAGE_VOLUME" 'DATA_DIR=/workspace/data LOGS_DIR=/workspace/logs /bin/sh /prepare'
run_alpine 0:0 "$STORAGE_VOLUME" 'test "$(stat -c "%u:%g" /workspace/data)" = 1000:1000; test "$(stat -c "%u:%g" /workspace/logs)" = 1000:1000; test "$(stat -c "%a" /workspace/data)" = 700; test "$(stat -c "%a" /workspace/logs)" = 700'

run_entrypoint() {
  local output="$1"
  local volume="$2"
  shift 2
  docker run --rm --network none --user 1000:1000 \
    --mount "type=bind,source=$ENTRYPOINT,target=/docker-entrypoint.sh,readonly" \
    --mount "type=bind,source=$TMP_ROOT/bin,target=/tmp/critical-mass-bin,readonly" \
    --mount "type=volume,source=$volume,target=/app" \
    -e PATH=/tmp/critical-mass-bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    "$@" \
    --entrypoint /bin/sh "$NODE_IMAGE" /docker-entrypoint.sh >"$output" 2>&1
}

# Prepared paths reach the normal bootstrap path and keep its generated secret
# owner-only. The PM2 stub lets this test stop immediately after the entrypoint.
run_entrypoint "$TMP_ROOT/prepared.log" "$STORAGE_VOLUME"
run_alpine 0:0 "$STORAGE_VOLUME" 'test -f /workspace/data/operator-bootstrap-secret; test "$(stat -c "%a" /workspace/data/operator-bootstrap-secret)" = 600'
[[ ! -s "$TMP_ROOT/prepared.log" ]]

# The Compose long syntax must reject a missing host bind source instead of
# asking a rootful daemon to create it with root ownership.
printf '%s\n' \
  'services:' \
  '  missing-source:' \
  "    image: $ALPINE_IMAGE" \
  '    command: ["sh", "-c", "exit 0"]' \
  '    network_mode: none' \
  '    volumes:' \
  '      - type: bind' \
  '        source: ./compose-missing-data' \
  '        target: /data' \
  '        bind:' \
  '          create_host_path: false' > "$COMPOSE_FILE"
if docker compose --project-name "$COMPOSE_PROJECT_NAME" --file "$COMPOSE_FILE" up --no-build --abort-on-container-exit >"$TMP_ROOT/compose-absent.log" 2>&1; then
  fail "Compose unexpectedly accepted a missing bind source"
fi
[[ ! -e "$COMPOSE_MISSING_DIR" ]] || fail "Compose created the missing bind source"
grep -Eiq 'no such file|does not exist|not found|bind source path' "$TMP_ROOT/compose-absent.log" || fail "Compose did not explain the missing bind source"

# Compose refuses this case before startup; the direct entrypoint guard still
# explains the missing path if the image is launched without that bind mount.
if run_entrypoint "$TMP_ROOT/absent.log" "$ABSENT_VOLUME"; then
  fail "entrypoint unexpectedly accepted a missing data directory"
fi
grep -q 'data directory /app/data is missing' "$TMP_ROOT/absent.log"
grep -q 'prepare-docker-storage.sh' "$TMP_ROOT/absent.log"

# A root-owned 0755 data directory reproduces the original failure for UID
# 1000. It must fail before a bootstrap secret is created.
run_alpine 0:0 "$UNWRITABLE_VOLUME" 'mkdir -p /workspace/data /workspace/logs; chown 0:0 /workspace/data; chmod 755 /workspace/data; chown 1000:1000 /workspace/logs; chmod 700 /workspace/logs'
if run_entrypoint "$TMP_ROOT/unwritable.log" "$UNWRITABLE_VOLUME"; then
  fail "entrypoint unexpectedly accepted an unwritable data directory"
fi
grep -q 'data directory /app/data is not writable' "$TMP_ROOT/unwritable.log"
grep -q 'prepare-docker-storage.sh' "$TMP_ROOT/unwritable.log"
run_alpine 0:0 "$UNWRITABLE_VOLUME" '! test -e /workspace/data/operator-bootstrap-secret'

# Existing data with incompatible ownership is rejected without recursive
# changes. The marker proves the script did not reset the directory contents.
run_alpine 0:0 "$INCOMPATIBLE_VOLUME" 'mkdir -p /workspace/data /workspace/logs; printf "preserve-me\n" > /workspace/data/marker; chown 0:0 /workspace/data /workspace/logs; chmod 700 /workspace/data /workspace/logs'
if run_alpine 0:0 "$INCOMPATIBLE_VOLUME" 'DATA_DIR=/workspace/data LOGS_DIR=/workspace/logs /bin/sh /prepare' >"$TMP_ROOT/incompatible.log" 2>&1; then
  fail "preparation unexpectedly changed an incompatible existing directory"
fi
grep -q 'expected 1000:1000' "$TMP_ROOT/incompatible.log"
run_alpine 0:0 "$INCOMPATIBLE_VOLUME" 'grep -qx preserve-me /workspace/data/marker; test "$(stat -c "%u:%g" /workspace/data)" = 0:0'

printf 'Docker storage smoke test passed: prepared, absent, unwritable, and incompatible existing paths\n'
