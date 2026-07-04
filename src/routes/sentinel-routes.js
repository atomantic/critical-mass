// @ts-check
/**
 * Sentinel Dashboard API Routes
 *
 * REST endpoints for the News Sentinel market event monitor.
 */

const { log } = require('../logger');
const { validateEndpointUrl } = require('../url-validator');

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

  app.put('/api/sentinel/config', async (req, res) => {
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

    // SSRF guard (issue #215-A): validate every feed URL at config-write time,
    // not just before each poll fetch, so an unsafe URL never even lands in
    // config.json. The poller (feed-poller.js) re-validates before each fetch
    // too, since config can also be edited by hand outside this endpoint.
    if (Array.isArray(sanitized.feeds)) {
      for (const feed of sanitized.feeds) {
        if (!feed || typeof feed.url !== 'string') {
          return res.status(400).json({ success: false, error: 'Each feed requires a url string' });
        }
        const validation = await validateEndpointUrl(feed.url);
        if (!validation.valid) {
          log('WARN', `Sentinel config rejected: unsafe feed url "${feed.url}": ${validation.error}`);
          return res.status(400).json({ success: false, error: `Feed URL "${feed.url}" is not allowed: ${validation.error}` });
        }
      }
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
