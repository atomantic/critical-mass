// @ts-check
/**
 * Sentinel Dashboard API Routes
 *
 * REST endpoints for the News Sentinel market event monitor.
 */

const { log } = require('../logger');

/**
 * @param {import('express').Express} app
 * @param {{ sentinelService: Object, getSentinelConfig: Function, updateSentinelConfig: Function }} deps
 */
module.exports = (app, deps) => {
  const { sentinelService, getSentinelConfig, updateSentinelConfig } = deps;

  app.get('/api/sentinel/status', (req, res) => {
    res.json({ success: true, ...sentinelService.getStatus(), config: getSentinelConfig() });
  });

  app.get('/api/sentinel/alerts', (req, res) => {
    const filter = {};
    if (req.query.severity) filter.severity = req.query.severity;
    res.json({ success: true, alerts: sentinelService.getAlerts(filter) });
  });

  app.post('/api/sentinel/poll', async (req, res) => {
    log('INFO', 'Sentinel force poll requested via API');
    await sentinelService.forcePoll();
    res.json({ success: true, ...sentinelService.getStatus() });
  });

  app.post('/api/sentinel/dismiss/:alertId', (req, res) => {
    const found = sentinelService.dismissAlert(req.params.alertId);
    if (!found) return res.status(404).json({ success: false, error: 'Alert not found' });
    res.json({ success: true });
  });

  // Allowlist of top-level keys accepted by updateSentinelConfig.
  // Sub-objects (aiClassification, keywords, feeds) are whitelisted as a unit
  // and their internal structure is validated by updateSentinelConfig itself.
  const SENTINEL_CONFIG_ALLOWED_KEYS = new Set([
    'enabled',
    'pollIntervalMs',
    'maxAlerts',
    'aiClassification',
    'feeds',
    'keywords',
  ]);

  app.put('/api/sentinel/config', (req, res) => {
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
      return res.status(400).json({ success: false, error: 'Request body must be a JSON object' });
    }

    // Strip any keys not in the allowlist (mass-assignment defence).
    const sanitized = {};
    for (const key of Object.keys(req.body)) {
      if (SENTINEL_CONFIG_ALLOWED_KEYS.has(key)) {
        sanitized[key] = req.body[key];
      }
    }

    if (Object.keys(sanitized).length === 0) {
      return res.status(400).json({ success: false, error: `No recognised config keys. Allowed: ${[...SENTINEL_CONFIG_ALLOWED_KEYS].join(', ')}` });
    }

    updateSentinelConfig(sanitized);
    // Restart service with new config
    sentinelService.stop();
    sentinelService.start();
    log('INFO', 'Sentinel config updated via API');
    res.json({ success: true, config: getSentinelConfig() });
  });

  app.delete('/api/sentinel/alerts', (req, res) => {
    sentinelService.clearAlerts();
    log('INFO', 'Sentinel alerts cleared via API');
    res.json({ success: true });
  });

  app.post('/api/sentinel/start', (req, res) => {
    sentinelService.start();
    log('INFO', 'Sentinel started via API');
    res.json({ success: true });
  });

  app.post('/api/sentinel/stop', (req, res) => {
    sentinelService.stop();
    log('INFO', 'Sentinel stopped via API');
    res.json({ success: true });
  });
};
