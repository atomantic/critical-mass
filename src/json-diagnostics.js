// @ts-check
/**
 * Parser messages may quote credential-bearing input. Build a fresh error
 * from safe metadata only; never retain the original message, stack or cause.
 * @param {Error & {code?: string}} error
 * @param {string} file - Logical file identifier supplied by the reader
 * @returns {Error & {code?: string}}
 */
const jsonReadError = (error, file) => {
  const invalidJson = error instanceof SyntaxError;
  const code = invalidJson ? 'ERR_INVALID_JSON'
    : /^E[A-Z0-9_]+$/.test(error.code || '') ? error.code : 'ERR_JSON_READ';
  const safeError = new Error(`${file}: ${invalidJson ? 'invalid JSON' : 'unable to read JSON'} (${code})`);
  safeError.code = code;
  return safeError;
};

module.exports = { jsonReadError };
