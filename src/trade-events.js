// @ts-check
/**
 * Trade event emitter for real-time WebSocket updates
 * Centralizes event emission so UI can receive live trade updates
 */

const EventEmitter = require('events');

/**
 * @typedef {Object} TradeEvent
 * @property {string} type - Event type
 * @property {string} exchange - Exchange name
 * @property {string} message - Human-readable message
 * @property {Object} [data] - Additional event data
 * @property {string} timestamp - ISO timestamp
 */

class TradeEventEmitter extends EventEmitter {
  /**
   * Emit a trade event
   * @param {string} type - Event type (e.g., 'starting', 'buy_placed', 'complete')
   * @param {string} exchange - Exchange name
   * @param {string} message - Human-readable message
   * @param {Object} [data] - Additional event data
   */
  emitTradeEvent(type, exchange, message, data = {}) {
    /** @type {TradeEvent} */
    const event = {
      type,
      exchange,
      message,
      data,
      timestamp: new Date().toISOString(),
    };
    this.emit('trade', event);
  }

  // Convenience methods for common events
  starting(exchange, intervalType) {
    this.emitTradeEvent('starting', exchange, `Starting ${intervalType} trade cycle`, { intervalType });
  }

  checkingOrders(exchange, count) {
    this.emitTradeEvent('checking_orders', exchange, `Checking ${count} pending orders`, { count });
  }

  orderFilled(exchange, orderId, value) {
    this.emitTradeEvent('order_filled', exchange, `Sell order filled: +$${value.toFixed(2)}`, { orderId, value });
  }

  priceCheck(exchange, productId, price) {
    this.emitTradeEvent('price_check', exchange, `${productId} price: $${price.toFixed(2)}`, { productId, price });
  }

  balanceCheck(exchange, currency, available) {
    this.emitTradeEvent('balance_check', exchange, `${currency} balance: $${available.toFixed(2)}`, { currency, available });
  }

  buyPlacing(exchange, amount, productId) {
    this.emitTradeEvent('buy_placing', exchange, `Placing buy order: $${amount.toFixed(2)} ${productId}`, { amount, productId });
  }

  buyPlaced(exchange, orderId, btcAmount, price) {
    this.emitTradeEvent('buy_placed', exchange, `Buy order placed: ${btcAmount.toFixed(8)} @ $${price.toFixed(2)}`, { orderId, btcAmount, price });
  }

  buyFilled(exchange, btcAmount, price, fees) {
    this.emitTradeEvent('buy_filled', exchange, `Buy filled: ${btcAmount.toFixed(8)} @ $${price.toFixed(2)} (fees: $${fees.toFixed(4)})`, { btcAmount, price, fees });
  }

  sellPlaced(exchange, orderId, btcAmount, price) {
    this.emitTradeEvent('sell_placed', exchange, `Sell order placed: ${btcAmount.toFixed(8)} @ $${price.toFixed(2)}`, { orderId, btcAmount, price });
  }

  cycleComplete(exchange, status, summary) {
    this.emitTradeEvent('complete', exchange, `Trade cycle complete: ${status}`, summary);
  }

  error(exchange, message, errorData = {}) {
    this.emitTradeEvent('error', exchange, message, errorData);
  }

  skipped(exchange, reason) {
    this.emitTradeEvent('skipped', exchange, reason, {});
  }

  disabled(exchange) {
    this.emitTradeEvent('disabled', exchange, 'Trading is disabled', {});
  }

  ordersConsolidated(exchange, count, newOrderId, newPrice, totalBTC) {
    this.emitTradeEvent('orders_consolidated', exchange,
      `Consolidated ${count} orders into 1 @ $${newPrice.toFixed(2)}`,
      { count, newOrderId, newPrice, totalBTC });
  }

  // ============================================================================
  // Regime Engine Events
  // ============================================================================

  regimeChange(exchange, prevMode, newMode, reason) {
    this.emitTradeEvent('regime_change', exchange,
      `Regime: ${prevMode} -> ${newMode}`,
      { prevMode, newMode, reason });
  }

  entryTriggered(exchange, trigger, regime, step, sizeUsdc) {
    this.emitTradeEvent('entry_triggered', exchange,
      `Entry triggered: ${trigger} (${regime} step ${step})`,
      { trigger, regime, step, sizeUsdc });
  }

  entryPlaced(exchange, orderId, btcAmount, price, regime) {
    this.emitTradeEvent('entry_placed', exchange,
      `Entry placed: ${btcAmount.toFixed(8)} BTC @ $${price.toFixed(2)} (${regime})`,
      { orderId, btcAmount, price, regime });
  }

  entryFilled(exchange, btcAmount, price, avgCostBasis, ladderStep) {
    this.emitTradeEvent('entry_filled', exchange,
      `Entry filled: ${btcAmount.toFixed(8)} BTC @ $${price.toFixed(2)} (step ${ladderStep}, avg $${avgCostBasis.toFixed(2)})`,
      { btcAmount, price, avgCostBasis, ladderStep });
  }

  tpPlaced(exchange, orderId, btcAmount, price) {
    this.emitTradeEvent('tp_placed', exchange,
      `TP placed: ${btcAmount.toFixed(8)} BTC @ $${price.toFixed(2)}`,
      { orderId, btcAmount, price });
  }

  tpUpdated(exchange, orderId, btcAmount, price) {
    this.emitTradeEvent('tp_updated', exchange,
      `TP updated: ${btcAmount.toFixed(8)} BTC @ $${price.toFixed(2)}`,
      { orderId, btcAmount, price });
  }

  tpFilled(exchange, btcAmount, price, pnl, cyclesCompleted) {
    this.emitTradeEvent('tp_filled', exchange,
      `TP filled: ${btcAmount.toFixed(8)} BTC @ $${price.toFixed(2)}, PnL: $${pnl.toFixed(2)}`,
      { btcAmount, price, pnl, cyclesCompleted });
  }

  flashMove(exchange, delta, multiple) {
    this.emitTradeEvent('flash_move', exchange,
      `Flash move: ${multiple.toFixed(1)}x ATR`,
      { delta, multiple });
  }

  spreadPause(exchange, spreadBps, threshold) {
    this.emitTradeEvent('spread_pause', exchange,
      `Spread pause: ${spreadBps.toFixed(1)} bps > ${threshold} bps`,
      { spreadBps, threshold });
  }

  depthPause(exchange, depth, threshold) {
    this.emitTradeEvent('depth_pause', exchange,
      `Depth pause: $${depth.toFixed(0)} < $${threshold}`,
      { depth, threshold });
  }

  safeMode(exchange, reason) {
    this.emitTradeEvent('safe_mode', exchange,
      `SAFE mode: ${reason}`,
      { reason });
  }

  activeMode(exchange) {
    this.emitTradeEvent('active_mode', exchange,
      'Returned to ACTIVE mode',
      {});
  }

  capReached(exchange, capType, current, limit) {
    this.emitTradeEvent('cap_reached', exchange,
      `${capType} cap reached: ${current}/${limit}`,
      { capType, current, limit });
  }

  cycleReset(exchange, cyclesCompleted, realizedPnL) {
    this.emitTradeEvent('cycle_reset', exchange,
      `Cycle reset (${cyclesCompleted} completed, $${realizedPnL.toFixed(2)} realized)`,
      { cyclesCompleted, realizedPnL });
  }

  regimeHourlySummary(exchange, regime, entries, exposure, drawdown) {
    this.emitTradeEvent('regime_hourly', exchange,
      `Hour: regime=${regime} entries=${entries} exposure=${exposure} drawdown=${drawdown}%`,
      { regime, entries, exposure, drawdown });
  }
}

// Singleton instance
const tradeEvents = new TradeEventEmitter();

module.exports = { tradeEvents, TradeEventEmitter };
