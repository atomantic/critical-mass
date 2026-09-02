#!/bin/sh
set -e

# Ensure persistent directories exist (mounted volumes may be empty)
mkdir -p /app/data /app/logs

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
