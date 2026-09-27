/** Durable, idempotent cohort replacement for the offline FIFO repair. */
const fs = require('fs');
const path = require('path');
const { createHash, randomUUID } = require('crypto');
const { execFileSync } = require('child_process');
const { DATA_DIR, APP_ROOT } = require('./paths');

const JOURNAL_FILENAME = '.fifo-backfill-journal.json';
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');

// Presence, including an unreadable journal, is fail-closed. Completed journals
// are archived before this marker is removed, so no parsing is needed by guards.
const hasPendingBackfill = (dataDir = DATA_DIR) => fs.existsSync(path.join(dataDir, JOURNAL_FILENAME));

const flush = (file) => {
  const fd = fs.openSync(file, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
};

const durableWrite = (file, bytes, write) => {
  write(file, bytes);
  flush(file);
  flush(path.dirname(file));
};

const validateEntry = (entry, dataDir) => {
  if (!entry || typeof entry.file !== 'string' || typeof entry.before !== 'string' || typeof entry.after !== 'string') {
    throw new Error('Invalid backfill journal entry');
  }
  const target = path.resolve(dataDir, entry.file);
  const relative = path.relative(dataDir, target);
  if (relative.startsWith('..') || path.isAbsolute(relative) || relative.split(path.sep).length !== 3 || path.basename(target) !== 'regime-state.json') {
    throw new Error('Backfill journal target must be a fund regime-state.json');
  }
  if (fs.realpathSync(target) !== target) throw new Error('Symlinked backfill targets are unsupported');
  if (hash(entry.before) !== entry.beforeHash || hash(entry.after) !== entry.afterHash) {
    throw new Error('Backfill journal hash mismatch');
  }
  for (const bytes of [entry.before, entry.after]) {
    const state = JSON.parse(bytes);
    if (!state || typeof state !== 'object' || Array.isArray(state) || !state.position || typeof state.position !== 'object' || Array.isArray(state.position)) {
      throw new Error('Invalid backfill position state');
    }
  }
  const after = JSON.parse(entry.after).position;
  if (!Number.isFinite(after.realizedPnL) || !Number.isFinite(after.realizedAssetPnL)) throw new Error('Invalid staged realized P&L');
  return target;
};

const readJournal = (file, dataDir) => {
  const journal = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (journal.version !== 1 || typeof journal.id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(journal.id) || !Array.isArray(journal.entries) || !['staging', 'staged', 'applying', 'rolling-back', 'committed', 'rolled-back'].includes(journal.status)) {
    throw new Error('Invalid backfill journal; preserve it for recovery');
  }
  const files = journal.entries.map((entry) => validateEntry(entry, dataDir));
  if (new Set(files).size !== files.length) throw new Error('Duplicate backfill journal targets');
  return journal;
};

const applyCohort = ({ dataDir = DATA_DIR, mode = 'apply', stage, assertStopped = () => {}, write = require('./state-tracker').atomicWriteSync }) => {
  dataDir = fs.realpathSync(dataDir);
  const journalFile = path.join(dataDir, JOURNAL_FILENAME);
  const save = (journal) => durableWrite(journalFile, JSON.stringify(journal, null, 2), write);
  if (fs.existsSync(path.join(dataDir, '.restore-journal.json'))) throw new Error('Backup restore recovery is pending; resolve it before backfill');
  let journal;
  if (hasPendingBackfill(dataDir)) {
    if (mode === 'apply') throw new Error('A backfill journal is pending; use --resume or --rollback');
    journal = readJournal(journalFile, dataDir);
    if (mode === 'resume' && journal.status === 'staging') throw new Error('Staging was interrupted before any fund changed; use --rollback, then --apply');
    if (mode === 'resume' && journal.status === 'rolling-back') throw new Error('Rollback already started; finish with --rollback');
  } else {
    if (mode !== 'apply') throw new Error('No pending backfill journal');
    // Exclusive marker before staging prevents another repair or process startup
    // from racing the cohort. A pre-staging crash can safely roll back an empty set.
    journal = { version: 1, id: randomUUID(), status: 'staging', entries: [] };
    const fd = fs.openSync(journalFile, 'wx', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(journal)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    flush(dataDir);
    try {
      assertStopped();
      journal.entries = stage().map((entry) => ({
        file: path.relative(dataDir, fs.realpathSync(entry.file)), before: entry.before, after: entry.after,
        beforeHash: hash(entry.before), afterHash: hash(entry.after), status: 'pending',
      }));
      const files = journal.entries.map((entry) => validateEntry(entry, dataDir));
      if (new Set(files).size !== files.length) throw new Error('Duplicate staged backfill targets');
      journal.status = 'staged';
      save(journal);
    } catch (error) {
      // No target has changed. Remove only this repair's pre-staging marker.
      fs.unlinkSync(journalFile);
      flush(dataDir);
      throw error;
    }
  }
  assertStopped();
  const rollback = mode === 'rollback' || journal.status === 'rolled-back';
  // Check the ENTIRE live cohort before replacing any target. Hashes also recover
  // a crash after rename but before the entry's committed status was persisted.
  const targets = journal.entries.map((entry) => {
    const file = validateEntry(entry, dataDir);
    const current = hash(fs.readFileSync(file));
    if (current !== entry.beforeHash && current !== entry.afterHash) throw new Error('Fund changed outside the backfill; refusing to overwrite');
    return file;
  });
  journal.status = rollback ? 'rolling-back' : 'applying';
  save(journal);
  journal.entries.forEach((entry, index) => {
    const bytes = rollback ? entry.before : entry.after;
    const expected = rollback ? entry.beforeHash : entry.afterHash;
    if (hash(fs.readFileSync(targets[index])) !== expected) durableWrite(targets[index], bytes, write);
    if (hash(fs.readFileSync(targets[index])) !== expected) throw new Error('Backfill target verification failed');
    entry.status = rollback ? 'rolled-back' : 'committed';
    save(journal);
  });
  journal.status = rollback ? 'rolled-back' : 'committed';
  save(journal);
  // Retain before/after bytes and hashes for audit, but drop the startup gate only
  // after every target and the final journal are on stable storage.
  const historyDir = path.join(dataDir, '.fifo-backfill-history');
  fs.mkdirSync(historyDir, { recursive: true, mode: 0o700 });
  const archive = path.join(historyDir, `${journal.id}.json`);
  durableWrite(archive, JSON.stringify(journal, null, 2), write);
  fs.unlinkSync(journalFile);
  flush(dataDir);
  return { status: journal.status, count: journal.entries.length };
};

// Per-process exclusive contenders avoid stale-lock takeover races: after a
// crash dead owners are ignored; a reused/live PID conservatively blocks repair.
const runBackfill = (options) => {
  const dataDir = fs.realpathSync(options.dataDir || DATA_DIR);
  const prefix = '.fifo-backfill-lock-';
  const own = `${prefix}${process.pid}-${randomUUID()}`;
  fs.mkdirSync(path.join(dataDir, own), { mode: 0o700 });
  try {
    for (const name of fs.readdirSync(dataDir)) {
      if (!name.startsWith(prefix) || name === own) continue;
      const pid = Number(name.slice(prefix.length).split('-')[0]);
      if (!Number.isInteger(pid) || pid <= 0) throw new Error('Unrecognized backfill lock');
      let alive = true;
      try { process.kill(pid, 0); } catch (error) { if (error.code === 'ESRCH') alive = false; }
      if (alive) throw new Error('Another backfill process owns the cohort');
    }
    return applyCohort(options);
  } finally {
    fs.rmdirSync(path.join(dataDir, own));
  }
};

const isStoppedProcess = (processes, name) => {
  const matching = processes.filter((entry) => entry.name === name && entry.pm2_env?.pm_cwd === APP_ROOT);
  return matching.length > 0 && matching.every((entry) => entry.pm2_env?.status === 'stopped' && !entry.pid);
};

const withStoppedWriters = async (operation, {
  processes = null,
  readProcesses = () => JSON.parse(execFileSync('pm2', ['jlist'], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })),
  configuredExchanges = null,
  createClient = null,
  timeoutMs = 30_000,
} = {}) => {
  const { requestEngineStop } = require('./restore-coordinator');
  const { resolveIpcPort } = require('./ipc-port-defaults');
  const { getConfiguredExchanges } = require('./config-utils');
  const { createIPCClient } = require('./ipc/ipc-client');
  const { findFunds } = require('../scripts/backfill-fifo-realized');
  const injectedProcesses = processes !== null;
  processes ??= readProcesses();
  if (!Array.isArray(processes) || !isStoppedProcess(processes, 'critical-mass')) {
    throw new Error('Gateway must be PM2-confirmed stopped before offline backfill');
  }
  configuredExchanges ??= [...new Set([...getConfiguredExchanges(), ...findFunds().map((fund) => fund.exchange)])];
  createClient ??= createIPCClient;
  const clients = [];
  const offline = [];
  try {
    for (const exchange of configuredExchanges) {
      if (isStoppedProcess(processes, `critical-mass-${exchange}`)) { offline.push(exchange); continue; }
      const ipc = createClient(`ws://127.0.0.1:${resolveIpcPort(exchange)}`, exchange);
      clients.push({ exchange, ipc });
      ipc.connect();
      const deadline = Date.now() + timeoutMs;
      while (!ipc.isConnected() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
      if (!ipc.isConnected()) throw new Error(`Cannot confirm ${exchange} engine shutdown`);
      const ack = await ipc.request('engine:maintenance', { active: true, reason: 'FIFO backfill', ttlMs: 60 * 60_000 }, exchange, timeoutMs);
      if (ack?.success !== true || !ack.maintenance || !Number.isFinite(ack.maintenance.expiresAt) || ack.maintenance.expiresAt <= Date.now() + timeoutMs + 60_000) throw new Error(`No maintenance acknowledgement from ${exchange}`);
      const stopped = await requestEngineStop(exchange, ipc, timeoutMs);
      if (!stopped.confirmed) throw new Error(`Cannot confirm ${exchange} engine shutdown (${stopped.reason})`);
      if (ack.maintenance.expiresAt <= Date.now() + 60_000) throw new Error(`Maintenance window expired before ${exchange} was quiesced`);
    }
    return await operation(() => {
      const current = injectedProcesses ? processes : readProcesses();
      if (!Array.isArray(current) || !isStoppedProcess(current, 'critical-mass') || offline.some((exchange) => !isStoppedProcess(current, `critical-mass-${exchange}`))) {
        throw new Error('A previously stopped writer restarted; refusing backfill');
      }
    });
  } finally {
    for (const { exchange, ipc } of clients) {
      // Pending journals remain an independent durable gate after this window.
      await ipc.request('engine:maintenance', { active: false }, exchange, timeoutMs).catch(() => {});
      ipc.disconnect();
    }
  }
};

module.exports = { JOURNAL_FILENAME, hasPendingBackfill, hash, runBackfill, withStoppedWriters, isStoppedProcess };
