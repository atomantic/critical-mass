'use strict';

/**
 * UpDown trade log: persistence (corrupt-file detection, .tmp recovery hint,
 * id allocation), trade-record construction and summary statistics.
 * No Express dependency — routes validate input, call this, and shape responses.
 */

const fs = require('fs');

const round2 = (n) => Math.round(n * 10000) / 100;

/**
 * @param {{ path: string, writeJSON: (path: string, data: any) => void }} deps
 */
const createTradeLog = ({ path: tradesPath, writeJSON }) => {
  const read = () => {
    // Missing or empty file is OK — return default. Corrupt file is an error.
    if (fs.existsSync(tradesPath)) {
      const content = fs.readFileSync(tradesPath, 'utf8');
      if (content && content.trim() !== '') {
        try {
          return JSON.parse(content);
        } catch (err) {
          const tmpPath = `${tradesPath}.tmp`;
          const tmpExists = fs.existsSync(tmpPath);
          throw new Error(
            `Trades file is corrupted or incomplete: ${err.message}. ` +
            `Please restore from backup or repair ${tradesPath}.` +
            (tmpExists ? ` A recovery file may exist at ${tmpPath}.` : '')
          );
        }
      }
    }
    return { trades: [], nextId: 1 };
  };

  const list = () => read().trades || [];

  const summarize = (trades) => {
    const sum = (key) => trades.reduce((s, t) => s + (t[key] || 0), 0);
    const upTrades = trades.filter(t => t.direction === 'up');
    const downTrades = trades.filter(t => t.direction === 'down');
    const upWins = upTrades.filter(t => t.pnl > 0).length;
    const downWins = downTrades.filter(t => t.pnl > 0).length;
    return {
      totalCost: sum('cost'),
      totalReturn: sum('returnAmount'),
      totalPnl: sum('pnl'),
      wins: trades.filter(t => t.pnl > 0).length,
      losses: trades.filter(t => t.pnl <= 0).length,
      count: trades.length,
      upWinRate: upTrades.length > 0 ? round2(upWins / upTrades.length) : null,
      downWinRate: downTrades.length > 0 ? round2(downWins / downTrades.length) : null,
      upCount: upTrades.length,
      downCount: downTrades.length,
    };
  };

  const has = (id) => list().some(t => t.id === id);

  /**
   * Build, persist and return a new trade. Input values are pre-validated/parsed.
   * @param {{date?: string, cost: number, returnAmount: number, note?: string,
   *   direction?: string, exitTime: string|null, boughtAtMs?: number|undefined}} input
   * @param {{ctx?: any, getPriceAt?: (ms: number) => number|null|undefined}} [opts]
   */
  const add = (input, { ctx = {}, getPriceAt } = {}) => {
    const { date, cost, returnAmount, note, direction: bodyDirection, exitTime, boughtAtMs } = input;
    const data = read();

    // UP-only: SELL is CLOSE, never a DOWN entry.
    const signalDirection = ctx.latestSignal?.type?.includes('BUY') ? 'up' : null;
    const inferredDirection = bodyDirection || ctx.position?.direction || ctx.contract?.direction || signalDirection;
    const manualOverride = bodyDirection && signalDirection ? bodyDirection !== signalDirection : false;

    const trade = {
      id: data.nextId || (data.trades.length + 1),
      date: date || new Date().toISOString().slice(0, 10),
      cost,
      returnAmount,
      pnl: returnAmount - cost,
      note: note ?? '',
      direction: inferredDirection || null,
      // Without an operator buy time, entryTime/btcPriceAtEntry are the log
      // moment (usually after the exit) — entryTimeSource says which.
      entryTime: new Date(boughtAtMs ?? Date.now()).toISOString(),
      entryTimeSource: boughtAtMs != null ? 'operator' : 'logged',
      loggedAt: new Date().toISOString(),
      exitTime,
      btcPriceAtEntry: boughtAtMs != null
        ? (getPriceAt?.(boughtAtMs) ?? null)
        : (ctx.lastPrice || null),
      btcPriceAtExit: null,
      contract: ctx.contract?.target ? {
        target: ctx.contract.target,
        stop: ctx.contract.stop,
        range: ctx.contract.range,
        direction: ctx.contract.direction,
        expiry: ctx.contract.expiry,
      } : null,
      signal: ctx.latestSignal ? {
        type: ctx.latestSignal.type,
        score: ctx.latestSignal.score,
        confidence: ctx.latestSignal.confidence,
      } : null,
      manualOverride,
    };
    data.trades.push(trade);
    data.nextId = trade.id + 1;
    writeJSON(tradesPath, data);
    return trade;
  };

  /**
   * Apply a pre-validated patch. Returns the updated trade, or null if not found.
   * @param {number} id
   * @param {{date?: string, cost?: number, returnAmount?: number, note?: string,
   *   direction?: string, exitTime?: string, btcPriceAtExit?: number, boughtAtMs?: number}} patch
   * @param {{getPriceAt?: (ms: number) => number|null|undefined}} [opts]
   */
  const update = (id, patch, { getPriceAt } = {}) => {
    const data = read();
    const trade = data.trades.find(t => t.id === id);
    if (!trade) return null;
    if (patch.boughtAtMs !== undefined) {
      trade.entryTime = new Date(patch.boughtAtMs).toISOString();
      trade.entryTimeSource = 'operator';
      trade.btcPriceAtEntry = getPriceAt?.(patch.boughtAtMs) ?? null;
    }
    for (const field of ['date', 'cost', 'returnAmount', 'note', 'direction', 'exitTime', 'btcPriceAtExit']) {
      if (patch[field] != null) trade[field] = patch[field];
    }
    trade.pnl = trade.returnAmount - trade.cost;
    writeJSON(tradesPath, data);
    return trade;
  };

  /** @returns {boolean} true if a trade was removed */
  const remove = (id) => {
    const data = read();
    const idx = data.trades.findIndex(t => t.id === id);
    if (idx === -1) return false;
    data.trades.splice(idx, 1);
    writeJSON(tradesPath, data);
    return true;
  };

  return { list, summary: () => summarize(list()), summarize, has, add, update, remove };
};

module.exports = { createTradeLog };
