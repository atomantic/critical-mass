// @ts-check
/**
 * Settings Routes: Aggressiveness Presets, Notifications, Backups
 */

const fs = require('fs');
const { getNotificationConfig, updateNotificationConfig, getAggressivenessPresets, updateAggressivenessPresets, DEFAULT_AGGRESSIVENESS_PRESETS, getBackupConfig, updateBackupConfig } = require('../config-utils');
const { createBackup, listBackups, deleteBackup, pruneBackups, restoreBackup } = require('../backup-service');
const { log } = require('../logger');

/**
 * @param {import('express').Express} app
 * @param {{notifier: Object, coinbaseIPC: Object, rescheduleBackupTimer: Function}} deps
 */
module.exports = (app, deps) => {
  const { notifier, coinbaseIPC, rescheduleBackupTimer } = deps;

  // ============ Aggressiveness Presets ============

  app.get('/api/presets/aggressiveness', (req, res) => {
    const presets = getAggressivenessPresets();
    res.json({ success: true, presets });
  });

  app.put('/api/presets/aggressiveness', (req, res) => {
    const updates = req.body;
    const validLevels = Object.keys(DEFAULT_AGGRESSIVENESS_PRESETS);
    const validParams = Object.keys(DEFAULT_AGGRESSIVENESS_PRESETS.conservative);
    const errors = [];

    for (const [level, params] of Object.entries(updates)) {
      if (!validLevels.includes(level)) { errors.push(`Unknown level: ${level}`); continue; }
      if (typeof params !== 'object' || params === null) { errors.push(`${level}: params must be an object`); continue; }
      for (const [key, value] of Object.entries(params)) {
        if (!validParams.includes(key)) errors.push(`${level}: unknown param "${key}"`);
        else if (typeof value !== 'number') errors.push(`${level}.${key}: must be a number`);
      }
    }

    if (errors.length > 0) {
      return res.status(400).json({ success: false, errors });
    }

    updateAggressivenessPresets(updates);
    log('INFO', '🔧 Aggressiveness presets updated');
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
        botToken: config.telegram.botToken
          ? config.telegram.botToken.slice(0, 6) + '...' + config.telegram.botToken.slice(-4)
          : '',
      },
    };
    res.json(masked);
  });

  app.put('/api/notifications/config', (req, res) => {
    const updates = req.body;
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
    log('INFO', `💾 Backup config updated: enabled=${updates.enabled !== undefined ? updates.enabled : 'unchanged'}`);
    const config = getBackupConfig();
    res.json({ success: true, config });
  });

  app.post('/api/backups', (req, res) => {
    const config = getBackupConfig();
    log('INFO', '💾 Manual backup triggered');

    const result = createBackup({ includePriceCache: config.includePriceCache });
    if (!result.success) {
      return res.status(500).json({ success: false, error: result.error });
    }

    const sizeMB = (result.sizeBytes / 1024 / 1024).toFixed(1);
    log('INFO', `💾 Manual backup created: ${result.filename} (${sizeMB} MB)`);

    const pruneResult = pruneBackups(config.maxBackups);
    if (pruneResult.pruned > 0) {
      log('INFO', `💾 Pruned ${pruneResult.pruned} old backups, ${pruneResult.remaining} remaining`);
    }

    res.json({ success: true, filename: result.filename, sizeBytes: result.sizeBytes });
  });

  app.delete('/api/backups/:filename', (req, res) => {
    const { filename } = req.params;
    const result = deleteBackup(filename);
    if (!result.success) {
      return res.status(400).json(result);
    }
    log('INFO', `💾 Backup deleted: ${filename}`);
    res.json({ success: true });
  });

  app.post('/api/backups/:filename/restore', async (req, res) => {
    const { filename } = req.params;
    log('INFO', `💾 Restore requested: ${filename}`);

    // Stop all regime engines in the Coinbase engine process before restore
    let stoppedEngines = [];
    const stopResult = await coinbaseIPC.request('regime:stop-all', {}).catch((err) => {
      log('WARN', `💾 Could not stop engines via IPC: ${err.message}`);
      return { stopped: [] };
    });
    stoppedEngines = stopResult.stopped || [];

    const result = restoreBackup(filename);
    if (!result.success) {
      return res.status(500).json({ success: false, error: result.error });
    }

    log('INFO', `💾 Restore complete: ${result.filesRestored} files restored from ${filename}`);

    res.json({
      success: true,
      filesRestored: result.filesRestored,
      stoppedEngines,
      message: stoppedEngines.length > 0
        ? `Restored ${result.filesRestored} files. Stopped engines: ${stoppedEngines.join(', ')}. Restart engines manually from dashboard.`
        : `Restored ${result.filesRestored} files.`,
    });
  });
};
