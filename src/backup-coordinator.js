// @ts-check
const { beginMaintenance, endMaintenance } = require('./restore-maintenance');
const { ENGINE_MAINTENANCE_TTL_MS, DEFAULT_STOP_TIMEOUT_MS, DEFAULT_DRAIN_TIMEOUT_MS } = require('./restore-coordinator');

/** Both scheduled backup types share the restore lock and fail closed. */
const performBackup = async ({
  kind, create, exchangeIPCMap = {}, configuredExchanges = [], gatewayWriters = [],
  drainPendingWrites, logger, timeoutMs = DEFAULT_STOP_TIMEOUT_MS, drainTimeoutMs = DEFAULT_DRAIN_TIMEOUT_MS,
}) => {
  const reason = `backup ${kind}`;
  const lock = beginMaintenance(reason);
  if (!lock.acquired) return { success: false, code: 'maintenance-in-progress', error: `Another maintenance operation is in progress (${lock.heldBy})` };
  const opened = [];
  const paused = [];
  const writers = [];
  const warnings = [];
  let result;
  let copying = false;
  const request = (exchange, channel, payload = {}) => {
    const ipc = exchangeIPCMap[exchange];
    if (!ipc || (ipc.isConnected && !ipc.isConnected())) return Promise.reject(new Error(`Engine ${exchange} is disconnected`));
    return Promise.resolve().then(() => ipc.request(channel, payload, exchange, timeoutMs));
  };
  try {
    for (const exchange of configuredExchanges) {
      // Include even timed-out opens/pauses in cleanup: the engine may still
      // execute a request after the caller lost its acknowledgement.
      opened.push(exchange);
      const ack = await request(exchange, 'engine:maintenance', { active: true, reason, ttlMs: ENGINE_MAINTENANCE_TTL_MS });
      if (ack?.success !== true || !ack.maintenance || ack.maintenance.reason !== reason) throw new Error(`Engine ${exchange} did not confirm its maintenance window`);
      paused.push(exchange);
      const quiet = await request(exchange, 'engine:backup-pause');
      if (quiet?.success !== true || quiet.quiesced !== true) throw new Error(`Engine ${exchange} did not confirm quiescence`);
    }
    for (const writer of gatewayWriters) {
      writers.push(writer);
      await writer.stop();
    }
    const drain = await drainPendingWrites(drainTimeoutMs);
    if (!drain?.drained) throw new Error('Gateway writers did not confirm quiescence');
    copying = true;
    result = await create();
    if (result?.success !== true) result = { success: false, code: 'backup-failed', error: result?.error || 'Backup returned no success acknowledgement' };
  } catch (err) {
    result = { success: false, code: copying ? 'backup-failed' : 'writers-not-quiesced', error: err.message };
    logger.error(`Backup ${kind} failed: ${err.message}`, { action: 'scheduled-backup', kind });
  } finally {
    for (const exchange of paused.reverse()) {
      const ack = await request(exchange, 'engine:backup-resume').catch((err) => ({ success: false, error: err.message }));
      if (ack?.success !== true) warnings.push(`Engine ${exchange} failed to resume after backup`);
    }
    for (const exchange of opened.reverse()) {
      await request(exchange, 'engine:maintenance', { active: false }).catch((err) => warnings.push(`Engine ${exchange} maintenance release failed: ${err.message}`));
    }
    for (const writer of writers.reverse()) {
      await Promise.resolve().then(() => writer.resume()).catch((err) => warnings.push(`${writer.name} failed to resume: ${err.message}`));
    }
    endMaintenance();
  }
  if (warnings.length) {
    logger.error(`Backup ${kind} writer resume warnings`, { warnings });
    result.warnings = warnings;
  }
  return result;
};
module.exports = { performBackup };
