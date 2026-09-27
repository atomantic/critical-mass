#!/bin/sh
set -e

CONTAINER_UID="$(id -u)"
CONTAINER_GID="$(id -g)"
STORAGE_PREPARATION_HINT="sudo ./scripts/prepare-docker-storage.sh"

fail_storage_check() {
  printf 'Error: Docker %s directory %s is not writable by container UID %s:GID %s. Prepare the host bind mounts with: %s\n' \
    "$1" "$2" "$CONTAINER_UID" "$CONTAINER_GID" "$STORAGE_PREPARATION_HINT" >&2
  exit 1
}

check_storage_directory() {
  label="$1"
  path="$2"

  if [ ! -d "$path" ]; then
    printf 'Error: Docker %s directory %s is missing. Prepare the host bind mounts with: %s\n' \
      "$label" "$path" "$STORAGE_PREPARATION_HINT" >&2
    exit 1
  fi

  [ -w "$path" ] || fail_storage_check "$label" "$path"

  if ! probe_file="$(mktemp "$path/.critical-mass-write-check.XXXXXX" 2>/dev/null)"; then
    fail_storage_check "$label" "$path"
  fi
  rm -f "$probe_file" || fail_storage_check "$label" "$path"
}

# Compose now refuses to create missing bind sources. Keep the same guard here
# for direct docker runs and to catch read-only/root-owned mounts before any
# bootstrap credential is generated.
check_storage_directory data /app/data
check_storage_directory logs /app/logs

# A container must bind its internal interface for host publishing/app_proxy,
# so create an out-of-band one-time bootstrap credential on first launch. It is
# written only to the persistent data volume (never stdout/stderr) and deleted
# by the gateway after successful enrollment.
BOOTSTRAP_STATE=false
if [ -f /app/data/operator-auth.json ] && node -e "const fs=require('fs');try{const r=JSON.parse(fs.readFileSync('/app/data/operator-auth.json','utf8'));process.exit(r.state==='bootstrap'?0:1)}catch{process.exit(1)}"; then
  BOOTSTRAP_STATE=true
  rm -f /app/data/operator-bootstrap-secret
fi
if { [ ! -f /app/data/operator-auth.json ] || [ "$BOOTSTRAP_STATE" = true ]; } && [ -z "${OPERATOR_BOOTSTRAP_SECRET:-}" ]; then
  BOOTSTRAP_SECRET_FILE=/app/data/operator-bootstrap-secret
  if [ ! -f "$BOOTSTRAP_SECRET_FILE" ]; then
    umask 077
    node -e "process.stdout.write(require('crypto').randomBytes(32).toString('hex'))" > "$BOOTSTRAP_SECRET_FILE"
  fi
  OPERATOR_BOOTSTRAP_SECRET="$(sed -n '1p' "$BOOTSTRAP_SECRET_FILE")"
  OPERATOR_BOOTSTRAP_SECRET_FILE="$BOOTSTRAP_SECRET_FILE"
  export OPERATOR_BOOTSTRAP_SECRET OPERATOR_BOOTSTRAP_SECRET_FILE
fi

# Start all processes with PM2 in Docker-foreground mode.
# Excludes the UI dev server — the admin panel is pre-built into admin/dist.
exec pm2-runtime start ecosystem.config.cjs --env production \
  --only "critical-mass,critical-mass-coinbase,critical-mass-gemini,critical-mass-cryptocom"
