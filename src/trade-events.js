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
}

// Singleton instance
const tradeEvents = new TradeEventEmitter();

module.exports = { tradeEvents, TradeEventEmitter };
