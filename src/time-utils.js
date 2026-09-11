// @ts-check
/**
 * Timestamp formatting utilities.
 * Replaces scattered `.toISOString().slice(11, 23)` calls.
 */

/** HH:MM:SS.mmm timestamp for log lines */
const ts = () => new Date().toISOString().slice(11, 23);

module.exports = { ts };
