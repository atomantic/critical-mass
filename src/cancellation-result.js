// @ts-check

/**
 * Interpret body-TP cancellation without changing the legacy result contract.
 * Cancellation takes precedence; a cancelled order can still have sold asset.
 * @param {{cancelled?: unknown, filled?: unknown, filledSize?: number|string}} result
 * @returns {'cancelled'|'cancelled_with_execution'|'filled'|'unresolved'}
 */
const classifyBodyTpCancellation = (result) => {
  if (result.cancelled) {
    return result.filledSize > 0 ? 'cancelled_with_execution' : 'cancelled';
  }
  return result.filled ? 'filled' : 'unresolved';
};

module.exports = { classifyBodyTpCancellation };
