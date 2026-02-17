const api = require('./api')

/** Delay helper for rate limiting */
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms))

/** Rate limit delay between paginated API calls (ms) */
const PAGINATION_DELAY = 500

/**
 * @typedef {import('../types/kalshi').KalshiKeys} KalshiKeys
 * @typedef {import('../types/kalshi').KalshiMarket} KalshiMarket
 * @typedef {import('../types/kalshi').ClassifiedMarket} ClassifiedMarket
 * @typedef {import('../types/kalshi').MarketWithDetails} MarketWithDetails
 * @typedef {import('../types/kalshi').MarketClassification} MarketClassification
 * @typedef {import('../types/kalshi').MarketTimeframe} MarketTimeframe
 * @typedef {import('../types/kalshi').CryptoAsset} CryptoAsset
 * @typedef {import('../types/kalshi').SportsLeague} SportsLeague
 * @typedef {import('../types/kalshi').ImpliedProbability} ImpliedProbability
 * @typedef {import('../types/kalshi').CryptoMarketsConfig} CryptoMarketsConfig
 * @typedef {import('../types/kalshi').SportsMarketsConfig} SportsMarketsConfig
 */

/** @type {Record<CryptoAsset, string[]>} */
const CRYPTO_SERIES = {
  BTC: ['KXBTC', 'KXBTCD', 'KXBTC15M']  // Bitcoin price markets (15min + hourly + daily)
}

/** Map series tickers to the timeframes they produce */
const SERIES_TIMEFRAME_MAP = {
  'KXBTC15M': ['15min'],
  'KXBTC': ['hourly'],
  'KXBTCD': ['daily']
}

/** Map Kalshi series tickers to Coinbase product IDs */
const KALSHI_TO_COINBASE = {
  'KXBTC': 'BTC-USD', 'KXBTCD': 'BTC-USD', 'KXBTC15M': 'BTC-USD'
}

/**
 * Parse strike price from market title or ticker
 *
 * Title examples:
 *   "BTC above $95,000 at 3:15 PM?" -> 95000
 *   "ETH above $3,500.50 at 4:00 PM?" -> 3500.50
 *
 * Ticker examples (when title doesn't have strike):
 *   "KXBTC-26FEB0317-B86750" -> 86750 (B = bracket/boundary)
 *   "KXBTC-26FEB0317-T86999.99" -> 86999.99 (T = threshold)
 *   "KXETHD-26FEB0317-T2329.99" -> 2329.99
 *
 * @param {string} title - Market title
 * @param {string} [ticker] - Market ticker (optional, used as fallback)
 * @returns {number | null} Strike price or null if not found
 */
const parseStrikePrice = (title, ticker) => {
  // First try to extract from title (preferred - more explicit)
  if (title) {
    const titleMatch = title.match(/\$([0-9,]+(?:\.[0-9]+)?)/i)
    if (titleMatch) {
      return parseFloat(titleMatch[1].replace(/,/g, ''))
    }
  }

  // Fallback: extract from ticker (e.g., KXBTC-26FEB0317-B86750)
  // Ticker format: SERIES-DATE-TYPE+STRIKE where TYPE is B (bracket) or T (threshold)
  // The strike is the LAST segment after the last dash with B or T prefix
  if (ticker) {
    // Split by dash and get the last segment
    const parts = ticker.split('-')
    const lastPart = parts[parts.length - 1]
    // Match B or T followed by numbers (with optional decimals)
    const tickerMatch = lastPart.match(/^[BT](\d+(?:\.\d+)?)$/i)
    if (tickerMatch) {
      return parseFloat(tickerMatch[1])
    }
  }

  return null
}

/**
 * Get Coinbase ticker for a Kalshi market ticker
 * @param {string} kalshiTicker - Kalshi market ticker (e.g., 'KXBTC-25JAN31-T0930-B95000')
 * @returns {string | null} Coinbase product ID or null
 */
const getCoinbaseTickerForKalshi = (kalshiTicker) => {
  if (!kalshiTicker) return null
  const upper = kalshiTicker.toUpperCase()
  for (const [prefix, coinbaseTicker] of Object.entries(KALSHI_TO_COINBASE)) {
    if (upper.startsWith(prefix)) {
      return coinbaseTicker
    }
  }
  return null
}

/** @type {SportsLeague[]} */
const SPORTS_CATEGORIES = ['NFL', 'NBA', 'MLB', 'NHL', 'NCAAF', 'NCAAB', 'MLS', 'SOCCER']

/**
 * Detect market timeframe from ticker pattern first, then fall back to close time heuristic.
 * KXBTC bracket markets (B-prefix strikes) use close_time heuristic since the series name
 * doesn't encode the settlement interval — but they're never classified as '15min' unless
 * the ticker explicitly contains '15M'.
 * @param {KalshiMarket} market - Market to analyze
 * @returns {MarketTimeframe} Detected timeframe
 */
const detectTimeframe = (market) => {
  const ticker = market.ticker?.toUpperCase() || ''
  const eventTicker = market.event_ticker?.toUpperCase() || ''

  // Check ticker/series pattern first (most reliable)
  if (ticker.includes('15M') || eventTicker.includes('15M')) return '15min'
  if (ticker.includes('1H') || eventTicker.includes('1H')) return 'hourly'
  if (ticker.includes('KXBTCD') || eventTicker.includes('KXBTCD')) return 'daily'

  // KXBTC bracket markets (e.g., KXBTC-26FEB1519-B68375) don't encode their interval
  // in the ticker. Use close_time heuristic but DON'T classify as '15min' — bracket
  // markets that happen to be near settlement are still their original timeframe.
  if (!market.close_time) return 'unknown'

  const closeTime = new Date(market.close_time)
  const now = new Date()
  const diffMs = closeTime - now
  const diffMins = diffMs / (1000 * 60)

  // For bracket markets without explicit timeframe, use conservative classification:
  // Even if close in 10 min, it's likely an hourly/daily bracket, not a 15-min market.
  if (diffMins <= 70) return 'hourly'
  if (diffMins <= 6 * 60) return '6hour'
  if (diffMins <= 26 * 60) return 'daily'
  return 'weekly'
}

/**
 * Classify market type from ticker/title
 * @param {KalshiMarket} market - Market to classify
 * @returns {MarketClassification} Market classification
 */
const classifyMarket = (market) => {
  const ticker = market.ticker?.toUpperCase() || ''
  const title = market.title?.toUpperCase() || ''
  const eventTicker = market.event_ticker?.toUpperCase() || ''

  // Check crypto markets
  for (const [asset, patterns] of Object.entries(CRYPTO_SERIES)) {
    if (patterns.some(p => ticker.includes(p) || eventTicker.includes(p))) {
      return { type: 'crypto', asset, timeframe: detectTimeframe(market) }
    }
  }

  // Check for crypto keywords in title
  const cryptoKeywords = ['BITCOIN', 'BTC']
  for (const keyword of cryptoKeywords) {
    if (title.includes(keyword)) {
      return { type: 'crypto', asset: 'BTC', timeframe: detectTimeframe(market) }
    }
  }

  // Check sports markets
  for (const sport of SPORTS_CATEGORIES) {
    if (ticker.includes(sport) || title.includes(sport) || eventTicker.includes(sport)) {
      return { type: 'sports', sport, timeframe: 'game' }
    }
  }

  return { type: 'other', timeframe: detectTimeframe(market) }
}

/**
 * Fetch markets for specific series tickers (more efficient than fetching all)
 * @param {KalshiKeys} keys - API keys
 * @param {string[]} seriesTickers - Series tickers to fetch
 * @returns {Promise<KalshiMarket[]>} Markets matching the series
 */
const fetchMarketsBySeries = async (keys, seriesTickers) => {
  const allMarkets = []

  // Fetch each series separately - much more efficient than fetching all
  for (const seriesTicker of seriesTickers) {
    let cursor = null
    do {
      const response = await api.getMarkets(keys, {
        status: 'open',
        series_ticker: seriesTicker,
        limit: 100,
        cursor
      })
      allMarkets.push(...(response.markets || []))
      cursor = response.cursor
      if (cursor) await delay(PAGINATION_DELAY)
    } while (cursor)

    // Small delay between series to avoid rate limits
    if (seriesTickers.indexOf(seriesTicker) < seriesTickers.length - 1) {
      await delay(PAGINATION_DELAY)
    }
  }

  return allMarkets
}

/**
 * Fetch and filter crypto markets
 * @param {KalshiKeys} keys - API keys
 * @param {CryptoMarketsConfig} [config={}] - Filter configuration
 * @returns {Promise<ClassifiedMarket[]>} Filtered and classified markets
 */
const getCryptoMarkets = async (keys, config = {}) => {
  const { assets = ['BTC'], timeframes = ['15min'] } = config

  // Get series tickers for requested assets, filtered to only series that
  // produce the requested timeframes (avoids fetching daily/weekly when not needed)
  const allSeries = assets.flatMap(asset => CRYPTO_SERIES[asset] || [])
  const seriesTickers = allSeries.filter(series => {
    const produces = SERIES_TIMEFRAME_MAP[series]
    return !produces || produces.some(tf => timeframes.includes(tf))
  })

  if (seriesTickers.length === 0) return []

  // Fetch only the series we need
  const markets = await fetchMarketsBySeries(keys, seriesTickers)

  // Classify and filter by timeframe
  return markets
    .map(m => ({ ...m, ...classifyMarket(m) }))
    .filter(m => timeframes.includes(m.timeframe))
    .sort((a, b) => new Date(a.close_time) - new Date(b.close_time))
}

/**
 * Fetch and filter sports markets
 * NOTE: Kalshi API doesn't support direct sport category filtering,
 * so we use timestamp filters to limit results and filter client-side.
 * @param {KalshiKeys} keys - API keys
 * @param {SportsMarketsConfig} [config={}] - Filter configuration
 * @returns {Promise<ClassifiedMarket[]>} Filtered and classified markets
 */
const getSportsMarkets = async (keys, config = {}) => {
  const { leagues = ['NFL', 'NBA'], maxTimeToSettle = 86400 } = config

  const allMarkets = []
  let cursor = null
  const now = Date.now()
  const maxCloseTs = Math.floor((now + (maxTimeToSettle * 1000)) / 1000)

  do {
    const response = await api.getMarkets(keys, {
      status: 'open',
      max_close_ts: maxCloseTs, // Only get markets closing within our timeframe
      limit: 100,
      cursor
    })

    allMarkets.push(...(response.markets || []))
    cursor = response.cursor
    if (cursor) await delay(PAGINATION_DELAY)
  } while (cursor)

  return allMarkets
    .map(m => ({ ...m, ...classifyMarket(m) }))
    .filter(m => m.type === 'sports' && leagues.includes(m.sport))
    .sort((a, b) => new Date(a.close_time) - new Date(b.close_time))
}

/**
 * Get all tradeable markets with classification
 * WARNING: This fetches ALL markets and can be slow/expensive.
 * Prefer getCryptoMarkets() or getSportsMarkets() for filtered queries.
 * @param {KalshiKeys} keys - API keys
 * @param {Record<string, unknown>} [config={}] - Optional configuration
 * @returns {Promise<ClassifiedMarket[]>} All classified markets
 */
const getAllMarkets = async (keys, config = {}) => {
  const allMarkets = []
  let cursor = null

  do {
    const response = await api.getMarkets(keys, {
      status: 'open',
      limit: 100,
      cursor
    })

    allMarkets.push(...(response.markets || []))
    cursor = response.cursor
    if (cursor) await delay(PAGINATION_DELAY)
  } while (cursor)

  return allMarkets
    .map(m => ({ ...m, ...classifyMarket(m) }))
    .sort((a, b) => new Date(a.close_time) - new Date(b.close_time))
}

/**
 * Get market with order book and additional details
 * @param {KalshiKeys} keys - API keys
 * @param {string} ticker - Market ticker
 * @returns {Promise<MarketWithDetails>} Market with full details
 */
const getMarketWithDetails = async (keys, ticker) => {
  const [market, orderbook] = await Promise.all([
    api.getMarket(keys, ticker),
    api.getOrderbook(keys, ticker, 10)
  ])

  return {
    ...market.market,
    ...classifyMarket(market.market),
    orderbook
  }
}

/**
 * Calculate implied probability from yes/no prices
 * @param {number} yesPrice - Yes price in cents (0-100)
 * @param {number} noPrice - No price in cents (0-100)
 * @returns {ImpliedProbability} Calculated probabilities and spread
 */
const calculateImpliedProbability = (yesPrice, noPrice) => {
  // Kalshi prices are in cents (0-100)
  const yesPct = yesPrice / 100
  const noPct = noPrice / 100
  const total = yesPct + noPct
  return {
    yes: yesPct / total,
    no: noPct / total,
    spread: total - 1 // Vig/spread
  }
}

/**
 * Find active crypto markets for an asset
 * @param {KalshiKeys} keys - API keys
 * @param {CryptoAsset} asset - Crypto asset to search for
 * @param {MarketTimeframe | null} [timeframe=null] - Optional timeframe filter
 * @returns {Promise<ClassifiedMarket[]>} Matching markets
 */
const findCryptoMarketsForAsset = async (keys, asset, timeframe = null) => {
  const markets = await getCryptoMarkets(keys, {
    assets: [asset],
    timeframes: timeframe ? [timeframe] : ['15min', 'hourly', '6hour', 'daily']
  })

  return markets
}

/**
 * Find upcoming sports games
 * @param {KalshiKeys} keys - API keys
 * @param {SportsLeague} league - Sports league to search
 * @param {number} [hoursAhead=24] - Hours ahead to search
 * @returns {Promise<ClassifiedMarket[]>} Matching markets
 */
const findUpcomingSportsGames = async (keys, league, hoursAhead = 24) => {
  const markets = await getSportsMarkets(keys, {
    leagues: [league],
    maxTimeToSettle: hoursAhead * 3600
  })

  return markets
}

/**
 * Determine if a market is a bracket market and get the bracket width
 * Bracket tickers have B-prefix strikes (e.g., B68125, B68375 -> $250 bracket)
 * @param {string} ticker - Market ticker
 * @returns {{ isBracket: boolean, bracketWidth: number }}
 */
const getBracketInfo = (ticker) => {
  if (!ticker) return { isBracket: false, bracketWidth: 0 }
  const parts = ticker.split('-')
  const lastPart = parts[parts.length - 1]
  // B-prefix = bracket market, T-prefix = threshold/tail market
  if (lastPart.match(/^B\d/i)) {
    // Standard BTC bracket width is $250; derive from series
    const seriesUpper = ticker.toUpperCase()
    if (seriesUpper.startsWith('KXBTC') && !seriesUpper.startsWith('KXBTCD')) {
      return { isBracket: true, bracketWidth: 250 }
    }
    // Default bracket width for unknown series
    return { isBracket: true, bracketWidth: 250 }
  }
  return { isBracket: false, bracketWidth: 0 }
}

module.exports = {
  getCryptoMarkets,
  getSportsMarkets,
  getAllMarkets,
  getMarketWithDetails,
  calculateImpliedProbability,
  findCryptoMarketsForAsset,
  findUpcomingSportsGames,
  classifyMarket,
  detectTimeframe,
  parseStrikePrice,
  getCoinbaseTickerForKalshi,
  getBracketInfo,
  CRYPTO_SERIES,
  KALSHI_TO_COINBASE,
  SPORTS_CATEGORIES
}
