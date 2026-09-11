// @ts-check
/**
 * Settings Routes: Aggressiveness Presets, Notifications, Backups
 */

const { getNotificationConfig, updateNotificationConfig, getAggressivenessPresets, updateAggressivenessPresets, DEFAULT_AGGRESSIVENESS_PRESETS, getBackupConfig, updateBackupConfig, maskSecret, isMaskedSecret, getConfiguredExchanges, invalidateConfigCache } = require('../config-utils');
const { createBackup, listBackups, deleteBackup, pruneBackups, restoreBackup, inspectBackup } = require('../backup-service');
const { createContextLogger } = require('../logger');
const { performRestore } = require('../restore-coordinator');
const { drainPendingWrites } = require('../pending-writes');
const { validateConfigUpdate, AGGRESSIVENESS_SCHEMA, validateNotificationConfigUpdate } = require('../config-validator');

/**
 * Context logger for the settings routes. These endpoints are global (presets,
 * notifications, backups) rather than market-scoped, so `route` is the
 * distinguishing context and no exchange/pair is fabricated.
 * @param {string} route - Express route pattern being served
 * @returns {{info: (message: string, data?: Object) => void, warn: (message: string, data?: Object) => void, error: (message: string, data?: Object) => void}} Context logger
 */
const settingsLogger = (route) => createContextLogger({
  module: 'settings-routes',
  route,
});

/**
 * @param {import('express').Express} app
 * @param {{notifier: Object, exchangeIPCMap: Object, rescheduleBackupTimer: Function, updownService?: Object, sentinelService?: Object, candleCache?: Object}} deps
 */
module.exports = (app, deps) => {
  const { notifier, exchangeIPCMap, rescheduleBackupTimer, updownService, sentinelService, candleCache } = deps;

  /**
   * Gateway services that own files inside the archive. Each is stopped before
   * the copy and reloaded from the restored files afterwards, so its surviving
   * in-memory snapshot can never be written back over the recovery (issue #429).
   * @returns {Array<{name: string, stop: Function, resume: Function}>} Writer descriptors
   */
  const gatewayWriters = () => [
    updownService && {
      name: 'UpDown',
      stop: () => updownService.stop(),
      resume: () => updownService.start(),
    },
    sentinelService && {
      name: 'Sentinel',
      stop: () => sentinelService.stop(),
      // reloadState is separate from start(): the sentinel persists from the
      // API surface (dismiss/clear) even when it is disabled and never starts.
      resume: () => {
        sentinelService.reloadState?.();
        sentinelService.start();
      },
    },
  ].filter(Boolean);

  // ============ Aggressiveness Presets ============

  app.get('/api/presets/aggressiveness', (req, res) => {
    const presets = getAggressivenessPresets();
    res.json({ success: true, presets });
  });

  app.put('/api/presets/aggressiveness', (req, res) => {
    const updates = req.body;
    if (typeof updates !== 'object' || updates === null || Array.isArray(updates)) {
      return res.status(400).json({ success: false, errors: ['Request body must be an object'] });
    }

    const validLevels = Object.keys(DEFAULT_AGGRESSIVENESS_PRESETS);
    const errors = [];
    const sanitized = {};

    for (const [level, params] of Object.entries(updates)) {
      if (!validLevels.includes(level)) { errors.push(`Unknown level: ${level}`); continue; }
      if (typeof params !== 'object' || params === null) { errors.push(`${level}: params must be an object`); continue; }
      const { value: validParams, errors: paramErrors } = validateConfigUpdate(AGGRESSIVENESS_SCHEMA, params);
      for (const err of paramErrors) errors.push(`${level}.${err}`);
      sanitized[level] = validParams;
    }

    if (errors.length > 0) {
      return res.status(400).json({ success: false, errors });
    }

    updateAggressivenessPresets(sanitized);
    settingsLogger('/api/presets/aggressiveness').info('ℹ️ 🔧 Aggressiveness presets updated', {
      action: 'update-presets',
      levels: Object.keys(sanitized),
    });
    const presets = getAggressivenessPresets();
    res.json({ success: true, presets });
  });

  // ============ Notifications ============

  app.get('/api/notifications/config', (req, res) => {
    const config = getNotificationConfig();
    const masked = {
      ...config,
      telegram: {
        ...config.telegram,
        botToken: maskSecret(config.telegram.botToken),
      },
    };
    res.json(masked);
  });

  app.put('/api/notifications/config', (req, res) => {
    const updates = { ...req.body };
    // Round-trip guard: GET /api/notifications/config masks the bot token.
    // If a client echoes the masked value back, drop it so the stored token
    // is preserved instead of being overwritten with the mask.
    if (updates.telegram && isMaskedSecret(updates.telegram.botToken)) {
      const telegram = { ...updates.telegram };
      delete telegram.botToken;
      updates.telegram = telegram;
    }

    const { errors } = validateNotificationConfigUpdate(updates);
    if (errors.length > 0) {
      return res.status(400).json({ success: false, errors });
    }

    updateNotificationConfig(updates);
    notifier.updateConfig(updates);
    res.json({ success: true });
  });

  app.post('/api/notifications/test', (req, res) => {
    notifier.sendTest()
      .then(result => res.json(result))
      .catch(err => res.status(500).json({ success: false, error: err.message }));
  });

  app.get('/api/notifications/stats', (req, res) => {
    res.json(notifier.getStats());
  });

  // ============ Backups ============

  app.get('/api/backups', (req, res) => {
    const backups = listBackups();
    const config = getBackupConfig();
    res.json({ success: true, backups, config });
  });

  app.get('/api/backups/config', (req, res) => {
    const config = getBackupConfig();
    res.json({ success: true, config });
  });

  app.put('/api/backups/config', (req, res) => {
    const updates = req.body;
    updateBackupConfig(updates);
    rescheduleBackupTimer();
    settingsLogger('/api/backups/config').info(`ℹ️ 💾 Backup config updated: enabled=${updates.enabled !== undefined ? updates.enabled : 'unchanged'}`, {
      action: 'update-backup-config',
      enabled: updates.enabled,
    });
    const config = getBackupConfig();
    res.json({ success: true, config });
  });

  app.post('/api/backups', (req, res) => {
    const logger = settingsLogger('/api/backups');
    const config = getBackupConfig();
    logger.info('ℹ️ 💾 Manual backup triggered', { action: 'create-backup' });

    const result = createBackup({ includePriceCache: config.includePriceCache });
    if (!result.success) {
      return res.status(500).json({ success: false, error: result.error });
    }

    const sizeMB = (result.sizeBytes / 1024 / 1024).toFixed(1);
    logger.info(`ℹ️ 💾 Manual backup created: ${result.filename} (${sizeMB} MB)`, {
      action: 'create-backup',
      filename: result.filename,
      sizeBytes: result.sizeBytes,
    });

    const pruneResult = pruneBackups(config.maxBackups);
    if (pruneResult.pruned > 0) {
      logger.info(`ℹ️ 💾 Pruned ${pruneResult.pruned} old backups, ${pruneResult.remaining} remaining`, {
        action: 'prune-backups',
        pruned: pruneResult.pruned,
        remaining: pruneResult.remaining,
      });
    }

    res.json({ success: true, filename: result.filename, sizeBytes: result.sizeBytes });
  });

  // Pre-flight for the restore confirmation UI: reports whether the archive
  // carries a configuration manifest, which funds it would restore, and whether
  // reconstruction against THIS machine's base config succeeds — all without
  // touching a single destination file (issue #430).
  app.get('/api/backups/:filename/compatibility', (req, res) => {
    const result = inspectBackup(req.params.filename);
    res.status(result.success ? 200 : 400).json(result);
  });

  app.delete('/api/backups/:filename', (req, res) => {
    const { filename } = req.params;
    const result = deleteBackup(filename);
    if (!result.success) {
      return res.status(400).json(result);
    }
    settingsLogger('/api/backups/:filename').info(`ℹ️ 💾 Backup deleted: ${filename}`, {
      action: 'delete-backup',
      filename,
    });
    res.json({ success: true });
  });

  // Restoring overwrites live data files in place, so it is gated on CONFIRMED
  // writer shutdown: every configured engine process must positively
  // acknowledge `regime:stop-all`, gateway work already in flight must finish,
  // and the gateway's own writers (UpDown, Sentinel) are drained and reloaded
  // around the copy. A rejection, timeout, disconnect, negative or malformed
  // acknowledgement — or work still running after the drain window — blocks the
  // restore with zero destination file changes (issue #429). `force: true` is an
  // explicit operator override for recovering an install whose engine is dead.
  app.post('/api/backups/:filename/restore', async (req, res) => {
    const logger = settingsLogger('/api/backups/:filename/restore');
    const { filename } = req.params;
    logger.info(`ℹ️ 💾 Restore requested: ${filename}`, { action: 'restore-backup', filename });

    const { status, body } = await performRestore({
      filename,
      force: req.body?.force === true,
      exchangeIPCMap,
      // Only exchanges this gateway actually proxies can own a live engine
      // process; a config key with no IPC client has no writer to drain.
      configuredExchanges: getConfiguredExchanges().filter((name) => exchangeIPCMap[name]),
      // A legacy (manifest-less) archive is refused unless the operator has
      // explicitly accepted a data-only restore in the confirmation UI (#430).
      restore: (name) => restoreBackup(name, { acceptLegacyWithoutBase: req.body?.acceptLegacyWithoutBase === true }),
      gatewayWriters: gatewayWriters(),
      drainPendingWrites,
      invalidateCaches: () => {
        invalidateConfigCache();
        // Reseeding is network work — kick it off, don't hold the lock on it.
        candleCache?.invalidate();
      },
      logger,
    });
    res.status(status).json(body);
  });
};
