/**
 * Fallback per-side fee rate (10 bps) used when `config.feeRate` is not set.
 *
 * Shared by the regime engine (TP fee floor, stranded-dust budget, dashboard
 * estimates) and the dry-run executor, so every fee estimate starts from the
 * same number. Sites differ on whether an explicit 0 is honored; that rule is
 * kept per call site (`||` in the engine, `??` in the dry-run executor).
 */
export const DEFAULT_FEE_RATE_PER_SIDE = 0.001;
