// @ts-check
/**
 * Returns a promise plus its resolver, for tests that gate async code by hand.
 */
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
};

module.exports = { deferred };
