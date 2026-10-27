// @ts-check
/**
 * Persisted-payload validation
 *
 * Side-effect-free compatibility rules for the accounting files the readers
 * (fill-ledger.js, fund-state-storage.js, updown-service.js) refuse on a cold
 * read. Backup and restore apply the SAME rules before a recovery point is
 * published or committed, so a restore can never replace a working file with
 * one the next boot rejects (issue #1811). Nothing here reads the filesystem,
 * quarantines, normalizes or strips fields.
 */

const { isFiniteNumber, isPlainObject } = require('./value-guards');

/**
 * On-disk format revision of fill-ledger.json. Every persisted row carries it
 * as `formatVersion`; the file stays a bare array so backup, migration and DCA
 * conversion tooling keep working. A build refuses a ledger containing a row
 * stamped newer than it understands (issue #1397): running an older build over
 * newer trading data is unsupported, because fields it does not maintain
 * (e.g. `consumedBy`, `bodyBookedSize`) would go stale and be misread on the
 * next upgrade. Rows with no stamp predate versioning (revision 0).
 * Bump this whenever a field's meaning changes in a way an older build would
 * mishandle.
 */
const LEDGER_FORMAT_VERSION = 1;

/**
 * @param {Array<Object>} data - ledger rows
 * @returns {number} highest formatVersion found (0 when none stamped)
 */
const maxLedgerFormatVersion = (data) => data.reduce((max, fill) => {
  const v = Number(fill?.formatVersion);
  return Number.isFinite(v) && v > max ? v : max;
}, 0);

/**
 * Validate a parsed-from-JSON ledger payload against the same shape rules
 * load() applies before resetCaches. Returns null when the payload is
 * acceptable, or a human-readable reason string for the first invalid
 * entry. Shared between load()'s pre-pass and persist({force:true})'s
 * "preserve operator edits" short-circuit so they agree on what counts
 * as repairable vs preservable.
 *
 * Fields required by aggregateFills/rebuildPositionFromFills are
 * validated as REQUIRED (not "when present"): a row missing side, size,
 * price, quoteAmount, netFee/fee, or timestamp would otherwise produce
 * NaN totals downstream and silently corrupt position / P&L state.
 * tradeIds are also checked for uniqueness because load() stores
 * entries in a Map keyed by tradeId and a duplicate would silently
 * overwrite the earlier row.
 *
 * @param {unknown} data - JSON-parsed file content
 * @returns {string | null} reason if invalid, else null
 */
const findInvalidLedgerReason = (data) => {
  if (!Array.isArray(data)) return 'top-level value is not an array';
  const seenTradeIds = new Set();
  for (const fill of data) {
    if (!fill || typeof fill !== 'object') return 'non-object entry';
    if (typeof fill.tradeId !== 'string' || !fill.tradeId) return 'missing or non-string tradeId';
    if (seenTradeIds.has(fill.tradeId)) return `duplicate tradeId '${fill.tradeId}'`;
    if (fill.side !== 'buy' && fill.side !== 'sell') return "side must be 'buy' or 'sell'";
    if (!isFiniteNumber(fill.size)) return 'size must be a finite number';
    // rebuildPositionFromFills restores lastEntryPrice / anchorPrice
    // directly from fill.price; a NaN/null price would poison entry
    // tracking and slip through aggregateFills (which uses quoteAmount,
    // not price, so an inconsistent pair would also escape there).
    if (!isFiniteNumber(fill.price)) return 'price must be a finite number';
    if (!isFiniteNumber(fill.quoteAmount)) return 'quoteAmount must be a finite number';
    // Legacy ledgers (pre-rebate-split) wrote `fee` only without
    // `netFee`. Downstream regime-engine.js:1259-1260 already reads
    // via `fill.netFee || fill.fee`, so accept either; load()
    // backfills `netFee` from `fee` for the in-memory copy so the
    // many other call sites that read `fill.netFee` directly never
    // see undefined.
    if (!isFiniteNumber(fill.netFee) && !isFiniteNumber(fill.fee)) return 'netFee or fee must be a finite number';
    if (!isFiniteNumber(fill.timestamp)) return 'timestamp must be a finite number';
    // orderId is optional (legacy/manual entries may omit it; downstream
    // truthiness-guards every read), but MUST be a string when present.
    if (fill.orderId != null && typeof fill.orderId !== 'string') return 'orderId must be a string when present';
    if (fill.cycleId != null && typeof fill.cycleId !== 'string') return 'cycleId must be a string when present';
    const reconciledTrades = fill.syntheticCoverage?.reconciledTrades;
    if (reconciledTrades != null && !Array.isArray(reconciledTrades)) {
      return 'syntheticCoverage.reconciledTrades must be an array when present';
    }
    const reconciledTradeIds = new Set();
    let reconciledSize = 0;
    for (const allocation of reconciledTrades || []) {
      if (!allocation || typeof allocation !== 'object'
        || typeof allocation.tradeId !== 'string' || !allocation.tradeId
        || !isFiniteNumber(allocation.size) || allocation.size <= 0
        || !isFiniteNumber(allocation.quoteAmount) || !isFiniteNumber(allocation.fee)
        || !isFiniteNumber(allocation.netFee) || !isFiniteNumber(allocation.rebate)
        || reconciledTradeIds.has(allocation.tradeId)) {
        return 'syntheticCoverage.reconciledTrades contains an invalid allocation';
      }
      reconciledTradeIds.add(allocation.tradeId);
      reconciledSize += allocation.size;
    }
    if (reconciledSize > fill.size + 1e-9) {
      return 'syntheticCoverage.reconciledTrades exceeds covered fill size';
    }
    const originalEconomics = fill.syntheticCoverage?.originalEconomics;
    if (originalEconomics != null && ['quoteAmount', 'fee', 'netFee', 'rebate']
      .some(key => !isFiniteNumber(originalEconomics[key]))) return 'invalid original synthetic economics';
    const corrections = fill.buyEconomicCorrections;
    if (corrections != null && !Array.isArray(corrections)) return 'invalid buy correction journal';
    for (const correction of corrections || []) {
      if (!correction || typeof correction.id !== 'string' || !correction.id
        || correction.orderId !== fill.orderId || !isFiniteNumber(correction.size) || correction.size <= 0
        || !isFiniteNumber(correction.costDelta) || !isFiniteNumber(correction.consumedQty)
        || correction.consumedQty < 0 || correction.consumedQty > correction.size + 1e-8
        || typeof correction.owned !== 'boolean' || !['pending', 'applied'].includes(correction.status)
        || !Array.isArray(correction.sells) || correction.sells.some(sell =>
          !sell || typeof sell.sellOrderId !== 'string' || !sell.sellOrderId
          || !isFiniteNumber(sell.costDelta) || !isFiniteNumber(sell.capitalCreditFraction)
          || sell.capitalCreditFraction < 0 || sell.capitalCreditFraction > 1)) {
        return 'invalid buy correction journal';
      }
    }
    const sellCorrections = fill.sellEconomicCorrections;
    if (sellCorrections != null && !Array.isArray(sellCorrections)) return 'invalid sell correction journal';
    for (const correction of sellCorrections || []) {
      if (!correction || typeof correction.id !== 'string' || !correction.id
        || correction.orderId !== fill.orderId
        || ['quoteDelta', 'netFeeDelta', 'bodyPnlDelta', 'satellitePnlDelta', 'capitalDelta',
          'auditProceedsDelta', 'auditFeesDelta', 'auditPnlDelta'].some(key => !isFiniteNumber(correction[key]))
        || !['pending', 'applied'].includes(correction.status)) {
        return 'invalid sell correction journal';
      }
    }
    seenTradeIds.add(fill.tradeId);
  }
  return null;
};

/** On-disk format revision of updown-state.json (see updown-service.js). */
const UPDOWN_STATE_FORMAT_VERSION = 1;

/** Top-level directories that never hold per-fund accounting files. */
const NON_FUND_DIRS = new Set(['backups', 'updown']);

/**
 * Per-fund / UpDown accounting file kinds this module knows how to validate.
 * @typedef {'ledger' | 'fund-state' | 'updown-state'} PayloadKind
 */

/**
 * Classify an archive-relative or snapshot-relative path. Fund files live at
 * `<exchange>/<pair>/<file>` (or `<exchange>/<file>` in pre-multi-pair
 * archives); the UpDown state sits at the data root.
 * @param {string} relPath - forward-slash relative path
 * @returns {PayloadKind | null} null for files without a reader contract here
 */
const classifyPayloadPath = (relPath) => {
  const segments = relPath.split('/').filter(Boolean);
  const name = segments[segments.length - 1];
  const isFundLevel = (segments.length === 2 || segments.length === 3) && !NON_FUND_DIRS.has(segments[0]);
  if (isFundLevel && name === 'fill-ledger.json') return 'ledger';
  if (isFundLevel && (name === 'state.json' || name === 'regime-state.json')) return 'fund-state';
  if (segments.length === 1 && name === 'updown-state.json') return 'updown-state';
  return null;
};

/**
 * @param {unknown} value
 * @returns {string}
 */
const describeType = (value) => (value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value);

/**
 * Apply the matching reader's refusal rules to a parsed payload.
 * @param {PayloadKind} kind
 * @param {unknown} data - JSON-parsed content
 * @returns {string | null} reason the reader would refuse it, else null
 */
const findIncompatiblePayloadReason = (kind, data) => {
  if (kind === 'ledger') {
    if (!Array.isArray(data)) return `is not an array (got ${describeType(data)})`;
    const newerFormat = maxLedgerFormatVersion(data);
    if (newerFormat > LEDGER_FORMAT_VERSION) {
      return `was written by a newer build (format v${newerFormat}; this build supports up to v${LEDGER_FORMAT_VERSION})`;
    }
    const invalid = findInvalidLedgerReason(data);
    return invalid ? `contains an invalid entry (${invalid})` : null;
  }
  if (!isPlainObject(data)) return `did not parse to an object (got ${describeType(data)})`;
  if (kind === 'updown-state' && Number(/** @type {any} */ (data).formatVersion) > UPDOWN_STATE_FORMAT_VERSION) {
    return `was written by a newer build (format v${/** @type {any} */ (data).formatVersion}; this build supports up to v${UPDOWN_STATE_FORMAT_VERSION})`;
  }
  return null;
};

/**
 * Validate one persisted accounting file's text for restore/publication.
 * @param {string} relPath - forward-slash path relative to the data root (or snapshot root)
 * @param {string | Buffer} content - raw file bytes
 * @returns {{ok: true} | {ok: false, error: string}} ok:true also for unclassified files
 */
const validatePersistedPayload = (relPath, content) => {
  const kind = classifyPayloadPath(relPath);
  if (!kind) return { ok: true };
  let data;
  try {
    data = JSON.parse(content.toString());
  } catch (err) {
    return { ok: false, error: `${relPath} is corrupted or unreadable: ${err.message}` };
  }
  const reason = findIncompatiblePayloadReason(kind, data);
  return reason ? { ok: false, error: `${relPath} ${reason}` } : { ok: true };
};

module.exports = {
  LEDGER_FORMAT_VERSION,
  UPDOWN_STATE_FORMAT_VERSION,
  maxLedgerFormatVersion,
  findInvalidLedgerReason,
  classifyPayloadPath,
  findIncompatiblePayloadReason,
  validatePersistedPayload,
};
