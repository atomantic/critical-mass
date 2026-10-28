// Complete-ledger accounting is enriched once per revision before filtering
// or paging. This owner never writes ledger rows or persists trading state.
const { computeFillsWithPnL } = require('../shared/transactions-regime-pnl.mjs');
const { sortFills, summarizeFills, paginate } = require('../shared/transactions-regime-page.mjs');
const { aggregateRegimeFills } = require('../shared/regime-fill-aggregates.mjs');

// Page rows contain only table fields. Ledger ownership annotations and raw
// exchange records remain server-side; accounting still uses the full ledger.
const PAGE_FIELDS = ['tradeId', 'orderId', 'timestamp', 'cycleId', 'side', 'size', 'price', 'quoteAmount', 'fee', 'netFee', 'pnl', 'holdbackAsset', 'holdbackValue', 'avgCost'];
const projectPageRow = row => Object.fromEntries(PAGE_FIELDS.filter(key => key in row).map(key => [key, row[key]]));

const SORT_FIELDS = new Set(['timestamp', 'cycleId', 'side', 'size', 'price', 'quoteAmount', 'fee', 'holdbackAsset', 'pnl']);
const badQuery = error => ({ success: false, statusCode: 400, error });

function parseFillsQuery(input = {}) {
  if (input.paged === undefined) return badQuery('paged=true required');
  if (input.paged !== 'true' && input.paged !== true) return badQuery('paged must be true');
  const integer = (value, fallback) => value === undefined ? fallback
    : (typeof value === 'string' && /^\d+$/.test(value)) || typeof value === 'number'
      ? Number(value) : NaN;
  const page = integer(input.page, 0);
  const pageSize = integer(input.pageSize, 100);
  if (!Number.isSafeInteger(page) || page < 0 || !Number.isSafeInteger(pageSize) || pageSize < 1) {
    return badQuery('page and pageSize must be nonnegative/positive integers');
  }
  const sortField = input.sortField ?? 'timestamp';
  const sortDir = input.sortDir ?? 'desc';
  const side = input.side ?? 'all';
  const cycle = input.cycle ?? 'all';
  if (!SORT_FIELDS.has(sortField) || !['asc', 'desc'].includes(sortDir) || !['all', 'buy', 'sell'].includes(side)
    || typeof cycle !== 'string' || !cycle || cycle.length > 200
    || (input.revision !== undefined && (typeof input.revision !== 'string' || input.revision.length > 100))) {
    return badQuery('Invalid fills sort, filter or revision');
  }
  let cycleOptions = {};
  if (input.cycleOptionsPaged !== undefined && ![true, false, 'true', 'false'].includes(input.cycleOptionsPaged)) {
    return badQuery('cycleOptionsPaged must be true or false');
  }
  if (input.cycleOptionsPaged === true || input.cycleOptionsPaged === 'true') {
    const cycleOffset = integer(input.cycleOffset, 0);
    const cycleLimit = integer(input.cycleLimit, 100);
    const cycleSearch = input.cycleSearch ?? '';
    if (!Number.isSafeInteger(cycleOffset) || cycleOffset < 0 || !Number.isSafeInteger(cycleLimit) || cycleLimit < 1
      || typeof cycleSearch !== 'string' || cycleSearch.length > 200) {
      return badQuery('Invalid cycle option offset, limit or search');
    }
    cycleOptions = { cycleOptionsPaged: true, cycleOffset, cycleLimit: Math.min(cycleLimit, 100), cycleSearch };
  }
  return { ...cycleOptions, paged: true, page, pageSize: Math.min(pageSize, 100), sortField, sortDir, side, cycle, revision: input.revision };
}

// Conditional aggregate reads accept only an opaque, bounded ledger revision.
function parseAggregateQuery(input = {}) {
  if (input.revision !== undefined && (typeof input.revision !== 'string' || !input.revision || input.revision.length > 100)) {
    return badQuery('Invalid aggregate revision');
  }
  return input.revision === undefined ? {} : { revision: input.revision };
}

function compareCycles(a, b) {
  if (a === b) return 0;
  if (a === 'current') return -1;
  if (b === 'current') return 1;
  if (a === 'unknown') return 1;
  if (b === 'unknown') return -1;
  return (parseInt(b.replace('cycle-', '')) || 0) - (parseInt(a.replace('cycle-', '')) || 0);
}

function createTransactionsReadView(readFills, readRevision) {
  let snapshot;
  let recomputations = 0;
  const queries = new Map();
  const currentSnapshot = () => {
    const revision = readRevision();
    if (!snapshot || snapshot.revision !== revision) {
      const fills = readFills();
      const rows = computeFillsWithPnL(fills);
      snapshot = { revision, rows, fills, cycleIds: [...new Set(rows.map(row => row.cycleId || 'current'))].sort(compareCycles), aggregates: null };
      queries.clear();
      recomputations++;
    }
    return snapshot;
  };
  return {
    query(input) {
      const query = parseFillsQuery(input);
      if (query.success === false) return query;
      const revision = readRevision();
      if (query.revision !== undefined && query.revision !== revision) {
        return { success: false, statusCode: 409, code: 'STALE_FILL_REVISION', revision, error: 'Fill history changed; reload page one' };
      }
      currentSnapshot();
      const key = JSON.stringify([query.side, query.cycle, query.sortField, query.sortDir]);
      let result = queries.get(key);
      if (!result) {
        const filtered = snapshot.rows.filter(row => (query.side === 'all' || row.side === query.side)
          && (query.cycle === 'all' || (row.cycleId || 'current') === query.cycle));
        result = { rows: sortFills(filtered, query.sortField, query.sortDir), summary: summarizeFills(filtered) };
        // Bound retained sort/filter variants as well as the response rows.
        if (queries.size >= 8) queries.delete(queries.keys().next().value);
        queries.set(key, result);
      }
      const { rows, ...pageInfo } = paginate(result.rows, query.page, query.pageSize);
      let cycleIds = snapshot.cycleIds;
      let cycleOptions = {};
      if (query.cycleOptionsPaged) {
        // All/Current are fixed UI controls. Search only changes available
        // options, never the exact cycle filter or its accounting summary.
        const search = query.cycleSearch.toLowerCase();
        const matches = cycleIds.filter(id => id !== 'current' && id.toLowerCase().includes(search));
        const offset = Math.min(query.cycleOffset, Math.max(0, Math.ceil(matches.length / query.cycleLimit) - 1) * query.cycleLimit);
        cycleIds = matches.slice(offset, offset + query.cycleLimit);
        cycleOptions = { cycleOptionsInfo: { offset, limit: query.cycleLimit, total: matches.length,
          hasPrev: offset > 0, hasNext: offset + query.cycleLimit < matches.length } };
      }
      return { fills: rows.map(projectPageRow), pageInfo, summary: { ...result.summary }, cycleIds: [...cycleIds], ...cycleOptions, revision };
    },
    aggregates(input = {}) {
      const query = parseAggregateQuery(input);
      if (query.success === false) return query;
      const revision = readRevision();
      // Check at the ledger owner, before enrichment or IPC serialization.
      if (query.revision === revision) return { unchanged: true, revision };
      const current = currentSnapshot();
      if (!current.aggregates) current.aggregates = { ...aggregateRegimeFills(current.fills), revision: current.revision };
      return current.aggregates;
    },
    getRecomputeCount: () => recomputations,
  };
}

module.exports = { parseFillsQuery, parseAggregateQuery, createTransactionsReadView };
