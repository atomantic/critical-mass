// @ts-check
/**
 * BTC 1s feed API: the bars, index values and source status behind the UpDown
 * second chart. Public market data only.
 */

const DEFAULT_SECONDS = 300;
const MAX_SECONDS = 3600;

/**
 * @param {any} app - express app (or the gateway's tracked route registrar)
 * @param {{ btcFeedService: { getWindow: (seconds: number) => Object } }} deps
 */
module.exports = (app, { btcFeedService }) => {
  app.get('/api/btc-feed/seconds', (req, res) => {
    const raw = req.query.seconds ?? String(DEFAULT_SECONDS);
    const seconds = typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : NaN;
    if (!(seconds >= 1 && seconds <= MAX_SECONDS)) {
      return res.status(400).json({ success: false, error: `seconds must be a whole number from 1 to ${MAX_SECONDS}` });
    }
    res.json({ success: true, ...btcFeedService.getWindow(seconds) });
  });
};
