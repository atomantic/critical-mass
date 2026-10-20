// @ts-check
// Startup-only base reconciliation. No config-utils dependency: callers supply
// paths, so fixtures and backup restoration never consult the live install.
const fs = require('fs');
const path = require('path');
const { isDeepStrictEqual } = require('util');
const { jsonReadError } = require('./json-diagnostics');
const { atomicWriteSync } = require('./durable-write');

const BASE_SNAPSHOT_FILENAME = 'config-base.snapshot.json';
const CONFIG_LOCK_DIR = '.config-write.lock';
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

const readConfigObject = (file) => {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!isObject(value)) throw new Error('Expected a configuration object');
    return value;
  } catch (error) {
    throw jsonReadError(error, path.basename(file));
  }
};

// Never steal by age or PID: after a crash, an operator must stop all writers
// before removing this directory. A bounded wait lets concurrent starters
// finish normally and fails closed if ownership cannot be established.
const withConfigWriteLock = (dataDir, action, timeoutMs = 5000) => {
  fs.mkdirSync(dataDir, { recursive: true });
  const lock = path.join(dataDir, CONFIG_LOCK_DIR);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try { fs.mkdirSync(lock); break; } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (Date.now() >= deadline) throw new Error(`Config write lock busy: ${CONFIG_LOCK_DIR}; see UPGRADE.md`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }
  try { return action(); } finally { fs.rmdirSync(lock); }
};

// Publish the override durably BEFORE publishing its new baseline. If the
// process dies between the two writes, replay sees the pins and is idempotent.
const writeDurableConfig = (file, value, privateFile = false) => {
  let mode = 0o600;
  try { mode = fs.statSync(file).mode & 0o777; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (privateFile) mode &= 0o600;
  atomicWriteSync(file, JSON.stringify(value, null, 2), { mode });
};

// Arrays/null/scalars are indivisible leaves. An explicit scalar/null override
// also masks an entire base subtree. Removed defaults are pinned; new defaults
// have no old value and are adopted. Empty objects are leaves too.
const pinChangedDefaults = (previous, current, override, prefix = []) => {
  const result = { ...override };
  const pins = [];
  for (const [key, oldValue] of Object.entries(previous)) {
    const newValue = Object.hasOwn(current, key) ? current[key] : undefined;
    const selected = Object.hasOwn(override, key);
    const location = [...prefix, key];
    if (isObject(oldValue) && Object.keys(oldValue).length && (!selected || isObject(override[key]))) {
      const nested = pinChangedDefaults(oldValue, isObject(newValue) ? newValue : {}, selected ? override[key] : {}, location);
      if (nested.pins.length) Object.defineProperty(result, key, { value: nested.override, enumerable: true, writable: true, configurable: true });
      pins.push(...nested.pins);
    } else if (!selected && !isDeepStrictEqual(oldValue, newValue)) {
      Object.defineProperty(result, key, { value: oldValue, enumerable: true, writable: true, configurable: true });
      pins.push({ key: location.join('.'), oldValue, newValue });
    }
  }
  return { override: result, pins };
};

const reconcileBaseConfig = ({ dataDir, baseConfigFile, logger }) => withConfigWriteLock(dataDir, () => {
  let base;
  try { base = readConfigObject(baseConfigFile); } catch (error) {
    // No cache or override mutation: loadRawConfig retains its established
    // last-good / cold-start error behavior for an unreadable base.
    logger.warn('Base config unavailable; default reconciliation skipped', { error: error.message });
    return { skipped: true, pins: [] };
  }
  const userFile = path.join(dataDir, 'config.json');
  const snapshotFile = path.join(dataDir, BASE_SNAPSHOT_FILENAME);
  // A corrupt override or snapshot must never be treated as absent.
  const override = fs.existsSync(userFile) ? readConfigObject(userFile) : {};
  const previous = fs.existsSync(snapshotFile) ? readConfigObject(snapshotFile) : null;
  if (previous) {
    const mode = fs.statSync(snapshotFile).mode & 0o777;
    if (mode & 0o177) fs.chmodSync(snapshotFile, mode & 0o600);
  }
  if (previous && isDeepStrictEqual(previous, base)) return { pins: [] };
  const result = previous ? pinChangedDefaults(previous, base, override) : { override, pins: [] };
  if (result.pins.length) writeDurableConfig(userFile, result.override);
  writeDurableConfig(snapshotFile, base, true);
  for (const pin of result.pins) {
    // Base files can contain secrets. Never render values for credential paths
    // or compound leaves (which might contain credentials).
    const sensitive = /token|secret|password|credential|key/i.test(pin.key)
      || (pin.oldValue !== null && typeof pin.oldValue === 'object')
      || (pin.newValue !== null && typeof pin.newValue === 'object');
    const describe = (value) => sensitive ? '[redacted]' : JSON.stringify(value) ?? '(removed)';
    logger.warn(`${pin.key}: ${describe(pin.oldValue)} -> ${describe(pin.newValue)} default, pinned`);
  }
  return { pins: result.pins };
});

module.exports = { BASE_SNAPSHOT_FILENAME, CONFIG_LOCK_DIR, readConfigObject, withConfigWriteLock, reconcileBaseConfig };
