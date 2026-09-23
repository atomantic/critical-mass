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

/**
 * Ports an exchange's engine might be listening on, most likely first.
 *
 * Probing only the PM2 value fails OPEN — the dangerous direction — for an
 * engine started outside PM2 or with an env override, because the probe finds
 * nothing and the caller concludes "stopped". The engines resolve their own
 * port from env via `resolveIpcPort` (`src/ipc-port-defaults.js`), falling
 * back to the `ecosystem.config.cjs` PORTS default rather than a literal
 * (issue #690), so check every port that resolution could land on.
 * @param {string} exchange
 * @returns {number[]} distinct candidate ports, empty for an unknown exchange
 */
const candidatePorts = (exchange) => {
  const env = process.env;
  const shared = Number(env.EXCHANGE_IPC_PORT) || 0;
  const perExchange = {
    coinbase: [shared, Number(env.COINBASE_IPC_PORT) || 0, PORTS.COINBASE_IPC],
    gemini: [shared, Number(env.GEMINI_IPC_PORT) || 0, PORTS.GEMINI_IPC],
    cryptocom: [shared, Number(env.CRYPTOCOM_IPC_PORT) || 0, PORTS.CRYPTOCOM_IPC],
  }[exchange];
  if (!perExchange) return [];
  return [...new Set(perExchange.filter(port => Number.isInteger(port) && port > 0))];
};

/** Engine IPC port per exchange, from the PM2 source of truth. */
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
    // Keep an error sink: a late ECONNRESET / ERR_SOCKET_CLOSED during teardown
    // would otherwise be an unhandled 'error' event and kill the repair script
    // mid-run. removeAllListeners() with no replacement is what did that.
    socket.removeAllListeners('connect');
    socket.removeAllListeners('timeout');
    socket.removeAllListeners('error');
    socket.on('error', () => {});
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

  const ports = candidatePorts(exchange);
  if (ports.length === 0) {
    // Unknown exchange: the flag is all we have. An explicit false is trusted.
    return flag === false
      ? { safe: true, reason: `${RUNNING_FLAG} records the engine as stopped` }
      : { safe: false, reason: `no ${RUNNING_FLAG} for ${exchange}/${pair} and no known IPC port to probe` };
  }

  for (const port of ports) {
    if (await isPortListening(port)) {
      return { safe: false, reason: `the ${exchange} engine is accepting IPC on 127.0.0.1:${port}` };
    }
  }

  const probed = ports.join(', ');
  return {
    safe: true,
    reason: flag === false
      ? `${RUNNING_FLAG} records the engine as stopped and nothing is listening on 127.0.0.1:{${probed}}`
      : `no engine is listening on 127.0.0.1:{${probed}}`,
  };
};

module.exports = { checkEngineStopped, readRunningFlag, isPortListening, candidatePorts, IPC_PORT };
