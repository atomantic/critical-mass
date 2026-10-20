const row = (tradeId, orderId, side, cycleId, timestamp, size, quoteAmount, netFee, extra = {}) => ({
  tradeId, orderId, side, cycleId, timestamp, size, price: quoteAmount / size,
  quoteAmount, netFee, ...extra,
});

module.exports = () => [
  row('b1', 'buy-1', 'buy', 'cycle-1', 1000, 1, 100, 1, { sellOrderId: 'sell-1' }),
  row('b2', 'buy-2', 'buy', 'cycle-1', 2000, 1, 200, 2, { sellOrderId: 'sell-1' }),
  row('s1a', 'sell-1', 'sell', 'cycle-1', 3000, 0.9, 135, 1, { bodyPnl: 30, bodyHoldbackAsset: 0.2, bodyReservesSoldAsset: 0.05 }),
  row('s1b', 'sell-1', 'sell', 'cycle-1', 4000, 0.9, 135, 1, { bodyPnl: 30, bodyHoldbackAsset: 0.2, bodyReservesSoldAsset: 0.05 }),
  row('b3', 'buy-3', 'buy', 'cycle-2', 5000, 1, 300, 3, { sellOrderId: 'sell-2' }),
  row('s2', 'sell-2', 'sell', 'cycle-2', 6000, 0.8, 320, 2),
  row('b4', 'buy-4', 'buy', 'cycle-2', 7000, 0.2, 60, 0.5),
];
