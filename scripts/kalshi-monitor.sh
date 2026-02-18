#!/bin/bash
# Kalshi Engine Health Monitor (Enhanced)
# Runs continuously, checking every 5 minutes
# Tracks: process health, strategy decisions, P&L, config alignment, errors

LOG_DIR="/Users/antic/github.com/atomantic/critical-mass/logs"
DATA_DIR="/Users/antic/github.com/atomantic/critical-mass/data/kalshi"
API_BASE="http://localhost:5563/api/kalshi"
MONITOR_LOG="$LOG_DIR/kalshi-monitor.log"
BALANCE_LOG="$LOG_DIR/kalshi-balance.csv"

# Initialize balance tracking CSV if needed
if [ ! -f "$BALANCE_LOG" ]; then
  echo "timestamp,available,inPositions,openPositions,dailyPnl,trades,wins" > "$BALANCE_LOG"
fi

check_health() {
  local ts=$(date '+%Y-%m-%d %H:%M:%S')
  echo "===== KALSHI MONITOR CHECK: $ts ====="

  # 1. PM2 process health
  local pm2_info=$(pm2 jlist 2>/dev/null | python3 -c "
import json, sys, datetime
procs = json.load(sys.stdin)
for p in procs:
  if p['name'] == 'critical-mass':
    env = p['pm2_env']
    mon = p['monit']
    uptime_ms = int(datetime.datetime.now().timestamp() * 1000) - env.get('pm_uptime', 0)
    hours = uptime_ms / 3600000
    mem_mb = mon['memory'] // 1024 // 1024
    restarts = env['restart_time']
    status = env['status']
    print(f'status={status} restarts={restarts} uptime={hours:.1f}h memory={mem_mb}MB')
    if status != 'online':
      print('CRITICAL: Process not online!')
    if mem_mb > 250:
      print('WARNING: Memory above 250MB (max restart at 300MB)')
    if hours < 0.1 and restarts > 0:
      print('WARNING: Recent restart detected (uptime < 6 min)')
    break
" 2>/dev/null)
  echo "  PM2: $pm2_info"

  # 2. Health report from API
  local health=$(curl -s --connect-timeout 5 --max-time 10 "$API_BASE/health-report" 2>/dev/null)
  if [ -z "$health" ]; then
    echo "  CRITICAL: API unreachable at $API_BASE"
    echo ""
    return 1
  fi

  echo "$health" | python3 -c "
import json, sys, csv, datetime
try:
  d = json.load(sys.stdin)
  h = d.get('health', 'unknown')
  eng = d.get('engine', {})
  bal = d.get('balance', {})
  today = d.get('today', {})
  risk = d.get('risk', {})
  alerts = d.get('alerts', [])
  strat_perf = d.get('strategyPerformance', {})

  # Core status
  print(f'  health={h} engine={eng.get(\"running\")} mode={eng.get(\"mode\")} markets={eng.get(\"marketsTracked\")}')

  # Balance
  avail = bal.get('available', 0)
  in_pos = bal.get('inPositions', 0)
  open_pos = bal.get('openPositions', 0)
  print(f'  balance: \${avail:.2f} available, \${in_pos:.2f} in positions, {open_pos} open')

  # Today stats
  trades = today.get('trades', 0)
  wins = today.get('wins', 0)
  pnl = today.get('pnl', 0)
  wr = today.get('winRate', 0)
  print(f'  today: {trades} trades, {wins} wins ({wr:.0%}), P&L: \${pnl:.2f}')

  # Risk
  daily_pnl = risk.get('currentDailyPnl', 0)
  max_loss = risk.get('maxDailyLoss', 500)
  cb = risk.get('circuitBreakerTriggered', False)
  pnl_pct = abs(daily_pnl / max_loss * 100) if max_loss else 0
  print(f'  risk: dailyPnl=\${daily_pnl:.2f} ({pnl_pct:.0f}% of max \${max_loss}) circuitBreaker={cb}')
  if cb:
    print('  CRITICAL: Circuit breaker triggered! No new trades.')
  elif pnl_pct > 50:
    print(f'  WARNING: Daily P&L at {pnl_pct:.0f}% of circuit breaker limit')

  # Strategy performance
  if strat_perf:
    print('  --- Strategy Performance ---')
    for name, s in sorted(strat_perf.items()):
      t = s.get('trades', 0)
      w = s.get('wins', 0)
      p = s.get('pnl', 0)
      roi = s.get('roi', 0)
      wr = s.get('winRate', 0)
      emoji = '+' if p >= 0 else '-'
      print(f'    {name:22s} trades={t} wins={w} ({wr:.0%}) pnl=\${p:.2f} roi={roi:.0%}')

  # Alerts
  if alerts:
    print('  --- Alerts ---')
    for a in alerts:
      print(f'    [{a.get(\"level\",\"?\")}] {a.get(\"message\",\"\")}')

  # Write balance CSV row
  ts_iso = datetime.datetime.utcnow().strftime('%Y-%m-%dT%H:%M:%S')
  with open('$BALANCE_LOG', 'a') as f:
    f.write(f'{ts_iso},{avail:.2f},{in_pos:.2f},{open_pos},{daily_pnl:.2f},{trades},{wins}\n')

except Exception as e:
  print(f'  parse error: {e}')
" 2>/dev/null

  # 3. Strategy config validation
  echo "  --- Config Checks ---"
  python3 -c "
import json
with open('$DATA_DIR/config.json') as f:
  cfg = json.load(f)
issues = []

# Check swing-flipper should be shadow per strategy guide
sf = cfg.get('strategies', {}).get('swing-flipper', {})
if sf.get('enabled') and not sf.get('shadow'):
  issues.append('swing-flipper is LIVE but strategy guide says SHADOW')

# Check CFV has explicit forceExitSeconds
cfv_params = cfg.get('strategies', {}).get('coinbase-fair-value', {}).get('params', {})
if 'forceExitSeconds' not in cfv_params:
  issues.append('CFV missing explicit forceExitSeconds (code defaults to 60 but should be explicit)')

# Check settlement ride is disabled
sniper_params = cfg.get('strategies', {}).get('settlement-sniper', {}).get('params', {})
srt = sniper_params.get('settlementRideThreshold', 0.4)
if srt < 1.0:
  issues.append(f'settlement-sniper ride enabled (threshold={srt}) — should be 1.0 per strategy guide')

# Check dryRun is off for live mode
if cfg.get('dryRun'):
  issues.append('dryRun is True but engine running in live mode?')

# Check risk controls haven't been weakened
risk = cfg.get('risk', {})
if risk.get('maxEdgeSanity', 0.85) < 0.85:
  issues.append(f'maxEdgeSanity={risk[\"maxEdgeSanity\"]} is below 0.85 — blocks legitimate signals')
if risk.get('maxDailyLoss', 500) > 500:
  issues.append(f'maxDailyLoss={risk[\"maxDailyLoss\"]} raised above \$500')

if issues:
  for i in issues:
    print(f'  WARNING: {i}')
else:
  print('  config OK (aligned with strategy guide)')
" 2>/dev/null

  # 4. Journal activity in last 5 minutes
  local today_date=$(date -u '+%Y-%m-%d')
  local journal="$DATA_DIR/journals/$today_date.jsonl"
  if [ -f "$journal" ]; then
    local journal_lines=$(wc -l < "$journal" | tr -d ' ')
    python3 -c "
import json, datetime
from collections import Counter

cutoff = (datetime.datetime.utcnow() - datetime.timedelta(minutes=5)).isoformat()
recent_types = Counter()
recent_entries = []
recent_rejects = []
total = 0

with open('$journal') as f:
  for line in f:
    total += 1
    try:
      d = json.loads(line.strip())
      ts = d.get('ts', '')
      if ts >= cutoff:
        t = d.get('type', '?')
        recent_types[t] += 1
        if t in ('entry', 'exit', 'settlement', 'forced-exit'):
          recent_entries.append(d)
        elif t == 'reject':
          recent_rejects.append(d)
    except:
      pass

print(f'  journal: {total} total entries today')
if recent_types:
  parts = ', '.join(f'{k}={v}' for k,v in recent_types.most_common())
  print(f'  last 5 min: {parts}')
else:
  print(f'  last 5 min: no activity')

if recent_entries:
  print(f'  --- Recent Trades (last 5 min) ---')
  for d in recent_entries:
    ts = d.get('ts','')[:19]
    t = d.get('type','')
    strat = d.get('strategy','')
    ticker = d.get('ticker','')[:35]
    side = d.get('side','')
    price = d.get('price','')
    pnl = d.get('pnl','')
    print(f'    {ts} {t} {strat} {ticker} {side} px={price} pnl={pnl}')

if recent_rejects:
  print(f'  --- Recent Rejects (last 5 min) ---')
  for d in recent_rejects:
    ts = d.get('ts','')[:19]
    strat = d.get('strategy','')
    reason = d.get('reason','')
    ticker = d.get('ticker','')[:30]
    print(f'    {ts} {strat}: {reason} ({ticker})')
" 2>/dev/null
  else
    echo "  WARNING: No journal file for today ($today_date)"
  fi

  # 5. Recent errors
  local recent_errors=$(tail -2000 "$LOG_DIR/critical-mass-out.log" 2>/dev/null | grep -i "kalshi" | grep -iE "❌|error|failed|crash|exception" | tail -5)
  if [ -n "$recent_errors" ]; then
    echo "  --- Recent Errors ---"
    echo "$recent_errors" | while read -r line; do echo "    $line"; done
  fi

  local error_log_lines=$(tail -100 "$LOG_DIR/critical-mass-error.log" 2>/dev/null | grep -i kalshi | tail -3)
  if [ -n "$error_log_lines" ]; then
    echo "  --- Error Log ---"
    echo "$error_log_lines" | while read -r line; do echo "    $line"; done
  fi

  # 6. State.json freshness check (use file mtime, not lastUpdated field which only updates on trades)
  python3 -c "
import json, datetime, os
state_path = '$DATA_DIR/state.json'
mtime = os.path.getmtime(state_path)
file_age_min = (datetime.datetime.now().timestamp() - mtime) / 60
with open(state_path) as f:
  d = json.load(f)
pos_count = len(d.get('positions', []))
trade_count = len(d.get('trades', []))
balance = d.get('balance', {}).get('available', 0)
print(f'  state: \${balance:.2f} balance, {pos_count} positions, {trade_count} trades, file updated {file_age_min:.0f}m ago')
if file_age_min > 10:
  print(f'  WARNING: State file not written in {file_age_min:.0f} min (engine may not be saving)')
" 2>/dev/null

  echo ""
}

echo "Kalshi Enhanced Monitor started at $(date '+%Y-%m-%d %H:%M:%S')"
echo "Checking every 300 seconds (5 minutes)"
echo "Logging to: $MONITOR_LOG"
echo "Balance tracking: $BALANCE_LOG"
echo ""

# Run first check immediately
check_health 2>&1 | tee -a "$MONITOR_LOG"

# Then loop every 5 minutes
while true; do
  sleep 300
  check_health 2>&1 | tee -a "$MONITOR_LOG"
done
