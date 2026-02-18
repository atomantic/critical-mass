#!/bin/bash
# Kalshi Engine Health Monitor
# Runs continuously, checking every 5 minutes

LOG_DIR="/Users/antic/github.com/atomantic/critical-mass/logs"
DATA_DIR="/Users/antic/github.com/atomantic/critical-mass/data/kalshi"
API_BASE="http://localhost:5563/api/kalshi"
MONITOR_LOG="$LOG_DIR/kalshi-monitor.log"

check_health() {
  local ts=$(date '+%Y-%m-%d %H:%M:%S')
  echo "===== KALSHI MONITOR CHECK: $ts ====="

  # 1. Check if PM2 process is online
  local pm2_status=$(pm2 jlist 2>/dev/null | python3 -c "
import json, sys
procs = json.load(sys.stdin)
for p in procs:
  if p['name'] == 'critical-mass':
    print(f\"status={p['pm2_env']['status']} restarts={p['pm2_env']['restart_time']} uptime={p['pm2_env'].get('pm_uptime', 'N/A')} memory={p['monit']['memory'] // 1024 // 1024}MB\")
    break
" 2>/dev/null)
  echo "  PM2: $pm2_status"

  # 2. Check health-report endpoint
  local health=$(curl -s --connect-timeout 5 --max-time 10 "$API_BASE/health-report" 2>/dev/null)
  if [ -z "$health" ]; then
    echo "  CRITICAL: API unreachable!"
    return 1
  fi

  local health_status=$(echo "$health" | python3 -c "
import json, sys
try:
  d = json.load(sys.stdin)
  h = d.get('health', 'unknown')
  eng = d.get('engine', {})
  bal = d.get('balance', {})
  today = d.get('today', {})
  risk = d.get('risk', {})
  alerts = d.get('alerts', [])
  print(f\"health={h}\")
  print(f\"  engine: running={eng.get('running')} mode={eng.get('mode')} markets={eng.get('marketsTracked')} strategies={eng.get('enabledStrategies', [])}\")
  print(f\"  balance: available=\${bal.get('available', 0):.2f} inPositions=\${bal.get('inPositions', 0):.2f} openPositions={bal.get('openPositions', 0)}\")
  print(f\"  today: trades={today.get('trades', 0)} wins={today.get('wins', 0)} winRate={today.get('winRate', 0):.0%} pnl=\${today.get('pnl', 0):.2f}\")
  print(f\"  risk: dailyPnl=\${risk.get('currentDailyPnl', 0):.2f} maxLoss=\${risk.get('maxDailyLoss', 0):.2f} circuitBreaker={risk.get('circuitBreakerTriggered', False)}\")
  if alerts:
    for a in alerts:
      print(f\"  ALERT [{a['level']}]: {a['message']}\")
except Exception as e:
  print(f'parse error: {e}')
" 2>/dev/null)
  echo "  $health_status"

  # 3. Check for recent errors in the last 5 minutes
  local recent_errors=$(tail -2000 "$LOG_DIR/critical-mass-out.log" 2>/dev/null | grep -i "kalshi" | grep -i "❌\|error\|failed\|crash" | tail -5)
  if [ -n "$recent_errors" ]; then
    echo "  RECENT ERRORS (last 5):"
    echo "$recent_errors" | while read -r line; do echo "    $line"; done
  else
    echo "  No recent Kalshi errors"
  fi

  # 4. Check journal writing (last entry timestamp)
  local today_date=$(date -u '+%Y-%m-%d')
  local journal="$DATA_DIR/journals/$today_date.jsonl"
  if [ -f "$journal" ]; then
    local journal_lines=$(wc -l < "$journal" | tr -d ' ')
    local last_entry=$(tail -1 "$journal" 2>/dev/null | python3 -c "
import json, sys
try:
  d = json.load(sys.stdin)
  print(f\"type={d.get('type')} ts={d.get('ts', 'N/A')[:19]} ticker={d.get('ticker', 'N/A')[:30]}\")
except:
  print('parse error')
" 2>/dev/null)
    echo "  Journal: $journal_lines entries, last: $last_entry"
  else
    echo "  WARNING: No journal file for today ($today_date)"
  fi

  # 5. Check state.json
  local state_info=$(python3 -c "
import json
with open('$DATA_DIR/state.json') as f:
  d = json.load(f)
print(f\"engineRunning={d.get('engineRunning')} positions={len(d.get('positions', []))} balance=\${d.get('balance', {}).get('available', 0):.2f} lastUpdated={d.get('lastUpdated', 'N/A')[:19]}\")
" 2>/dev/null)
  echo "  State: $state_info"

  # 6. Check Kalshi-specific error log lines in last 5 min  
  local error_log_lines=$(tail -100 "$LOG_DIR/critical-mass-error.log" 2>/dev/null | grep -i kalshi | tail -3)
  if [ -n "$error_log_lines" ]; then
    echo "  ERROR LOG:"
    echo "$error_log_lines" | while read -r line; do echo "    $line"; done
  fi

  echo ""
}

echo "Kalshi Monitor started at $(date '+%Y-%m-%d %H:%M:%S')"
echo "Checking every 300 seconds (5 minutes)"
echo "Logging to: $MONITOR_LOG"
echo ""

while true; do
  check_health 2>&1 | tee -a "$MONITOR_LOG"
  sleep 300
done
