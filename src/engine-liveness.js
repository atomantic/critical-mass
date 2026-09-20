// @ts-check
/**
 * Is a fund's engine live right now?
 *
 * Operator repair scripts must never write `fill-ledger.json` or
 * `regime-state.json` under a running engine — it holds both in memory and
 * rewrites them on its own timer, silently discarding the repair (CLAUDE.md).
 *
 * `regime-engine-running.json` looks like a heartbeat and is not one: it is
 * written once on start (`{"running":true,...}`) and once on stop
 * (`engine-lifecycle-handlers.js:119,190`), so its mtime is the *start* time.
 * Treating a stale mtime as "stopped" green-lights a repair under an engine
 * that has simply been up a while, and treating an ABSENT file as "stopped" is
 * worse still — the file is missing on any fund whose directory was recreated,
 * which is exactly the situation a repair script is called for.
 *
 * So: the flag is authoritative only when it says `running: true` or when it
 * says `running: false`. Anything else falls back to asking whether the
 * exchange's engine process is accepting IPC connections.
 */

const fs = require('fs');
const net = require('net');
const path = require('path');

const { resolveFundDataDir } = require('./migration');
const { PORTS } = require('../ecosystem.config.cjs');

const RUNNING_FLAG = 'regime-engine-running.json';

/** Engine IPC port per exchange, from the single source of truth. */
const IPC_PORT = {
  coinbase: PORTS.COINBASE_IPC,
  gemini: PORTS.GEMINI_IPC,
  cryptocom: PORTS.CRYPTOCOM_IPC,
};

/**
 * The fund's persisted running flag.
 * @param {string} exchange
 * @param {string} pair
 * @returns {boolean|null} true/false as recorded, null when absent or unreadable
 */
const readRunningFlag = (exchange, pair) => {
  const file = path.join(resolveFundDataDir(exchange, pair), RUNNING_FLAG);
  if (!fs.existsSync(file)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return typeof parsed?.running === 'boolean' ? parsed.running : null;
  } catch {
    return null;
  }
};

/**
 * Does something accept TCP connections on `port`? Proves an engine process is
 * alive for that exchange even when the fund's flag is missing.
 * @param {number} port
 * @param {number} [timeoutMs]
 * @returns {Promise<boolean>}
 */
const isPortListening = (port, timeoutMs = 750) => new Promise((resolve) => {
  const socket = new net.Socket();
  const done = (result) => {
    socket.removeAllListeners();
    socket.destroy();
    resolve(result);
  };
  socket.setTimeout(timeoutMs);
  socket.once('connect', () => done(true));
  socket.once('timeout', () => done(false));
  socket.once('error', () => done(false));
  socket.connect(port, '127.0.0.1');
});

/**
 * Decide whether a repair may write this fund's files.
 * @param {string} exchange
 * @param {string} pair
 * @returns {Promise<{safe: boolean, reason: string}>}
 */
const checkEngineStopped = async (exchange, pair) => {
  const flag = readRunningFlag(exchange, pair);
  if (flag === true) {
    return { safe: false, reason: `${RUNNING_FLAG} records the engine as RUNNING` };
  }

  const port = IPC_PORT[exchange];
  if (port === undefined) {
    // Unknown exchange: the flag is all we have. An explicit false is trusted.
    return flag === false
      ? { safe: true, reason: `${RUNNING_FLAG} records the engine as stopped` }
      : { safe: false, reason: `no ${RUNNING_FLAG} for ${exchange}/${pair} and no known IPC port to probe` };
  }

  if (await isPortListening(port)) {
    return { safe: false, reason: `the ${exchange} engine is accepting IPC on 127.0.0.1:${port}` };
  }

  return {
    safe: true,
    reason: flag === false
      ? `${RUNNING_FLAG} records the engine as stopped and nothing is listening on 127.0.0.1:${port}`
      : `no engine is listening on 127.0.0.1:${port}`,
  };
};

module.exports = { checkEngineStopped, readRunningFlag, isPortListening, IPC_PORT };
