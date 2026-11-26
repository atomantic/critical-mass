// @ts-check
'use strict';

/**
 * Crypto.com app UpDown "Order History" → trade-log cycles, plus contract pricing.
 *
 * One app order row is one contract range [floor, ceiling] for one expiry. Its
 * fills can hold several buy→sell cycles: each sell closes every buy since the
 * previous sell. A cycle is what the trade log records as one trade.
 *
 * Pricing (verified against the app's fills): an Up contract is worth
 *   maxPayout × (BTC − floor) / (ceiling − floor), clamped to [0, maxPayout],
 * with no time decay. maxPayout is 1000 on $2000 ranges and 500 on $500 ranges.
 * The app charges $1.99 per contract per side; fill amounts already include it
 * (a buy costs value + fee, a sell returns value − fee). Touching the floor knocks
 * the contract out at 0, touching the ceiling knocks it out at maxPayout, and an
 * in-range contract settles at the expiry price.
 *
 * Expiry: contracts expire on the listed Saturday at 04:00 America/New_York
 * (08:00 UTC in EDT, 09:00 UTC in EST) — the expiry the live contract config
 * records and this week's app countdown both match.
 */

const FEE_PER_CONTRACT = 1.99;
const APP_SOURCE = 'app-order-history';

const round2 = (n) => Math.round(n * 100) / 100;

/** Max payout per contract for a range width. */
const maxPayoutForRange = (range) => (range <= 500 ? 500 : 1000);

/**
 * Contract value before fees, clamped to the knock-out bounds.
 * @param {number} btc
 * @param {{floor: number, ceiling: number, maxPayout?: number}} c
 */
const contractValue = (btc, { floor, ceiling, maxPayout = maxPayoutForRange(ceiling - floor) }) => {
  if (btc <= floor) return 0;
  if (btc >= ceiling) return maxPayout;
  return maxPayout * (btc - floor) / (ceiling - floor);
};

/** Cost of buying `qty` contracts at `btc`, fee included. */
const buyCost = (btc, c, qty = 1) => qty * (contractValue(btc, c) + FEE_PER_CONTRACT);
/** Proceeds of selling `qty` contracts at `btc`, fee deducted (settlement included). */
const sellProceeds = (btc, c, qty = 1) => qty * (contractValue(btc, c) - FEE_PER_CONTRACT);

const newYorkHour = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York', hour: 'numeric', hourCycle: 'h23',
});

/** Expiry instant: Saturday 04:00 America/New_York of the given YYYY-MM-DD. */
const expiryMs = (date) => {
  const [y, m, d] = date.split('-').map(Number);
  // 04:00 New York is 08:00 UTC during DST and 09:00 UTC otherwise.
  for (const hourUtc of [8, 9]) {
    const ms = Date.UTC(y, m - 1, d, hourUtc);
    const ny = newYorkHour.format(ms);
    if (Number(ny) === 4) return ms;
  }
  return Date.UTC(y, m - 1, d, 9);
};

/**
 * @typedef {{side: 'buy'|'sell', qty: number, btc: number, amount: number, time: string,
 *   orderSent?: string, exit?: 'closed'|'take_profit'|'knocked_out'}} AppFill
 * @typedef {{qty: number, btc: number, placed: string, canceled?: string, filled?: string}} AppTpOrder
 * @typedef {{n?: number, range: [number, number], expiry: string, note?: string,
 *   fills: AppFill[], tpOrders?: AppTpOrder[], pnl: number}} AppOrder
 */

/** Stable identity of an app order row: range, expiry and first fill time. */
const appOrderKey = (order) =>
  `${order.expiry}|${order.range[0]}-${order.range[1]}|${Date.parse(order.fills[0].time)}`;

/**
 * Validate one parsed app order; returns an error string or null.
 * @param {any} o
 */
const validateAppOrder = (o) => {
  if (!o || !Array.isArray(o.range) || o.range.length !== 2 || !(o.range[0] < o.range[1])) return 'range must be [floor, ceiling]';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(o.expiry || '')) return 'expiry must be YYYY-MM-DD';
  if (!Array.isArray(o.fills) || o.fills.length < 2) return 'fills must hold at least one buy and one sell';
  for (const f of o.fills) {
    if (!['buy', 'sell'].includes(f.side) || !(f.qty > 0) || !(f.btc > 0) || !Number.isFinite(f.amount) || !Number.isFinite(Date.parse(f.time))) {
      return `invalid fill ${JSON.stringify(f)}`;
    }
  }
  if (o.fills[o.fills.length - 1].side !== 'sell') return 'last fill must be a sell (an order with an open position cannot be imported; remove it from the file until it closes)';
  // Each sell closes exactly the contracts bought since the previous sell; anything
  // else would book one cycle's cost against another's proceeds.
  let open = 0;
  for (const f of o.fills) {
    if (f.side === 'buy') { open += f.qty; continue; }
    if (open === 0 || Math.abs(f.qty - open) > 1e-9) return `sell of ${f.qty} at ${f.time} does not close the ${open} contract(s) bought since the previous sell`;
    open = 0;
  }
  const net = o.fills.reduce((s, f) => s + (f.side === 'sell' ? f.amount : -f.amount), 0);
  if (!Number.isFinite(o.pnl) || Math.abs(net - o.pnl) > 0.01) return `sells − buys (${round2(net)}) != pnl (${o.pnl})`;
  return null;
};

/**
 * Split app orders into closed cycles, shaped as trade-log fields.
 * @param {AppOrder[]} orders
 */
const deriveCycles = (orders) => {
  const cycles = [];
  for (const order of orders) {
    const err = validateAppOrder(order);
    if (err) throw new Error(`App order ${order?.n ?? '?'}: ${err}`);
    const [floor, ceiling] = order.range;
    const range = ceiling - floor;
    const key = appOrderKey(order);
    const expiry = expiryMs(order.expiry);
    let buys = [];
    let cycleIndex = 0;
    for (const fill of order.fills) {
      if (fill.side === 'buy') { buys.push(fill); continue; }
      const first = buys[0];
      const startMs = Date.parse(first.time);
      const endMs = Date.parse(fill.time);
      const contracts = buys.reduce((s, b) => s + b.qty, 0);
      const cost = round2(buys.reduce((s, b) => s + b.amount, 0));
      const returnAmount = round2(fill.amount);
      const toFill = (f) => ({ side: f.side, qty: f.qty, btcPrice: f.btc, amount: f.amount, time: new Date(Date.parse(f.time)).toISOString(),
        ...(f.orderSent ? { orderSent: new Date(Date.parse(f.orderSent)).toISOString() } : {}),
        ...(f.exit ? { exitType: f.exit } : {}) });
      // A TP order belongs to the cycle it was placed in.
      const tpOrders = (order.tpOrders || [])
        .filter(tp => { const p = Date.parse(tp.placed); return p >= startMs && p <= endMs; })
        .map(tp => ({ qty: tp.qty, btcPrice: tp.btc, placed: new Date(Date.parse(tp.placed)).toISOString(),
          status: tp.filled ? 'filled' : 'canceled',
          closedAt: new Date(Date.parse(tp.filled || tp.canceled || tp.placed)).toISOString() }));
      cycles.push({
        importKey: `${key}#${cycleIndex}`,
        appOrderKey: key,
        appCycleIndex: cycleIndex,
        appCycleCount: order.fills.filter(f => f.side === 'sell').length,
        cost,
        returnAmount,
        pnl: round2(returnAmount - cost),
        contracts,
        fees: round2(FEE_PER_CONTRACT * (contracts + fill.qty)),
        exitType: fill.exit || 'closed',
        entryTime: new Date(startMs).toISOString(),
        exitTime: new Date(endMs).toISOString(),
        btcPriceAtEntry: first.btc,
        btcPriceAtExit: fill.btc,
        holdMinutes: round2((endMs - startMs) / 60_000),
        contract: {
          floor, ceiling, range, direction: 'up', expiry, expiryDate: order.expiry,
          maxPayout: maxPayoutForRange(range),
          // Legacy names used by live-context records.
          target: ceiling, stop: floor,
        },
        fills: [...buys, fill].map(toFill),
        tpOrders,
        appNote: order.note || null,
      });
      buys = [];
      cycleIndex++;
    }
  }
  return cycles;
};

/** Parse JSONL text into app orders (blank lines ignored). */
const parseOrderHistory = (text) => text.split('\n').filter(l => l.trim()).map((l, i) => {
  try { return JSON.parse(l); } catch (err) { throw new Error(`order-history line ${i + 1}: ${err.message}`); }
});

module.exports = {
  FEE_PER_CONTRACT,
  APP_SOURCE,
  maxPayoutForRange,
  contractValue,
  buyCost,
  sellProceeds,
  expiryMs,
  appOrderKey,
  validateAppOrder,
  deriveCycles,
  parseOrderHistory,
};
