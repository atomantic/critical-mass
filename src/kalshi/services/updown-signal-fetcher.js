/**
 * UpDown Signal Fetcher
 *
 * Polls the UpDown gateway for the latest directional signal.
 * Provides synchronous access via getCachedSignal() for strategy eval.
 * Never throws — strategies always get a usable signal.
 */

const { ts } = require('../../time-utils')

const NEUTRAL_SIGNAL = {
  type: null,
  score: 0,
  confidence: 0,
  trendBias: null,
  stale: true,
  running: false,
  lastPrice: null,
  fetchedAt: 0,
}

const CACHE_TTL_MS = 10_000

/** @type {typeof NEUTRAL_SIGNAL} */
let cached = { ...NEUTRAL_SIGNAL }

/** @type {NodeJS.Timeout | null} */
let pollTimer = null

/** @type {string} */
let gatewayUrl = 'http://127.0.0.1:5563/api/updown/signal'

/** @type {number} */
let pollIntervalMs = 5000

/**
 * Configure the fetcher (call before startPolling)
 * @param {{ gatewayUrl?: string, pollIntervalMs?: number }} opts
 */
const configure = (opts = {}) => {
  if (opts.gatewayUrl) gatewayUrl = opts.gatewayUrl
  if (opts.pollIntervalMs > 0) pollIntervalMs = opts.pollIntervalMs
}

/**
 * Fetch the latest signal from the UpDown gateway
 */
const fetchSignal = async () => {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 3000)
  try {
    const res = await fetch(gatewayUrl, { signal: controller.signal })
    const data = await res.json()
    if (!data.success) {
      console.log(`[${ts()}] [updown-fetcher] Gateway returned success=false`)
      return
    }
    const sig = data.signal
    cached = {
      type: sig?.type ?? null,
      score: sig?.score ?? 0,
      confidence: sig?.confidence ?? 0,
      trendBias: data.trendFilter ?? null,
      stale: false,
      running: data.running ?? false,
      lastPrice: data.lastPrice ?? null,
      fetchedAt: Date.now(),
    }
  } catch {
    // Gateway unreachable — mark stale, keep last known values for logging
    cached = { ...cached, stale: true }
    console.log(`[${ts()}] [updown-fetcher] Gateway unreachable, using NEUTRAL fallback`)
  } finally {
    clearTimeout(timeout)
  }
}

/**
 * Return the cached signal (synchronous).
 * Returns NEUTRAL if cache is stale (> CACHE_TTL_MS old).
 * @returns {typeof NEUTRAL_SIGNAL}
 */
const getCachedSignal = () => {
  if (Date.now() - cached.fetchedAt > CACHE_TTL_MS) {
    return { ...NEUTRAL_SIGNAL }
  }
  return { ...cached }
}

/** @param {typeof NEUTRAL_SIGNAL} signal */
const isBullish = (signal) => signal.type === 'BUY' || signal.type === 'STRONG_BUY'

/** @param {typeof NEUTRAL_SIGNAL} signal */
const isBearish = (signal) => signal.type === 'SELL' || signal.type === 'STRONG_SELL'

const startPolling = () => {
  if (pollTimer) return
  console.log(`[${ts()}] [updown-fetcher] Polling started (${pollIntervalMs}ms, ${gatewayUrl})`)
  // Fire first fetch immediately
  fetchSignal()
  pollTimer = setInterval(fetchSignal, pollIntervalMs)
}

const stopPolling = () => {
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
    console.log(`[${ts()}] [updown-fetcher] Polling stopped`)
  }
  cached = { ...NEUTRAL_SIGNAL }
}

module.exports = {
  configure,
  getCachedSignal,
  isBullish,
  isBearish,
  startPolling,
  stopPolling,
}
