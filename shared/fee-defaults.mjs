/**
 * Fallback per-side fee rate (10 bps) used when `config.feeRate` is not set.
 *
 * Shared by the regime engine (TP fee floor, stranded-dust budget, dashboard
 * estimates) and the dry-run executor, so every fee estimate starts from the
 * same number. Every site uses `config.feeRate ?? DEFAULT_FEE_RATE_PER_SIDE`,
 * so an explicit 0 (zero-fee) is honored consistently.
 */
export const DEFAULT_FEE_RATE_PER_SIDE = 0.001;
