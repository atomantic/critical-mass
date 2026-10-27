// @ts-check
// Ledger rows the fill-ledger reader accepts. Restore and hourly-snapshot
// publication refuse payloads the readers would reject (#1811), so fixtures
// that stand in for a ledger must be a real, minimal ledger.

/**
 * @param {...string} tradeIds
 * @returns {Array<Object>}
 */
const ledgerOf = (...tradeIds) => tradeIds.map((tradeId, i) => ({
  tradeId, side: 'buy', size: 1, price: 100, quoteAmount: 100, fee: 0, timestamp: 1000 + i,
}));

/**
 * A fixture payload for a per-fund state file: a valid ledger for the ledger
 * file, `value` untouched for every other file.
 * @param {string} file - basename
 * @param {any} value
 * @returns {any}
 */
const fixturePayload = (file, value) => (file === 'fill-ledger.json' ? ledgerOf(`row-${JSON.stringify(value)}`) : value);

module.exports = { ledgerOf, fixturePayload };
