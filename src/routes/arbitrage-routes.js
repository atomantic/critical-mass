// @ts-check
/**
 * Cross-pair Arbitrage Monitor API routes.
 *
 * Read-only market monitoring: these endpoints report and configure alerts.
 * None of them can place, cancel or size an order.
 */

const { createContextLogger } = require('../logger');
const { asyncRoute, parsePaging, pagedEnvelope } = require('./route-utils');
const { validateArbitrageConfigUpdate } = require('../config-settings/arbitrage');

const routeLogger = (route) => createContextLogger({ module: 'arbitrage-routes', route });

/**
 * @param {any} app - express app (or the gateway's tracked route registrar)
 * @param {{ arbitrageService: Object, getArbitrageConfig: Function, updateArbitrageConfig: Function }} deps
 */
module.exports = (app, deps) => {
  const { arbitrageService, getArbitrageConfig, updateArbitrageConfig } = deps;

  app.get('/api/arbitrage/status', (req, res) => {
    res.json({ success: true, ...arbitrageService.getStatus(), config: getArbitrageConfig() });
  });

  app.get('/api/arbitrage/snapshot', (req, res) => {
    const limit = Number.parseInt(String(req.query.routes ?? ''), 10);
    res.json({ success: true, ...arbitrageService.getSnapshot({ routesPerVenue: Number.isInteger(limit) && limit > 0 && limit <= 200 ? limit : 10 }) });
  });

  app.get('/api/arbitrage/alerts', (req, res) => {
    const filter = {};
    if (req.query.status === 'open' || req.query.status === 'closed') filter.status = req.query.status;
    if (req.query.type === 'opportunity' || req.query.type === 'dislocation') filter.type = req.query.type;
    res.json(pagedEnvelope(arbitrageService.getAlerts(filter), parsePaging(req.query), 'alerts'));
  });

  app.post('/api/arbitrage/poll', asyncRoute(async (req, res) => {
    if (!getArbitrageConfig().enabled) {
      return res.status(409).json({ success: false, error: 'Arbitrage monitor is disabled' });
    }
    await arbitrageService.forcePoll();
    res.json({ success: true, ...arbitrageService.getStatus() });
  }));

  app.post('/api/arbitrage/dismiss/:alertId', (req, res) => {
    if (!arbitrageService.dismissAlert(req.params.alertId)) return res.status(404).json({ success: false, error: 'Alert not found' });
    res.json({ success: true });
  });

  app.delete('/api/arbitrage/alerts', (req, res) => {
    arbitrageService.clearAlerts();
    routeLogger('/api/arbitrage/alerts').info('ℹ️ Arbitrage alert history cleared via API', { action: 'clear-alerts' });
    res.json({ success: true });
  });

  app.put('/api/arbitrage/config', asyncRoute(async (req, res) => {
    const { value, errors } = validateArbitrageConfigUpdate(req.body);
    if (errors.length) return res.status(400).json({ success: false, errors });
    if (Object.keys(value).length === 0) return res.status(400).json({ success: false, error: 'No settings to update' });
    updateArbitrageConfig(value);
    // Restart so a new interval or enable flag takes effect; stop() persists alert state.
    let stopError = null;
    try {
      arbitrageService.stop();
    } catch (err) {
      stopError = err;
    }
    arbitrageService.start();
    routeLogger('/api/arbitrage/config').info('ℹ️ Arbitrage config updated via API', { action: 'update-config', keys: Object.keys(value) });
    if (stopError) {
      return res.status(500).json({
        success: false,
        config: getArbitrageConfig(),
        persistence: { configSaved: true, alertStateSaved: false },
        error: `Config saved and monitor restarted, but alert state could not be written: ${stopError.message}`,
      });
    }
    res.json({ success: true, config: getArbitrageConfig(), persistence: { configSaved: true, alertStateSaved: true } });
  }));
};
