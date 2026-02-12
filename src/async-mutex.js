// @ts-check
/**
 * Async Mutex
 *
 * Promise-based mutual exclusion lock. Zero external dependencies.
 * Serializes concurrent access to critical sections.
 */

/**
 * Create a mutex instance
 * @param {number} [timeoutMs=30000] - Auto-release timeout in ms (0 = no timeout)
 * @returns {{acquire: () => Promise<() => void>, isLocked: () => boolean}}
 */
const createMutex = (timeoutMs = 30000) => {
  let queue = Promise.resolve();
  let waiters = 0;

  /**
   * Acquire the lock. Returns a release function.
   * Callers are serialized — second caller waits until first releases.
   * Auto-releases after timeoutMs to prevent permanent deadlocks.
   * @returns {Promise<() => void>} Release function
   */
  const acquire = () => {
    let release;
    let released = false;
    let timer = null;

    const prev = queue;
    queue = new Promise((resolve) => {
      release = () => {
        if (released) return;
        released = true;
        if (timer) clearTimeout(timer);
        waiters--;
        resolve();
      };
    });
    waiters++;

    return prev.then(() => {
      // Set auto-release timeout to prevent deadlocks from unhandled rejections
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          if (!released) {
            console.log(`⚠️ Mutex auto-released after ${timeoutMs}ms timeout (potential deadlock)`);
            release();
          }
        }, timeoutMs);
      }
      return release;
    });
  };

  /**
   * Check if mutex is currently locked
   * @returns {boolean}
   */
  const isLocked = () => waiters > 0;

  return { acquire, isLocked };
};

module.exports = { createMutex };
