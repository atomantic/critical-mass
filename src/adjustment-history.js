/**
 * Adjustment History
 *
 * Capped, in-memory log of applied optimizer adjustments shared by the
 * size and TP optimizers. Persisted shape is a plain array of entries.
 */

const DEFAULT_MAX_ENTRIES = 50;
const DEFAULT_TAIL = 10;

/**
 * @param {{ max?: number }} [options]
 */
const createAdjustmentHistory = ({ max = DEFAULT_MAX_ENTRIES } = {}) => {
  let entries = [];

  return {
    /** Append an entry, dropping the oldest beyond the cap. */
    push: (entry) => {
      entries.push(entry);
      if (entries.length > max) {
        entries.shift();
      }
    },
    /** Most recent n entries (references, for status display). */
    tail: (n = DEFAULT_TAIL) => entries.slice(-n),
    /** Copy of all entries for persistence. */
    export: () => [...entries],
    /** Restore from persisted state; a missing value leaves history untouched. */
    import: (saved) => {
      if (saved) {
        entries = saved.map(a => ({ ...a }));
      }
    },
    clear: () => {
      entries = [];
    },
  };
};

module.exports = { createAdjustmentHistory, DEFAULT_MAX_ENTRIES, DEFAULT_TAIL };
