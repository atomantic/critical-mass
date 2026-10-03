// Complete-ledger accounting is enriched once per revision before filtering
// or paging. This owner never writes ledger rows or persists trading state.
const { computeFillsWithPnL } = require('../shared/transactions-regime-pnl.mjs');
const { sortFills, summarizeFills, paginate } = require('../shared/transactions-regime-page.mjs');

const SORT_FIELDS = new Set(['timestamp', 'cycleId', 'side', 'size', 'price', 'quoteAmount', 'fee', 'holdbackAsset', 'pnl']);
const badQuery = error => ({ success: false, statusCode: 400, error });

function parseFillsQuery(input = {}) {
  if (input.paged === undefined) return { paged: false };
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
  return { paged: true, page, pageSize: Math.min(pageSize, 100), sortField, sortDir, side, cycle, revision: input.revision };
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
  return {
    query(input) {
      const query = parseFillsQuery(input);
      if (query.success === false) return query;
      if (!query.paged) return badQuery('Paged query required');
      const revision = readRevision();
      if (query.revision !== undefined && query.revision !== revision) {
        return { success: false, statusCode: 409, code: 'STALE_FILL_REVISION', revision, error: 'Fill history changed; reload page one' };
      }
      if (!snapshot || snapshot.revision !== revision) {
        const rows = computeFillsWithPnL(readFills());
        snapshot = { revision, rows, cycleIds: [...new Set(rows.map(row => row.cycleId || 'current'))].sort(compareCycles) };
        queries.clear();
        recomputations++;
      }
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
      return { fills: rows.map(row => ({ ...row })), pageInfo, summary: { ...result.summary }, cycleIds: [...snapshot.cycleIds], revision };
    },
    getRecomputeCount: () => recomputations,
  };
}

module.exports = { parseFillsQuery, createTransactionsReadView };
