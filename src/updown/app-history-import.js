// @ts-check
'use strict';

/**
 * Reconcile the UpDown trade log against cycles derived from the Crypto.com app
 * order history (see app-order-history.js). Pure: takes the ledger object and the
 * cycles, returns the next ledger and a diff. Idempotent — a trade that already
 * carries a cycle's importKey is matched by key, so a re-import changes nothing.
 *
 * Matching for manual trades (no importKey), each trade used at most once:
 *   1. exact cost AND return (to the cent); ties broken by nearest date
 *   2. exact return OR exact cost within 7 days of the cycle's exit (the other
 *      amount is corrected to the app's value and reported)
 * Unmatched cycles are added as new trades. Unmatched manual trades are left
 * untouched and reported — the importer never deletes.
 */

const { APP_SOURCE } = require('./app-order-history');

const CENT = 0.005;
const DAY_MS = 86_400_000;
const NEAR_DAYS = 7;

/** Fields the importer owns on an imported trade. */
const IMPORT_FIELDS = [
  'cost', 'returnAmount', 'pnl', 'direction', 'entryTime', 'entryTimeSource', 'exitTime',
  'btcPriceAtEntry', 'btcPriceAtExit', 'contract', 'contracts', 'fees', 'exitType', 'holdMinutes',
  'fills', 'tpOrders', 'source', 'importKey', 'appOrderKey', 'appCycleIndex', 'appCycleCount', 'appNote',
];

const same = (a, b) => Math.abs(a - b) < CENT;
const dateMs = (d) => Date.parse(`${d}T12:00:00Z`);
const exitDate = (c) => c.exitTime.slice(0, 10);

/** Trade-log fields for a cycle. */
const cycleFields = (c) => ({
  cost: c.cost,
  returnAmount: c.returnAmount,
  pnl: c.pnl,
  direction: 'up',
  entryTime: c.entryTime,
  entryTimeSource: 'app',
  exitTime: c.exitTime,
  btcPriceAtEntry: c.btcPriceAtEntry,
  btcPriceAtExit: c.btcPriceAtExit,
  contract: c.contract,
  contracts: c.contracts,
  fees: c.fees,
  exitType: c.exitType,
  holdMinutes: c.holdMinutes,
  fills: c.fills,
  tpOrders: c.tpOrders,
  source: APP_SOURCE,
  importKey: c.importKey,
  appOrderKey: c.appOrderKey,
  appCycleIndex: c.appCycleIndex,
  appCycleCount: c.appCycleCount,
  appNote: c.appNote,
});

const changedFields = (trade, next) =>
  IMPORT_FIELDS.filter(k => JSON.stringify(trade[k] ?? null) !== JSON.stringify(next[k] ?? null));

/**
 * @param {{trades: any[], nextId?: number}} ledger
 * @param {ReturnType<typeof import('./app-order-history').deriveCycles>} cycles
 * @param {{now?: string}} [opts]
 */
const reconcile = (ledger, cycles, { now = new Date().toISOString() } = {}) => {
  const trades = ledger.trades.map(t => ({ ...t }));
  let nextId = ledger.nextId || (trades.reduce((m, t) => Math.max(m, t.id), 0) + 1);
  const used = new Set();
  /** @type {Map<string, {trade: any, how: string}>} */
  const matched = new Map();

  for (const c of cycles) {
    const t = trades.find(x => x.importKey === c.importKey);
    if (t) { used.add(t.id); matched.set(c.importKey, { trade: t, how: 'key' }); }
  }
  const pick = (c, pred, how, maxDays = Infinity) => {
    const target = dateMs(exitDate(c));
    const candidates = trades
      .filter(t => !used.has(t.id) && !t.importKey && pred(t))
      .map(t => ({ t, dist: Math.abs(dateMs(t.date) - target) }))
      .filter(x => x.dist <= maxDays * DAY_MS)
      .sort((a, b) => a.dist - b.dist || a.t.id - b.t.id);
    if (!candidates.length) return;
    used.add(candidates[0].t.id);
    matched.set(c.importKey, { trade: candidates[0].t, how });
  };
  // Pass 1 for every cycle before pass 2, so a fuzzy match can't steal an exact one.
  for (const c of cycles) if (!matched.has(c.importKey)) pick(c, t => same(t.cost, c.cost) && same(t.returnAmount, c.returnAmount), 'exact');
  for (const c of cycles) {
    if (!matched.has(c.importKey)) pick(c, t => same(t.returnAmount, c.returnAmount) || same(t.cost, c.cost), 'near', NEAR_DAYS);
  }

  const diff = { enriched: [], corrected: [], added: [], unchanged: [], unmatchedManual: [] };
  for (const c of cycles) {
    const next = cycleFields(c);
    const m = matched.get(c.importKey);
    if (!m) {
      const trade = { id: nextId++, date: exitDate(c), ...next, note: '', loggedAt: now, signal: null, manualOverride: false };
      trades.push(trade);
      diff.added.push({ id: trade.id, date: trade.date, cost: c.cost, returnAmount: c.returnAmount, pnl: c.pnl, importKey: c.importKey });
      continue;
    }
    const { trade, how } = m;
    const changes = changedFields(trade, next);
    if (!changes.length && trade.date === exitDate(c)) { diff.unchanged.push(trade.id); continue; }
    // Keep the operator's values for anything the import replaces, once.
    if (!trade.importedFrom) {
      const previous = {};
      for (const k of [...changes, 'date']) if (trade[k] !== undefined) previous[k] = trade[k];
      trade.importedFrom = { at: now, match: how, previous };
    }
    const amountChanges = ['cost', 'returnAmount'].filter(k => !same(trade[k] ?? NaN, next[k]));
    Object.assign(trade, next, { date: exitDate(c) });
    const row = { id: trade.id, match: how, date: trade.date, pnl: c.pnl, importKey: c.importKey, fields: changes };
    if (amountChanges.length) {
      diff.corrected.push({ ...row, from: Object.fromEntries(amountChanges.map(k => [k, trade.importedFrom.previous[k]])),
        to: Object.fromEntries(amountChanges.map(k => [k, next[k]])) });
    } else diff.enriched.push(row);
  }
  for (const t of trades) {
    if (!used.has(t.id) && !t.importKey) diff.unmatchedManual.push({ id: t.id, date: t.date, cost: t.cost, returnAmount: t.returnAmount, pnl: t.pnl });
  }
  trades.sort((a, b) => Date.parse(a.exitTime || `${a.date}T23:59:59Z`) - Date.parse(b.exitTime || `${b.date}T23:59:59Z`) || a.id - b.id);
  return { ledger: { ...ledger, trades, nextId }, diff };
};

/**
 * Shape check for a trade record, including the optional import fields.
 * Returns a list of problems (empty when valid). Manual records stay valid.
 * @param {any} t
 */
const validateTradeRecord = (t) => {
  const errs = [];
  if (!Number.isInteger(t?.id)) errs.push('id must be an integer');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(t?.date || '')) errs.push('date must be YYYY-MM-DD');
  for (const k of ['cost', 'returnAmount', 'pnl']) if (!Number.isFinite(t?.[k])) errs.push(`${k} must be finite`);
  if (Number.isFinite(t?.cost) && Number.isFinite(t?.returnAmount) && Number.isFinite(t?.pnl)
    && Math.abs(t.returnAmount - t.cost - t.pnl) > 0.01) errs.push('pnl must equal returnAmount − cost');
  if (t?.source != null && t.source !== APP_SOURCE) errs.push(`unknown source ${t.source}`);
  if (t?.source === APP_SOURCE) {
    if (typeof t.importKey !== 'string') errs.push('importKey required on imported trades');
    if (!Array.isArray(t.fills) || !t.fills.length) errs.push('fills required on imported trades');
    const c = t.contract;
    if (!c || !(c.floor < c.ceiling) || c.range !== c.ceiling - c.floor || !Number.isFinite(c.expiry)) errs.push('contract floor/ceiling/range/expiry invalid');
    if (!Number.isInteger(t.contracts) || t.contracts < 1) errs.push('contracts must be a positive integer');
    if (!['closed', 'take_profit', 'knocked_out'].includes(t.exitType)) errs.push(`unknown exitType ${t.exitType}`);
    for (const f of t.fills || []) {
      if (!['buy', 'sell'].includes(f.side) || !(f.qty > 0) || !(f.btcPrice > 0) || !Number.isFinite(f.amount) || !Number.isFinite(Date.parse(f.time))) {
        errs.push(`invalid fill ${JSON.stringify(f)}`);
      }
    }
    if (Array.isArray(t.fills) && t.fills.length) {
      const net = t.fills.reduce((s, f) => s + (f.side === 'sell' ? f.amount : -f.amount), 0);
      if (Math.abs(net - t.pnl) > 0.01) errs.push('fills do not sum to pnl');
    }
  }
  return errs;
};

/** Validate a whole ledger: per-record shape, unique ids and importKeys, nextId. */
const validateLedger = (ledger) => {
  const errs = [];
  const ids = new Set();
  const keys = new Set();
  for (const t of ledger.trades || []) {
    for (const e of validateTradeRecord(t)) errs.push(`trade ${t?.id}: ${e}`);
    if (ids.has(t.id)) errs.push(`duplicate id ${t.id}`);
    ids.add(t.id);
    if (t.importKey) { if (keys.has(t.importKey)) errs.push(`duplicate importKey ${t.importKey}`); keys.add(t.importKey); }
  }
  if (!(ledger.nextId > Math.max(0, ...ids))) errs.push('nextId must exceed every id');
  return errs;
};

module.exports = { reconcile, validateTradeRecord, validateLedger, IMPORT_FIELDS };
