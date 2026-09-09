// @ts-check
/**
 * Merge `incoming` candles into `existing`, keyed by timestamp, last-write-wins.
 * Unlike `filter(!has(timestamp))`, this REPLACES a same-timestamp candle, so a
 * boundary bucket re-fetched as complete overwrites the earlier partial (#206).
 * @param {Array} existing - Existing cached candles
 * @param {Array} incoming - New candles to merge (win on timestamp collision)
 * @returns {Array} Merged candles (ascending by timestamp)
 */
const upsertCandles = (existing, incoming) => {
  const byTs = new Map((existing || []).map(c => [c.timestamp, c]));
  for (const c of (incoming || [])) byTs.set(c.timestamp, c);
  return Array.from(byTs.values()).sort((a, b) => a.timestamp - b.timestamp);
};

module.exports = { upsertCandles };
