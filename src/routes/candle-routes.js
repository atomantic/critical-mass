// @ts-check
/**
 * Candle Routes
 *
 * REST endpoint for shared candle cache data.
 * GET /api/candles/:exchange — returns all 4 timeframes or a single one via ?tf=
 */

const VALID_EXCHANGES = new Set(['cryptocom', 'coinbase']);
const VALID_TIMEFRAMES = new Set(['1m', '3m', '5m', '10m', '15m', '30m', '1h', '2h', '4h', '1d']);

/**
 * @param {import('express').Express} app
 * @param {{candleCache: import('../candle-cache')}} deps
 */
module.exports = (app, deps) => {
  const { candleCache } = deps;

  app.get('/api/candles/:candleExchange', (req, res) => {
    const exchange = req.params.candleExchange;
    if (!VALID_EXCHANGES.has(exchange)) {
      return res.status(400).json({ success: false, error: `Unknown candle exchange: ${exchange}. Valid: ${[...VALID_EXCHANGES].join(', ')}` });
    }

    const tf = req.query.tf;
    if (tf) {
      if (!VALID_TIMEFRAMES.has(tf)) {
        return res.status(400).json({ success: false, error: `Invalid timeframe: ${tf}. Valid: ${[...VALID_TIMEFRAMES].join(', ')}` });
      }
      return res.json({ success: true, candles: candleCache.getCandles(exchange, tf) });
    }

    res.json({ success: true, candles: candleCache.getAllCandles(exchange) });
  });
};
