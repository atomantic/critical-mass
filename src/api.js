/**
 * API Module - Backward Compatibility Shim
 *
 * This module provides backward compatibility with the original single-exchange API.
 * It exports the Coinbase adapter functions directly for existing code.
 *
 * For new code, use the adapter pattern:
 *   const { getAdapter } = require('./adapters');
 *   const adapter = getAdapter('coinbase');
 */

const coinbaseAdapter = require('./adapters/coinbase');

module.exports = {
  loadCredentials: coinbaseAdapter.loadCredentials,
  getAccountBalance: coinbaseAdapter.getAccountBalance,
  getCurrentPrice: coinbaseAdapter.getCurrentPrice,
  getProductDetails: coinbaseAdapter.getProductDetails,
  placeMarketBuy: coinbaseAdapter.placeMarketBuy,
  placeLimitSell: coinbaseAdapter.placeLimitSell,
  getOrder: coinbaseAdapter.getOrder,
  getOpenOrders: coinbaseAdapter.getOpenOrders,
  cancelOrder: coinbaseAdapter.cancelOrder,
  getOrderFills: coinbaseAdapter.getOrderFills,
  getOrderFillSummary: coinbaseAdapter.getOrderFillSummary,
};
