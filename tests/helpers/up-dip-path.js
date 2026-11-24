/**
 * Three deterministic weeks of 1m BTC candles with dips, recoveries, floor and
 * ceiling knock-outs and expiries, for pinning Up dip backtest results.
 */
const MIN = 60_000;
const START = Date.parse('2026-06-01T00:00:00Z');
const BARS = 21 * 1440;

const upDipPath = () => {
  let seed = 20261124;
  const rand = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const candles = [];
  let price = 64000;
  for (let i = 0; i < BARS; i++) {
    const open = price;
    // Pulled gently back to a slow wave, so it trends both ways and mean-reverts.
    const swing = i < 14 * 1440 ? 1500 : 250; // a calm last week, so something expires
    const centre = 64000 + swing * Math.sin(i / 1500);
    price += (rand() - 0.5) * 78 + (centre - price) * 0.004;
    const close = price = Math.round(price * 100) / 100;
    const wick = rand() * 15;
    candles.push({ timestamp: START + i * MIN, open, close, high: Math.max(open, close) + wick, low: Math.min(open, close) - wick, volume: 1 });
  }
  return candles;
};

module.exports = { upDipPath, START, MIN };
