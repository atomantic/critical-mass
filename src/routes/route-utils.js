// @ts-check
/**
 * Shared Route Utilities
 *
 * Common helpers used across multiple route modules.
 */

const { getDefaultPair } = require('../config-utils');

/**
 * Resolve the trading pair from a request's query string, falling back to the exchange default.
 * @param {import('express').Request} req
 * @returns {string}
 */
const getPair = (req) => req.query?.pair || getDefaultPair(req.params.exchange);

/**
 * Look up the IPC client for a given exchange. Throws if not found
 * (prevents silent fallback to the wrong exchange).
 * @param {Object} exchangeIPCMap
 * @param {string} exchange
 * @returns {Object}
 */
const getIPC = (exchangeIPCMap, exchange) => {
  const ipc = exchangeIPCMap[exchange];
  if (!ipc) {
    throw new Error(`No IPC client for exchange: ${exchange}`);
  }
  return ipc;
};

module.exports = { getPair, getIPC };
