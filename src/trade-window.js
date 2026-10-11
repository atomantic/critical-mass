// @ts-check
/**
 * Rolling exchange trades. Expire by exchange timestamp (which can arrive out
 * of order), but expose snapshots in arrival order, including duplicate rows.
 * Each row enters/leaves the expiry heap once: O(log N) per trade instead of
 * filtering and summing the whole window on every exchange message.
 * Trade objects and returned snapshots are read-only to consumers.
 */
const createTradeWindow = (retentionMs) => {
  const active = new Set();
  const expiry = [];
  let snapshot = null;
  let imbalance = 0;
  let nonFinite = 0;
  const buy = { sum: 0, correction: 0, count: 0 };
  const sell = { sum: 0, correction: 0, count: 0 };

  // Compensated addition also handles removals without accumulating cancellation
  // error over a long-running session. Reset when a side has no rows left.
  const adjust = (entry, direction) => {
    if (!Number.isFinite(entry.trade.size)) {
      nonFinite += direction;
      return;
    }
    const total = entry.trade.side === 'buy' ? buy : sell;
    total.count += direction;
    const value = direction * entry.trade.size;
    const next = total.sum + value;
    total.correction += Math.abs(total.sum) >= Math.abs(value)
      ? (total.sum - next) + value : (value - next) + total.sum;
    total.sum = next;
    if (!total.count) total.sum = total.correction = 0;
  };

  const push = (entry) => {
    let index = expiry.length;
    expiry.push(entry);
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (expiry[parent].timestamp <= entry.timestamp) break;
      expiry[index] = expiry[parent];
      index = parent;
    }
    expiry[index] = entry;
  };

  const pop = () => {
    const first = expiry[0];
    const last = expiry.pop();
    if (expiry.length) {
      let index = 0;
      while (index * 2 + 1 < expiry.length) {
        let child = index * 2 + 1;
        if (child + 1 < expiry.length && expiry[child + 1].timestamp < expiry[child].timestamp) child++;
        if (last.timestamp <= expiry[child].timestamp) break;
        expiry[index] = expiry[child];
        index = child;
      }
      expiry[index] = last;
    }
    return first;
  };

  return {
    add(trade, now) {
      const cutoff = now - retentionMs;
      while (expiry.length && expiry[0].timestamp < cutoff) {
        const entry = pop();
        active.delete(entry);
        adjust(entry, -1);
        snapshot = null;
      }
      // Matches the old timestamp filter, including rejecting NaN/missing time.
      if (trade.timestamp >= cutoff) {
        const entry = { trade, timestamp: trade.timestamp };
        active.add(entry);
        push(entry);
        adjust(entry, 1);
        snapshot = null;
      }

      let buyVol = buy.sum + buy.correction;
      let sellVol = sell.sum + sell.correction;
      // Preserve the old behavior for malformed sizes, and recover as soon as
      // they expire. Such rows must not permanently poison the running sums.
      if (nonFinite) {
        buyVol = sellVol = 0;
        for (const { trade: row } of active) {
          if (row.side === 'buy') buyVol += row.size;
          else sellVol += row.size;
        }
      }
      const total = buyVol + sellVol;
      if (!active.size) imbalance = 0;
      else if (total > 0) imbalance = (buyVol - sellVol) / total;
      return imbalance;
    },
    // Only status readers need the full array. No per-trade array allocation.
    getTrades: () => snapshot || (snapshot = Array.from(active, entry => entry.trade)),
  };
};

module.exports = { createTradeWindow };
