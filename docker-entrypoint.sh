#!/bin/sh
set -e

# Ensure persistent directories exist (mounted volumes may be empty)
mkdir -p /app/data /app/logs

# Start all processes with PM2 in Docker-foreground mode.
# Excludes the UI dev server — the admin panel is pre-built into admin/dist.
exec pm2-runtime start ecosystem.config.cjs --env production \
  --only "critical-mass,critical-mass-coinbase,critical-mass-gemini,critical-mass-cryptocom"
