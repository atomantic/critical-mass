// @ts-check
/**
 * Async Mutex
 *
 * Promise-based mutual exclusion lock. Zero external dependencies.
 * Serializes concurrent access to critical sections.
 */

/**
 * Create a mutex instance
 * @returns {{acquire: () => Promise<() => void>, isLocked: () => boolean}}
 */
const createMutex = () => {
  let queue = Promise.resolve();
  let locked = false;

  /**
   * Acquire the lock. Returns a release function.
   * Callers are serialized — second caller waits until first releases.
   * @returns {Promise<() => void>} Release function
   */
  const acquire = () => {
    let release;
    const prev = queue;
    queue = new Promise((resolve) => {
      release = () => {
        locked = queue !== prev; // still locked if more waiters
        resolve();
      };
    });
    locked = true;
    return prev.then(() => release);
  };

  /**
   * Check if mutex is currently locked
   * @returns {boolean}
   */
  const isLocked = () => locked;

  return { acquire, isLocked };
};

module.exports = { createMutex };
