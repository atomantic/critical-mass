// @ts-check
'use strict';

/**
 * What the app charges and pays for an Up contract. Its quotes sit a half-spread
 * `h` (BTC dollars) either side of the market, so opening costs the value at
 * mid + h and closing pays the value at mid - h, plus the fee each way. Knock-outs
 * and expiry settle without a spread, so they do not use this module.
 */

const { contractValue, buyCost, sellProceeds } = require('./app-order-history');

/** A forgotten spread would silently price at the market, so it must be explicit. */
const requireHalfSpread = (h) => {
  if (typeof h !== 'number' || !Number.isFinite(h) || h < 0) throw new TypeError(`halfSpread must be a number of at least 0, got ${h}`);
  return h;
};

/** @typedef {{floor: number, ceiling: number, maxPayout?: number}} AppContract */

/** @param {number} mid @param {AppContract} contract @param {number} h */
const buyValue = (mid, contract, h) => contractValue(mid + requireHalfSpread(h), contract);

/** @param {number} mid @param {AppContract} contract @param {number} h */
const sellValue = (mid, contract, h) => contractValue(mid - requireHalfSpread(h), contract);

/** Cost of opening `qty` contracts, fee included. */
const entryCost = (mid, contract, h, qty = 1) => buyCost(mid + requireHalfSpread(h), contract, qty);

/** Proceeds of closing `qty` contracts, fee deducted. */
const exitProceeds = (mid, contract, h, qty = 1) => sellProceeds(mid - requireHalfSpread(h), contract, qty);

/**
 * The half-spread to close a position at: the larger of the one it was opened at
 * and the current one, so a quote going stale cannot create profit.
 * @param {{halfSpread?: number}} position @param {number} h
 */
const effectiveHalfSpread = (position, h) => Math.max(position.halfSpread ?? 0, requireHalfSpread(h));

module.exports = { requireHalfSpread, buyValue, sellValue, entryCost, exitProceeds, effectiveHalfSpread };
