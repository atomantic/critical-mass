// @ts-check
/**
 * Hedge Routes
 *
 * REST API for the hedge engine. Mounted at /api/hedge/ in server.js.
 * Follows critical-mass route pattern: module.exports = (app, sharedDeps) => { ... }
 */

const { log } = require('../logger')
const { getHedgeConfig, updateHedgeConfig } = require('../config-utils')
const { createHedgeEngine } = require('../hedge/hedge-engine')
const { loadState } = require('../hedge/hedge-state')
const { createDryRunTracker, generateDecisionReport, saveDecisionReport } = require('../hedge/hedge-dry-run')
const { prefixedTs } = require('../time-utils')
const { createAsyncHandler } = require('./async-handler')
const { loadKalshiKeys } = require('../kalshi/load-keys')

const ts = () => prefixedTs('HEDGE')
const asyncHandler = createAsyncHandler('hedge', ts)

/**
 * @param {import('express').Application} app
 * @param {Object} sharedDeps
 */
module.exports = (app, sharedDeps) => {
  const { io } = sharedDeps

  /** @type {ReturnType<typeof createHedgeEngine> | null} */
  let engine = null

  /** @type {ReturnType<typeof createDryRunTracker> | null} */
  let dryRunTracker = null

  // ====== STATUS ======

  app.get('/api/hedge/status', asyncHandler(async (req, res) => {
    if (!engine) {
      const state = loadState()
      return res.json({
        running: false,
        dryRun: true,
        dailyStats: state.dailyStats,
        aggregateStats: state.aggregateStats,
      })
    }
    res.json(engine.getStatus())
  }))

  // ====== CONFIG ======

  app.get('/api/hedge/config', asyncHandler(async (req, res) => {
    res.json(getHedgeConfig())
  }))

  app.post('/api/hedge/config', asyncHandler(async (req, res) => {
    const updates = req.body
    updateHedgeConfig(updates)

    if (engine) {
      engine.reloadConfig()
    }

    res.json({ success: true, config: getHedgeConfig() })
  }))

  // ====== ENGINE CONTROL ======

  app.post('/api/hedge/start', asyncHandler(async (req, res) => {
    if (engine) {
      const status = engine.getStatus()
      if (status.running) {
        return res.status(400).json({ error: 'Engine already running' })
      }
    }

    const config = getHedgeConfig()
    if (!config.enabled) {
      return res.status(400).json({ error: 'Hedge engine is not enabled. Set hedge.enabled=true in config.' })
    }

    // Lazy-load dependencies
    const { getAdapter } = require('../adapters')
    const kalshiApi = require('../kalshi/adapters/api')

    const { keys: kalshiKeys, error: keysError } = loadKalshiKeys()
    if (keysError) return res.status(400).json({ error: keysError })

    const exchangeAdapter = getAdapter(config.exchange)

    // Get price bridge reference (may be null if Kalshi not running)
    const priceBridge = sharedDeps.priceBridge || null

    // Import orderbook service for canFill checks
    let orderbookService = null
    try {
      orderbookService = require('../kalshi/services/kalshi-orderbook-service')
    } catch {
      // orderbook service may not be initialized
    }

    engine = createHedgeEngine({
      exchangeAdapter,
      kalshiApi,
      kalshiKeys,
      getPriceBridgePrice: () => {
        // Try price bridge first, then fall back to adapter
        if (priceBridge) {
          const cached = priceBridge.getCachedPrice?.('BTC-USD')
          if (cached) return cached
        }
        // Fallback: return null, engine will skip eval
        return null
      },
      getPriceHistory: () => {
        // Get price history from price bridge or empty array
        if (priceBridge?.getPriceHistory) return priceBridge.getPriceHistory()
        return []
      },
      canFillCheck: orderbookService
        ? (ticker, side, action, count, slippage) => orderbookService.canFill(ticker, side, action, count, slippage)
        : null,
      callbacks: {
        onStateChange: (state) => io.emit('hedge:state', state),
        onPairOpened: (pair) => io.emit('hedge:pair:opened', pair),
        onPairClosed: (pair) => io.emit('hedge:pair:closed', pair),
      },
    })

    // Initialize dry-run tracker if in dry-run mode
    if (config.dryRun) {
      dryRunTracker = createDryRunTracker(engine.getState())
    }

    const result = engine.start()
    res.json(result)
  }))

  app.post('/api/hedge/stop', asyncHandler(async (req, res) => {
    if (!engine) {
      return res.status(400).json({ error: 'Engine not running' })
    }

    engine.stop()
    res.json({ success: true })
  }))

  // ====== STATE & STATS ======

  app.get('/api/hedge/state', asyncHandler(async (req, res) => {
    const state = engine ? engine.getState() : loadState()
    res.json(state)
  }))

  app.get('/api/hedge/pairs', asyncHandler(async (req, res) => {
    const state = engine ? engine.getState() : loadState()
    const limit = parseInt(req.query.limit) || 50
    const offset = parseInt(req.query.offset) || 0
    const closed = state.closedPairs.slice(-limit - offset, -offset || undefined)
    res.json({
      active: state.activePairs,
      closed,
      total: state.closedPairs.length,
    })
  }))

  // ====== DRY-RUN REPORT ======

  app.get('/api/hedge/report', asyncHandler(async (req, res) => {
    const state = engine ? engine.getState() : loadState()
    const report = generateDecisionReport(state, dryRunTracker)
    res.json(report)
  }))

  app.post('/api/hedge/report/save', asyncHandler(async (req, res) => {
    const state = engine ? engine.getState() : loadState()
    const report = generateDecisionReport(state, dryRunTracker)
    const filepath = saveDecisionReport(report)
    res.json({ success: true, filepath, report })
  }))

  // ====== LIFECYCLE ======

  return {
    autoStartEngine: async () => {
      const state = loadState()
      if (!state.engineRunning) return

      const config = getHedgeConfig()
      if (!config.enabled) return

      log('INFO', `[${ts()}] 🔄 Auto-starting hedge engine from previous session...`)

      // Trigger the start endpoint logic
      try {
        // Import dependencies inline (same as start route)
        const { getAdapter } = require('../adapters')
        const kalshiApi = require('../kalshi/adapters/api')

        const { keys: kalshiKeys, error: keysError } = loadKalshiKeys()
        if (keysError) {
          log('WARN', `[${ts()}] ⚠️ Hedge auto-start skipped: ${keysError}`)
          return
        }
        const exchangeAdapter = getAdapter(config.exchange)
        const priceBridge = sharedDeps.priceBridge || null

        let orderbookService = null
        try {
          orderbookService = require('../kalshi/services/kalshi-orderbook-service')
        } catch {
          // non-critical
        }

        engine = createHedgeEngine({
          exchangeAdapter,
          kalshiApi,
          kalshiKeys,
          getPriceBridgePrice: () => priceBridge?.getCachedPrice?.('BTC-USD') || null,
          getPriceHistory: () => priceBridge?.getPriceHistory?.() || [],
          canFillCheck: orderbookService
            ? (ticker, side, action, count, slippage) => orderbookService.canFill(ticker, side, action, count, slippage)
            : null,
          callbacks: {
            onStateChange: (st) => io.emit('hedge:state', st),
            onPairOpened: (pair) => io.emit('hedge:pair:opened', pair),
            onPairClosed: (pair) => io.emit('hedge:pair:closed', pair),
          },
        })

        if (config.dryRun) {
          dryRunTracker = createDryRunTracker(engine.getState())
        }

        engine.start()
        log('INFO', `[${ts()}] ✅ Hedge engine auto-started`)
      } catch (err) {
        log('ERROR', `[${ts()}] ❌ Hedge auto-start failed: ${err.message}`)
      }
    },

    shutdown: () => {
      if (engine) {
        // Preserve engineRunning flag for auto-restart on next boot
        engine.stop()
        engine = null
      }
      dryRunTracker = null
      log('INFO', `[${ts()}] 🛑 Hedge services shut down`)
    },
  }
}
