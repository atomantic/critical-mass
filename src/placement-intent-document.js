// @ts-check
// Envelope and row rules for placement-intents.json, shared by the live store
// (placement-intent-storage) and recovery snapshots (backup-service) so both
// judge a file identically.

/** Basename of the durable per-fund intents file. */
const PLACEMENT_INTENTS_FILENAME = 'placement-intents.json';

/**
 * Parse a placement-intents document. Shared by the live store and the
 * recovery-snapshot service so both judge an envelope identically. A corrupt
 * document throws rather than reading as empty: "empty" is the shape that means
 * "nothing outstanding, safe to place", and guessing that from an unreadable
 * file is exactly the double-placement this module exists to prevent.
 * @param {string} raw - File contents
 * @param {string} file - Path named in the error message
 * @returns {Array<Object>} Persisted intents
 */
const parsePlacementIntentsDocument = (raw, file) => {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`placement intent file at ${file} is corrupted or unreadable: ${err.message}. Repair or move the file aside before starting.`);
  }
  if (!Array.isArray(parsed?.intents)) {
    throw new Error(`placement intent file at ${file} did not parse to {intents: []}. Repair or move the file aside before starting.`);
  }
  return parsed.intents;
};

/**
 * Stricter row check for copying intents between files (recovery snapshots):
 * a row without a string id and status cannot be reconciled or de-duplicated,
 * so it must not be silently carried into a restored safety record.
 * @param {Array<Object>} intents - Parsed intents
 * @param {string} file - Path named in the error message
 * @returns {Array<Object>} The same intents
 */
const assertPlacementIntentRows = (intents, file) => {
  const bad = intents.findIndex((row) => !row || typeof row !== 'object' || Array.isArray(row)
    || typeof row.id !== 'string' || row.id === '' || typeof row.status !== 'string');
  if (bad !== -1) throw new Error(`placement intent file at ${file} has a malformed row at index ${bad} (needs string id and status)`);
  return intents;
};

module.exports = { PLACEMENT_INTENTS_FILENAME, parsePlacementIntentsDocument, assertPlacementIntentRows };
