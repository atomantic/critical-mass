/**
 * Trade Analyst Service
 *
 * Calls a configurable AI provider (via portos-ai-toolkit provider config) after
 * every position resolution (settlement, exit, forced-exit, reconciliation) to get
 * structured post-trade analysis. Results are persisted to JSONL and emitted via
 * Socket.IO.
 *
 * CONFIG_CHANGE recommendations are auto-applied when confidence is HIGH.
 * All changes are logged and persisted for auditability.
 */

const { spawn } = require('child_process')
const { appendFile, mkdir, readFile, writeFile } = require('fs/promises')
const { existsSync } = require('fs')
const path = require('path')

const ts = () => new Date().toISOString().slice(11, 23)

const DATA_DIR = path.join(__dirname, '..', '..', '..', 'data')
const ANALYSES_DIR = path.join(DATA_DIR, 'kalshi', 'analyses')
const STRATEGY_GUIDE_PATH = path.join(__dirname, '..', '..', '..', 'STRATEGY-GUIDE.md')
const CONFIG_PATH = path.join(DATA_DIR, 'kalshi', 'config.json')
const PROVIDERS_PATH = path.join(DATA_DIR, 'providers.json')

/** @type {import('socket.io').Server | null} */
let io = null

/** @type {Function | null} Callback to reload strategy in engine after config change */
let onConfigChange = null

/** @type {number} epoch ms of last analysis spawn */
let lastAnalysisAt = 0
const MIN_INTERVAL_MS = 2 * 60 * 1000 // 2 minutes

/** @type {number} analyses spawned today (UTC) */
let dailyCount = 0
let dailyCountDate = ''
const MAX_DAILY = 50

/**
 * Initialize the trade analyst service
 * @param {{ io?: import('socket.io').Server, onConfigChange?: Function }} opts
 */
const initTradeAnalyst = ({ io: ioServer, onConfigChange: cb } = {}) => {
  io = ioServer || null
  onConfigChange = cb || null
  console.log(`[${ts()}] 🧠 Trade analyst service initialized`)
}

/**
 * Reset daily counter if date has changed (UTC)
 */
const checkDailyReset = () => {
  const today = new Date().toISOString().slice(0, 10)
  if (today !== dailyCountDate) {
    dailyCount = 0
    dailyCountDate = today
  }
}

/**
 * Check rate limits — returns true if analysis should proceed
 * @returns {boolean}
 */
const canAnalyze = () => {
  const now = Date.now()
  if (now - lastAnalysisAt < MIN_INTERVAL_MS) return false
  checkDailyReset()
  if (dailyCount >= MAX_DAILY) return false
  return true
}

/**
 * Load AI provider config from data/providers.json (portos-ai-toolkit format).
 * Returns the active provider or a default claude-code fallback.
 * @returns {Promise<{ type: string, command?: string, args?: string[], envVars?: Object, endpoint?: string, apiKey?: string, defaultModel?: string, heavyModel?: string }>}
 */
const loadProvider = async () => {
  if (!existsSync(PROVIDERS_PATH)) {
    // Fallback: default claude CLI provider
    return {
      type: 'cli',
      command: 'claude',
      args: ['--print'],
      envVars: {},
      defaultModel: 'claude-sonnet-4-6',
      heavyModel: 'claude-opus-4-6'
    }
  }

  const raw = await readFile(PROVIDERS_PATH, 'utf-8')
  const data = JSON.parse(raw.trim())
  const activeId = data.activeProvider
  const provider = data.providers?.[activeId]

  if (!provider?.enabled) {
    // Find first enabled provider
    const enabled = Object.values(data.providers || {}).find(p => p.enabled)
    return enabled || {
      type: 'cli',
      command: 'claude',
      args: ['--print'],
      envVars: {},
      defaultModel: 'claude-sonnet-4-6',
      heavyModel: 'claude-opus-4-6'
    }
  }

  return provider
}

/**
 * Build the prompt for AI analysis
 */
const buildPrompt = ({
  trade,
  resolutionType,
  btcSpot,
  winningSide,
  strategyConfig,
  strategyPerformance,
  recentJournal,
  strategyGuide
}) => {
  const parts = [
    'You are a quantitative trading analyst reviewing a completed trade on Kalshi prediction markets.',
    'Analyze this trade resolution and provide structured feedback.',
    'If you recommend a config change, provide the EXACT JSON path and value so it can be auto-applied.',
    '',
    '## Trade Resolution',
    `- Type: ${resolutionType}`,
    `- Ticker: ${trade.ticker}`,
    `- Strategy: ${trade.strategy}`,
    `- Side: ${trade.side}`,
    `- Contracts: ${trade.count}`,
    `- Entry Price: ${trade.costBasis ? Math.round((trade.costBasis / trade.count) * 100) : 'unknown'}¢`,
    `- Exit Price: ${trade.price}¢`,
    `- P&L: $${(trade.pnl ?? 0).toFixed(2)}`,
    `- Fee: $${(trade.fee ?? 0).toFixed(2)}`,
    `- Reason: ${trade.reason || 'N/A'}`,
  ]

  if (btcSpot) parts.push(`- BTC Spot: $${btcSpot.toLocaleString()}`)
  if (winningSide) parts.push(`- Winning Side: ${winningSide}`)

  if (strategyConfig) {
    parts.push('', '## Strategy Config', '```json', JSON.stringify(strategyConfig, null, 2), '```')
  }

  if (strategyPerformance) {
    parts.push('', '## Strategy Performance', '```json', JSON.stringify(strategyPerformance, null, 2), '```')
  }

  if (recentJournal?.length) {
    parts.push('', '## Recent Journal (last 10 entries/exits/settlements for this strategy)')
    for (const entry of recentJournal.slice(-10)) {
      parts.push(`- [${entry.type}] ${entry.ticker} ${entry.side} ${entry.contracts}x @ ${entry.price ?? entry.costBasis ?? '?'}¢ P&L:$${(entry.pnl ?? 0).toFixed(2)}`)
    }
  }

  if (strategyGuide) {
    parts.push('', '## STRATEGY-GUIDE.md (full reference — DO NOT recommend changes that have already been tried and failed)', '```', strategyGuide, '```')
  }

  parts.push(
    '',
    '## Response Format',
    'Respond with EXACTLY these fields, one per line, with the label followed by a colon and space:',
    '',
    'VERDICT: GOOD_TRADE | BAD_ENTRY | BAD_EXIT | UNLUCKY | NEEDS_INVESTIGATION',
    'REASONING: 2-3 sentences explaining why',
    'PATTERN: Any recurring pattern in recent trades, or "No clear pattern"',
    'RECOMMENDATION: NO_CHANGE | CONFIG_CHANGE | CODE_CHANGE: <description> | NEEDS_DATA',
    'CONFIG_PARAM: <dot-path param name, e.g. edgeThreshold> (only if RECOMMENDATION is CONFIG_CHANGE)',
    'CONFIG_VALUE: <new value, e.g. 0.20> (only if RECOMMENDATION is CONFIG_CHANGE)',
    'CONFIG_REASON: <why this change helps, 1 sentence> (only if RECOMMENDATION is CONFIG_CHANGE)',
    'CONFIDENCE: LOW | MEDIUM | HIGH',
    'PRIORITY: NONE | LOW | MEDIUM | HIGH',
    '',
    'Do NOT output anything else. No markdown headers, no extra commentary.',
    'CONFIG_PARAM must be a direct property of the strategy config object (e.g. edgeThreshold, forceExitSeconds, maxBetPct).',
    'CONFIG_VALUE must be a valid JSON literal (number, boolean, or quoted string).'
  )

  return parts.join('\n')
}

/**
 * Parse structured response from AI output
 * @param {string} output
 * @returns {Object}
 */
const parseResponse = (output) => {
  const fields = {}
  const lines = output.split('\n')
  for (const line of lines) {
    const match = line.match(/^(VERDICT|REASONING|PATTERN|RECOMMENDATION|CONFIG_PARAM|CONFIG_VALUE|CONFIG_REASON|CONFIDENCE|PRIORITY):\s*(.+)$/i)
    if (match) {
      fields[match[1].toLowerCase()] = match[2].trim()
    }
  }
  return fields
}

/**
 * Auto-apply a CONFIG_CHANGE recommendation to config.json.
 * Only applies when confidence is HIGH and the param path is valid.
 * @param {string} strategyName
 * @param {string} paramName - Direct property name (e.g. "edgeThreshold")
 * @param {string} rawValue - Raw value string from AI (e.g. "0.20")
 * @param {string} reason - Why the change was recommended
 * @returns {Promise<{ applied: boolean, oldValue: any, newValue: any, error?: string }>}
 */
const applyConfigChange = async (strategyName, paramName, rawValue, reason) => {
  if (!paramName || !rawValue) {
    return { applied: false, oldValue: null, newValue: null, error: 'Missing param or value' }
  }

  // Safety: reject dot-paths or deeply nested params (only direct strategy properties)
  if (paramName.includes('.') || paramName.includes('[')) {
    return { applied: false, oldValue: null, newValue: null, error: 'Only direct strategy properties allowed' }
  }

  // Safety: reject changes to risk controls documented in STRATEGY-GUIDE.md
  const protectedParams = ['maxDailyLoss', 'maxEdgeSanity']
  if (protectedParams.includes(paramName)) {
    return { applied: false, oldValue: null, newValue: null, error: `Protected param: ${paramName}` }
  }

  // Parse the value
  let newValue
  if (rawValue === 'true') newValue = true
  else if (rawValue === 'false') newValue = false
  else if (rawValue === 'null') newValue = null
  else if (/^-?\d+(\.\d+)?$/.test(rawValue)) newValue = parseFloat(rawValue)
  else if (rawValue.startsWith('"') && rawValue.endsWith('"')) newValue = rawValue.slice(1, -1)
  else newValue = rawValue

  // Read current config
  const raw = await readFile(CONFIG_PATH, 'utf-8')
  const config = JSON.parse(raw.trim())

  if (!config.strategies?.[strategyName]) {
    return { applied: false, oldValue: null, newValue, error: `Strategy ${strategyName} not in config` }
  }

  const oldValue = config.strategies[strategyName][paramName]

  // Don't apply if value is already the same
  if (oldValue === newValue) {
    return { applied: false, oldValue, newValue, error: 'Value unchanged' }
  }

  // Apply the change
  config.strategies[strategyName][paramName] = newValue

  // Atomic write
  const tmp = `${CONFIG_PATH}.${process.pid}.tmp`
  await writeFile(tmp, JSON.stringify(config, null, 2))
  const { rename } = require('fs/promises')
  await rename(tmp, CONFIG_PATH)

  console.log(`[${ts()}] 🧠 Config auto-applied: ${strategyName}.${paramName} ${JSON.stringify(oldValue)} → ${JSON.stringify(newValue)} (${reason})`)

  // Notify engine to reload strategy
  if (onConfigChange) {
    onConfigChange(strategyName, config.strategies[strategyName])
  }

  if (io) {
    io.emit('kalshi:config-change', {
      strategy: strategyName,
      param: paramName,
      oldValue,
      newValue,
      reason,
      timestamp: new Date().toISOString()
    })
  }

  return { applied: true, oldValue, newValue }
}

/**
 * Execute AI call via CLI provider (claude, codex, gemini-cli, etc.)
 * @param {Object} provider
 * @param {string} prompt
 * @returns {Promise<string>}
 */
const executeCliProvider = (provider, prompt) => {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, ...(provider.envVars || {}) }
    delete env.CLAUDECODE // Prevents nested session error for claude CLI

    const model = provider.heavyModel || provider.defaultModel
    const args = [...(provider.args || [])]

    // Add model flag for claude CLI
    if (provider.command === 'claude' && model) {
      args.push('--model', model, '--output-format', 'text', '--tools', '', '--no-session-persistence', '--max-budget-usd', '0.10')
    }

    args.push(prompt)

    const child = spawn(provider.command, args, {
      env,
      stdio: ['ignore', 'pipe', 'pipe']
    })

    let stdout = ''
    let stderr = ''

    child.stdout.on('data', (chunk) => { stdout += chunk.toString() })
    child.stderr.on('data', (chunk) => { stderr += chunk.toString() })

    const timeout = setTimeout(() => {
      child.kill('SIGTERM')
      reject(new Error('Analysis timed out (2min)'))
    }, 120_000)

    child.on('close', (code) => {
      clearTimeout(timeout)
      if (code !== 0) {
        reject(new Error(`Exit ${code}: ${stderr.slice(0, 200)}`))
      } else {
        resolve(stdout)
      }
    })

    child.on('error', (err) => {
      clearTimeout(timeout)
      reject(err)
    })
  })
}

/**
 * Execute AI call via API provider (OpenAI-compatible endpoint)
 * @param {Object} provider
 * @param {string} model
 * @param {string} prompt
 * @returns {Promise<string>}
 */
const executeApiProvider = async (provider, prompt) => {
  const model = provider.heavyModel || provider.defaultModel
  const headers = { 'Content-Type': 'application/json' }
  if (provider.apiKey) {
    headers['Authorization'] = `Bearer ${provider.apiKey}`
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 120_000)

  const response = await fetch(`${provider.endpoint}/chat/completions`, {
    method: 'POST',
    headers,
    signal: controller.signal,
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
      stream: false
    })
  })

  clearTimeout(timeout)

  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new Error(`API ${response.status}: ${body.slice(0, 200)}`)
  }

  const data = await response.json()
  return data.choices?.[0]?.message?.content || ''
}

/**
 * Get the analysis file path for a given date
 * @param {string} [date]
 * @returns {string}
 */
const getAnalysisPath = (date) => {
  const dateStr = date || new Date().toISOString().slice(0, 10)
  return path.join(ANALYSES_DIR, `${dateStr}.jsonl`)
}

/**
 * Persist analysis record to JSONL
 * @param {Object} record
 */
const saveAnalysis = async (record) => {
  if (!existsSync(ANALYSES_DIR)) {
    await mkdir(ANALYSES_DIR, { recursive: true })
  }
  const line = JSON.stringify(record) + '\n'
  await appendFile(getAnalysisPath(), line)
}

/**
 * Load context for the analysis prompt
 * @param {string} strategyName
 * @param {Array} trades - All trades from state
 * @returns {Promise<{ strategyConfig: Object|null, strategyPerformance: Object|null, recentJournal: Array, strategyGuide: string }>}
 */
const loadContext = async (strategyName, trades) => {
  let strategyConfig = null
  let strategyGuide = ''

  if (existsSync(CONFIG_PATH)) {
    const raw = await readFile(CONFIG_PATH, 'utf-8').catch(() => '{}')
    const config = JSON.parse(raw.trim() || '{}')
    strategyConfig = config.strategies?.[strategyName] ?? null
  }

  if (existsSync(STRATEGY_GUIDE_PATH)) {
    strategyGuide = await readFile(STRATEGY_GUIDE_PATH, 'utf-8').catch(() => '')
  }

  const stratTrades = (trades || []).filter(t =>
    t.strategy === strategyName && (t.action === 'sell' || t.action === 'settlement')
  )
  const wins = stratTrades.filter(t => (t.pnl ?? 0) > 0).length
  const losses = stratTrades.filter(t => (t.pnl ?? 0) <= 0).length
  const totalPnl = stratTrades.reduce((s, t) => s + (t.pnl ?? 0), 0)
  const strategyPerformance = {
    trades: stratTrades.length,
    wins,
    losses,
    winRate: stratTrades.length > 0 ? Math.round((wins / stratTrades.length) * 1000) / 10 : 0,
    totalPnl: Math.round(totalPnl * 100) / 100
  }

  const recentJournal = stratTrades.slice(-10)

  return { strategyConfig, strategyPerformance, recentJournal, strategyGuide }
}

/**
 * Analyze a completed trade by calling the configured AI provider.
 * Fire-and-forget from engine perspective — never blocks eval loop.
 *
 * @param {Object} params
 * @param {Object} params.trade - Trade resolution record
 * @param {string} params.resolutionType - 'settlement' | 'exit' | 'forced-exit' | 'reconciliation'
 * @param {number} [params.btcSpot] - BTC spot at resolution
 * @param {string} [params.winningSide] - 'yes' | 'no'
 * @param {Array} [params.trades] - All trades from state for context
 */
const analyzeTrade = async ({ trade, resolutionType, btcSpot, winningSide, trades }) => {
  // Skip shadow trades and entries (only analyze at resolution)
  if (trade.strategy === 'shadow' || trade.action === 'buy') return

  if (!canAnalyze()) {
    console.log(`[${ts()}] 🧠 Analysis skipped (rate limited): ${trade.ticker}`)
    return
  }

  lastAnalysisAt = Date.now()
  dailyCount++

  console.log(`[${ts()}] 🧠 Trade analysis queued: ${resolutionType} ${trade.ticker} ${trade.strategy} P&L:$${(trade.pnl ?? 0).toFixed(2)}`)

  const { strategyConfig, strategyPerformance, recentJournal, strategyGuide } = await loadContext(
    trade.strategy, trades
  ).catch(err => {
    console.log(`[${ts()}] 🧠 Context load error: ${err.message}`)
    return { strategyConfig: null, strategyPerformance: null, recentJournal: [], strategyGuide: '' }
  })

  const prompt = buildPrompt({
    trade,
    resolutionType,
    btcSpot,
    winningSide,
    strategyConfig,
    strategyPerformance,
    recentJournal,
    strategyGuide
  })

  // Load configured AI provider
  const provider = await loadProvider().catch(err => {
    console.log(`[${ts()}] 🧠 Provider load error: ${err.message}`)
    return { type: 'cli', command: 'claude', args: ['--print'], envVars: {}, heavyModel: 'claude-opus-4-6' }
  })

  let output
  if (provider.type === 'api') {
    output = await executeApiProvider(provider, prompt)
  } else {
    output = await executeCliProvider(provider, prompt)
  }

  const parsed = parseResponse(output)

  const record = {
    ts: new Date().toISOString(),
    ticker: trade.ticker,
    strategy: trade.strategy,
    resolutionType,
    pnl: trade.pnl ?? 0,
    provider: provider.name || provider.command || 'unknown',
    verdict: parsed.verdict || 'UNKNOWN',
    reasoning: parsed.reasoning || '',
    pattern: parsed.pattern || '',
    recommendation: parsed.recommendation || '',
    configParam: parsed.config_param || null,
    configValue: parsed.config_value || null,
    configReason: parsed.config_reason || null,
    confidence: parsed.confidence || 'LOW',
    priority: parsed.priority || 'NONE',
    applied: false,
    rawOutput: output.slice(0, 2000)
  }

  // Auto-apply CONFIG_CHANGE when confidence is HIGH
  if (
    parsed.recommendation?.toUpperCase()?.startsWith('CONFIG_CHANGE') &&
    parsed.config_param &&
    parsed.config_value &&
    parsed.confidence?.toUpperCase() === 'HIGH'
  ) {
    const result = await applyConfigChange(
      trade.strategy,
      parsed.config_param,
      parsed.config_value,
      parsed.config_reason || parsed.reasoning || 'AI recommendation'
    ).catch(err => ({ applied: false, error: err.message }))

    record.applied = result.applied
    record.appliedOldValue = result.oldValue ?? null
    record.appliedError = result.error ?? null

    if (result.applied) {
      console.log(`[${ts()}] 🧠 Config change applied: ${trade.strategy}.${parsed.config_param} = ${parsed.config_value}`)
    } else {
      console.log(`[${ts()}] 🧠 Config change skipped: ${result.error}`)
    }
  } else if (parsed.recommendation?.toUpperCase()?.startsWith('CONFIG_CHANGE')) {
    console.log(`[${ts()}] 🧠 Config change logged (not applied, confidence=${parsed.confidence}): ${parsed.config_param} = ${parsed.config_value}`)
  }

  await saveAnalysis(record).catch(err => {
    console.log(`[${ts()}] 🧠 Analysis save error: ${err.message}`)
  })

  console.log(`[${ts()}] 🧠 Analysis saved: ${trade.ticker} ${record.verdict} (${record.confidence}) -- ${(record.recommendation || '').slice(0, 80)}`)

  if (io) {
    io.emit('kalshi:analysis', record)
  }
}

/**
 * Read analyses for a given date
 * @param {string} [date] - ISO date string (YYYY-MM-DD)
 * @returns {Promise<Array<Object>>}
 */
const readAnalyses = async (date) => {
  const filePath = getAnalysisPath(date)
  if (!existsSync(filePath)) return []

  const content = await readFile(filePath, 'utf-8')
  const lines = content.trim().split('\n').filter(Boolean)
  return lines.map(line => JSON.parse(line))
}

module.exports = {
  initTradeAnalyst,
  analyzeTrade,
  readAnalyses
}
