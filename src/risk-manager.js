// @ts-check
/**
 * Risk Manager
 *
 * Enforces position limits and tracks risk metrics:
 * - BTC exposure caps
 * - USDC deployment caps
 * - Maximum drawdown tracking (fund-level equity — see computeFundEquity)
 * - Ladder step limits
 *
 * All checks return structured results for consistent handling.
 */

const { roundAsset, roundUSDC } = require('./volatility-utils');
const { getBaseCurrency } = require('./config-utils');
const { createContextLogger } = require('./logger');

/**
 * @typedef {import('./types').RegimeStrategyConfig} RegimeStrategyConfig
 * @typedef {import('./types').RegimePositionState} RegimePositionState
 */

/**
 * Create risk manager instance
 * @param {string} exchange - Exchange name
 * @param {RegimeStrategyConfig} config - Configuration
 * @param {string} [productId] - Product ID (e.g. BTC-USDC, CRO_USD)
 * @returns {Object} Risk manager instance
 */
const createRiskManager = (exchange, config, productId) => {
  const logger = createContextLogger({ exchange, pair: productId });
  const assetLabel = productId ? getBaseCurrency(productId).toLowerCase() : 'asset';
  let peakEquity = null; // null = uninitialized, will be set to first observed equity
  let maxDrawdownSeen = 0;
  let isDrawdownPaused = false;
  let drawdownPausedAt = null; // Timestamp when drawdown pause started
  let lastCapitalBase = null; // capitalBase seen on the previous updateDrawdown (peak re-basing)
  let lastDrawdownPercent = 0; // drawdown on the most recent observation (dashboard)
  let isEquityDepleted = false; // true while paused because fund equity is <= 0 (fail-closed; no auto-reset — see updateDrawdown)
  let cycleBuysLimitReachedAt = null; // Timestamp when ladder limit was first reached

  /**
   * Check if entry would exceed asset exposure cap
   * @param {number} currentAsset - Current asset position
   * @param {number} entryAsset - Asset amount to add
   * @returns {{allowed: boolean, reason: string|null, currentAsset: number, maxAsset: number}}
   */
  const checkAssetCap = (currentAsset, entryAsset) => {
    // 0 means uncapped — skip the check
    if (!config.maxAssetExposure) {
      return { allowed: true, reason: null, currentAsset, maxAsset: 0 };
    }

    const newTotal = currentAsset + entryAsset;

    if (newTotal > config.maxAssetExposure) {
      return {
        allowed: false,
        reason: `asset_cap_exceeded:${roundAsset(newTotal)}>${config.maxAssetExposure}`,
        currentAsset,
        maxAsset: config.maxAssetExposure,
      };
    }

    return {
      allowed: true,
      reason: null,
      currentAsset,
      maxAsset: config.maxAssetExposure,
    };
  };

  /**
   * Check if entry would exceed USDC deployment cap
   * @param {number} currentDeployed - Current USDC deployed
   * @param {number} entryUsdc - USDC amount to add
   * @returns {{allowed: boolean, reason: string|null, currentUsdc: number, maxUsdc: number}}
   */
  const checkUSDCCap = (currentDeployed, entryUsdc) => {
    const newTotal = currentDeployed + entryUsdc;

    if (newTotal > config.maxUsdcDeployed) {
      return {
        allowed: false,
        reason: `usdc_cap_exceeded:${roundUSDC(newTotal)}>${config.maxUsdcDeployed}`,
        currentUsdc: currentDeployed,
        maxUsdc: config.maxUsdcDeployed,
      };
    }

    return {
      allowed: true,
      reason: null,
      currentUsdc: currentDeployed,
      maxUsdc: config.maxUsdcDeployed,
    };
  };

  /**
   * Check if cycle buys limit is reached
   * @param {number} currentStep - Current cycle buy count
   * @returns {{allowed: boolean, reason: string|null, currentStep: number, maxSteps: number, shouldReset: boolean}}
   */
  const checkCycleBuysLimit = (currentStep) => {
    if (currentStep >= config.maxCycleBuys) {
      // Track when limit was first reached
      if (!cycleBuysLimitReachedAt) {
        cycleBuysLimitReachedAt = Date.now();
        logger.warn(`⚠️ [${exchange}] Cycle buys limit reached: ${currentStep}/${config.maxCycleBuys}, waiting for TP or auto-reset`, {
          currentStep, maxSteps: config.maxCycleBuys,
        });
      }

      // Check for time-based auto-reset
      if (cycleBuysLimitReachedAt && config.cycleResetHours > 0) {
        const atLimitMs = Date.now() - cycleBuysLimitReachedAt;
        const atLimitHours = atLimitMs / (1000 * 60 * 60);
        if (atLimitHours >= config.cycleResetHours) {
          logger.info(`🔄 [${exchange}] Auto-resetting cycle buys after ${config.cycleResetHours}h at limit`, {
            currentStep, maxSteps: config.maxCycleBuys, resetHours: config.cycleResetHours,
          });
          cycleBuysLimitReachedAt = null;
          return {
            allowed: true,
            reason: null,
            currentStep,
            maxSteps: config.maxCycleBuys,
            shouldReset: true, // Signal to regime engine to reset cycleBuys
          };
        }
      }

      return {
        allowed: false,
        reason: `cycle_buys_limit_reached:${currentStep}>=${config.maxCycleBuys}`,
        currentStep,
        maxSteps: config.maxCycleBuys,
        shouldReset: false,
      };
    }

    // Not at limit, clear the timestamp
    cycleBuysLimitReachedAt = null;

    return {
      allowed: true,
      reason: null,
      currentStep,
      maxSteps: config.maxCycleBuys,
      shouldReset: false,
    };
  };

  /**
   * Update equity and check drawdown.
   *
   * `currentEquity` MUST be fund-level mark-to-market equity as produced by
   * `computeFundEquity` (see the equity-definition note there) — the same unit
   * `forceResume` receives, so a manual resume re-bases the peak in the unit
   * this function compares against.
   *
   * `capitalBase` is the principal component of that equity. When it changes
   * between observations (operator deposit / withdrawal / budget edit) the
   * peak is shifted by the same delta, so moving capital in or out never reads
   * as a gain or a drawdown.
   *
   * @param {number} currentEquity - Fund equity in quote currency
   * @param {number} [capitalBase] - Principal included in `currentEquity`
   * @returns {{drawdownPercent: number, isPaused: boolean, peakEquity: number, drawdownPausedAt: number|null}}
   */
  const updateDrawdown = (currentEquity, capitalBase) => {
    // Depleted equity against a known positive peak — or, on a first sample
    // with no peak yet, against a funded capital base — is a 100% drawdown: it
    // must pause (fail closed), not fall through to the "nothing to track" skip
    // below. The drawdownResetHours auto-reset deliberately does not apply
    // here: it re-bases the peak to current equity, and a non-positive peak is
    // meaningless, so a depleted fund stays paused until equity recovers or
    // the operator intervenes.
    if (Number.isFinite(currentEquity) && currentEquity <= 0 && (peakEquity === null || peakEquity <= 0)
        && Number.isFinite(capitalBase) && capitalBase > 0) {
      peakEquity = capitalBase;
      lastCapitalBase = capitalBase;
    }
    if (Number.isFinite(currentEquity) && currentEquity <= 0 && peakEquity !== null && peakEquity > 0) {
      lastDrawdownPercent = 100;
      maxDrawdownSeen = 100;
      isEquityDepleted = true;
      if (!isDrawdownPaused) {
        isDrawdownPaused = true;
        drawdownPausedAt = Date.now();
        logger.warn(`⚠️ [${exchange}] Drawdown limit reached: fund equity depleted (${currentEquity.toFixed(2)}) from peak ${peakEquity.toFixed(2)}`, {
          peakEquity, currentEquity, maxDrawdownPercent: config.maxDrawdownPercent,
        });
      }
      return { drawdownPercent: 100, isPaused: true, peakEquity, drawdownPausedAt };
    }

    // No meaningful equity (no price yet / unfunded fund) — nothing to track.
    if (!Number.isFinite(currentEquity) || currentEquity <= 0) {
      return {
        drawdownPercent: 0,
        isPaused: isDrawdownPaused,
        peakEquity: peakEquity || 0,
        drawdownPausedAt,
      };
    }

    // Equity is meaningfully positive again — no longer in the depleted,
    // fail-closed state (whether or not the pause itself has cleared yet).
    isEquityDepleted = false;

    // Re-base the peak on a capital change so deposits/withdrawals are neutral.
    if (Number.isFinite(capitalBase)) {
      if (peakEquity !== null && lastCapitalBase !== null && capitalBase !== lastCapitalBase) {
        const delta = capitalBase - lastCapitalBase;
        peakEquity += delta;
        logger.info(`💵 [${exchange}] Drawdown peak re-based by ${delta >= 0 ? '+' : ''}${delta.toFixed(2)} for capital change`, {
          capitalBase, lastCapitalBase, peakEquity,
        });
      }
      lastCapitalBase = capitalBase;
    }

    // Initialize (or recover from a non-positive re-based) peak on first observation
    if (peakEquity === null || peakEquity <= 0) {
      peakEquity = currentEquity;
      logger.info(`📊 [${exchange}] Initialized peak equity to $${peakEquity.toFixed(2)}`, { peakEquity });
    }

    // Check for time-based reset if paused and configured
    if (isDrawdownPaused && drawdownPausedAt && config.drawdownResetHours > 0) {
      const pausedMs = Date.now() - drawdownPausedAt;
      const pausedHours = pausedMs / (1000 * 60 * 60);
      if (pausedHours >= config.drawdownResetHours) {
        logger.info(`🔄 [${exchange}] Auto-resetting peak after ${config.drawdownResetHours}h of drawdown pause`, {
          currentEquity, resetHours: config.drawdownResetHours,
        });
        peakEquity = currentEquity; // Reset peak to current equity
        isDrawdownPaused = false;
        drawdownPausedAt = null;
      }
    }

    // Update peak
    if (currentEquity > peakEquity) {
      peakEquity = currentEquity;
    }

    // Calculate drawdown from peak
    const drawdownPercent = ((peakEquity - currentEquity) / peakEquity) * 100;
    lastDrawdownPercent = drawdownPercent;

    // Track max drawdown
    if (drawdownPercent > maxDrawdownSeen) {
      maxDrawdownSeen = drawdownPercent;
    }

    // Check if we should pause
    if (drawdownPercent >= config.maxDrawdownPercent) {
      if (!isDrawdownPaused) {
        isDrawdownPaused = true;
        drawdownPausedAt = Date.now();
        logger.warn(`⚠️ [${exchange}] Drawdown limit reached: ${drawdownPercent.toFixed(1)}% >= ${config.maxDrawdownPercent}%`, {
          drawdownPercent, maxDrawdownPercent: config.maxDrawdownPercent, peakEquity, currentEquity,
        });
      }
    } else if (isDrawdownPaused && drawdownPercent < config.maxDrawdownPercent * 0.5) {
      // Resume if drawdown recovers to half of limit
      isDrawdownPaused = false;
      drawdownPausedAt = null;
      logger.info(`✅ [${exchange}] Drawdown recovered: ${drawdownPercent.toFixed(1)}%`, {
        drawdownPercent, maxDrawdownPercent: config.maxDrawdownPercent, peakEquity, currentEquity,
      });
    }

    return {
      drawdownPercent,
      isPaused: isDrawdownPaused,
      peakEquity,
      drawdownPausedAt,
    };
  };

  /**
   * Check all caps and return combined result
   * @param {RegimePositionState} position - Current position state
   * @param {number} entryAsset - BTC to add (optional)
   * @param {number} entryUsdc - USDC to add (optional)
   * @returns {{allowed: boolean, reasons: string[], shouldResetCycleBuys: boolean}}
   */
  const checkAllCaps = (position, entryAsset = 0, entryUsdc = 0) => {
    const reasons = [];
    let shouldResetCycleBuys = false;

    const btcCheck = checkAssetCap(position.totalAsset, entryAsset);
    if (!btcCheck.allowed) {
      reasons.push(btcCheck.reason);
    }

    const usdcCheck = checkUSDCCap(position.totalCostBasis, entryUsdc);
    if (!usdcCheck.allowed) {
      reasons.push(usdcCheck.reason);
    }

    const ladderCheck = checkCycleBuysLimit(position.cycleBuys);
    if (!ladderCheck.allowed) {
      reasons.push(ladderCheck.reason);
    }
    if (ladderCheck.shouldReset) {
      shouldResetCycleBuys = true;
    }

    if (isDrawdownPaused) {
      reasons.push(`drawdown_paused:${maxDrawdownSeen.toFixed(1)}%`);
    }

    return {
      allowed: reasons.length === 0,
      reasons,
      shouldResetCycleBuys,
    };
  };

  /**
   * Check if entry is allowed (combined caps check)
   * @param {RegimePositionState} position - Current position
   * @param {number} entryAsset - BTC to add
   * @param {number} entryUsdc - USDC to add
   * @returns {{allowed: boolean, reason: string|null, shouldResetCycleBuys: boolean}}
   */
  const canPlaceEntry = (position, entryAsset, entryUsdc) => {
    const result = checkAllCaps(position, entryAsset, entryUsdc);

    if (!result.allowed) {
      return {
        allowed: false,
        reason: result.reasons.join(', '),
        shouldResetCycleBuys: result.shouldResetCycleBuys,
      };
    }

    return { allowed: true, reason: null, shouldResetCycleBuys: result.shouldResetCycleBuys };
  };

  /**
   * Calculate remaining capacity
   * @param {RegimePositionState} position - Current position
   * @param {number} currentPrice - Current BTC price
   * @returns {{remainingAsset: number, remainingUsdc: number, remainingSteps: number}}
   */
  const getRemainingCapacity = (position, currentPrice) => {
    const remainingAsset = config.maxAssetExposure ? roundAsset(config.maxAssetExposure - position.totalAsset) : Infinity;
    const remainingUsdc = roundUSDC(config.maxUsdcDeployed - position.totalCostBasis);
    const remainingSteps = config.maxCycleBuys - position.cycleBuys;

    return {
      remainingAsset: Math.max(0, remainingAsset),
      remainingUsdc: Math.max(0, remainingUsdc),
      remainingSteps: Math.max(0, remainingSteps),
    };
  };

  /**
   * Get utilization percentages
   * @param {RegimePositionState} position - Current position
   * @returns {{btcUtilization: number, usdcUtilization: number, cycleBuysUtilization: number}}
   */
  const getUtilization = (position) => {
    return {
      btcUtilization: config.maxAssetExposure ? (position.totalAsset / config.maxAssetExposure) * 100 : 0,
      usdcUtilization: (position.totalCostBasis / config.maxUsdcDeployed) * 100,
      cycleBuysUtilization: (position.cycleBuys / config.maxCycleBuys) * 100,
    };
  };

  /**
   * Get risk summary for logging
   * @param {RegimePositionState} position - Current position
   * @returns {string}
   */
  const getSummary = (position) => {
    const util = getUtilization(position);
    const parts = [
      config.maxAssetExposure
        ? `${assetLabel}=${position.totalAsset.toFixed(4)}/${config.maxAssetExposure}(${util.btcUtilization.toFixed(0)}%)`
        : `${assetLabel}=${position.totalAsset.toFixed(4)}`,
      `usdc=$${position.totalCostBasis.toFixed(0)}/${config.maxUsdcDeployed}(${util.usdcUtilization.toFixed(0)}%)`,
      `buys=${position.cycleBuys}/${config.maxCycleBuys}`,
    ];

    if (maxDrawdownSeen > 0) {
      parts.push(`dd=${maxDrawdownSeen.toFixed(1)}%`);
    }

    if (isDrawdownPaused) {
      if (drawdownPausedAt) {
        const pausedHours = ((Date.now() - drawdownPausedAt) / (1000 * 60 * 60)).toFixed(1);
        parts.push(`PAUSED(${pausedHours}h)`);
      } else {
        parts.push('PAUSED');
      }
    }

    return parts.join(' ');
  };

  /**
   * Cycle-boundary hook (called from the engine's resetCycle).
   *
   * Intentionally does NOT reset the drawdown peak. Fund equity
   * (`computeFundEquity`) is continuous across a body TP / cycle reset — the
   * sold asset reappears as realized quote P&L and holdback reserves — so the
   * peak stays meaningful across cycles. Resetting it here would erase the
   * drawdown baseline every time a TP closed a cycle, which is exactly when a
   * crash with a still-open ladder is most likely to be under way. The only
   * peak resets are the drawdownResetHours auto-reset and the manual
   * forceResume. (Under the old market-value equity the reset was required
   * because equity collapsed to ~0 after a TP.)
   */
  const resetCycleTracking = () => {};

  /**
   * Get current risk state
   * @returns {{peakEquity: number, maxDrawdownSeen: number, isDrawdownPaused: boolean, drawdownPausedAt: number|null, drawdownPausedHours: number|null, equityDepleted: boolean}}
   */
  const getState = () => {
    let drawdownPausedHours = null;
    if (isDrawdownPaused && drawdownPausedAt) {
      drawdownPausedHours = (Date.now() - drawdownPausedAt) / (1000 * 60 * 60);
    }
    return {
      peakEquity,
      maxDrawdownSeen,
      currentDrawdownPercent: lastDrawdownPercent,
      isDrawdownPaused,
      drawdownPausedAt,
      drawdownPausedHours,
      drawdownResetHours: config.drawdownResetHours,
      // True while the pause is the fail-closed depleted-equity case (updateDrawdown),
      // which the drawdownResetHours auto-reset deliberately never clears — the
      // dashboard uses this to explain why "Resume" needs a manual operator
      // decision instead of just waiting out the reset window.
      equityDepleted: isEquityDepleted,
    };
  };

  /**
   * Snapshot of the drawdown tracker for persistence in positionState, so a
   * restart neither clears an active pause nor forgets the peak.
   * @returns {{peakEquity: number|null, maxDrawdownSeen: number, isDrawdownPaused: boolean, drawdownPausedAt: number|null, capitalBase: number|null}}
   */
  const getPersistedState = () => ({
    peakEquity,
    maxDrawdownSeen,
    isDrawdownPaused,
    drawdownPausedAt,
    capitalBase: lastCapitalBase,
  });

  /**
   * Restore a snapshot written by getPersistedState. Invalid / missing fields
   * are ignored (the tracker then re-initializes from the next observation).
   * @param {Object|null|undefined} saved
   */
  const restoreState = (saved) => {
    if (!saved || typeof saved !== 'object') return;
    const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
    const savedPeak = num(saved.peakEquity);
    if (savedPeak !== null && savedPeak > 0) peakEquity = savedPeak;
    const savedMax = num(saved.maxDrawdownSeen);
    if (savedMax !== null && savedMax > maxDrawdownSeen) maxDrawdownSeen = savedMax;
    const savedCapital = num(saved.capitalBase);
    if (savedCapital !== null) lastCapitalBase = savedCapital;
    if (saved.isDrawdownPaused === true) {
      isDrawdownPaused = true;
      drawdownPausedAt = num(saved.drawdownPausedAt) ?? Date.now();
    }
  };

  /**
   * Force resume from drawdown pause (manual override)
   * @param {number} [currentEquity] - Current fund equity (computeFundEquity unit) to set as the new peak (optional)
   * @param {number} [capitalBase] - Capital base included in `currentEquity`; recorded so the next
   *   updateDrawdown does not re-apply a capital change the new peak already contains
   */
  const forceResume = (currentEquity, capitalBase) => {
    if (isDrawdownPaused) {
      isDrawdownPaused = false;
      drawdownPausedAt = null;
      isEquityDepleted = false;
      if (Number.isFinite(currentEquity) && currentEquity > 0) {
        peakEquity = currentEquity; // Reset peak to current equity
        lastDrawdownPercent = 0;
        if (Number.isFinite(capitalBase)) lastCapitalBase = capitalBase;
      }
      logger.info(`▶️ [${exchange}] Manually resumed from drawdown pause, peak reset to ${(peakEquity ?? 0).toFixed(2)}`, {
        peakEquity, resumeType: 'manual',
      });
    }
  };

  /**
   * Fully reset the drawdown tracker — dry-run reset only (regime-engine's
   * resetDryRun). Clears the peak, pause, accumulated max-seen and capital-base
   * baseline so a fresh dry run doesn't inherit whatever peak/pause the prior
   * run left behind; the next updateDrawdown re-initializes from its first
   * observation exactly as a brand-new risk manager would.
   */
  const resetDrawdown = () => {
    peakEquity = null;
    maxDrawdownSeen = 0;
    isDrawdownPaused = false;
    drawdownPausedAt = null;
    lastCapitalBase = null;
    lastDrawdownPercent = 0;
    isEquityDepleted = false;
  };

  return {
    checkAssetCap,
    checkUSDCCap,
    checkCycleBuysLimit,
    updateDrawdown,
    checkAllCaps,
    canPlaceEntry,
    getRemainingCapacity,
    getUtilization,
    getSummary,
    resetCycleTracking,
    getState,
    getPersistedState,
    restoreState,
    forceResume,
    resetDrawdown,
  };
};

/**
 * Principal component of drawdown equity, in quote currency.
 *
 * Explicit deposits win — the engine-tracked position-state deposit first
 * (updateConfig keeps it current for direct depositedCapital edits AND for
 * maxUsdcDeployed add/withdraw deltas, which never touch config.depositedCapital),
 * then config, then the legacy originalCapital alias; otherwise the
 * maxUsdcDeployed budget. This
 * deliberately does NOT use the APY calculator's auto-derived fallback
 * (maxUsdcDeployed − realizedPnL): that fallback moves with every realized
 * sell, which would cancel realized profit out of equity and make each TP
 * read as a drawdown.
 *
 * @param {Object} position - Position state
 * @param {Object} config - Regime config
 * @returns {number}
 */
const resolveDrawdownCapitalBase = (position, config) => {
  if (position?.depositedCapital > 0) return position.depositedCapital;
  if (config?.depositedCapital > 0) return config.depositedCapital;
  if (position?.originalCapital > 0) return position.originalCapital;
  return config?.maxUsdcDeployed > 0 ? config.maxUsdcDeployed : 0;
};

/**
 * Fund-level mark-to-market equity used by the drawdown guard.
 *
 * EQUITY DEFINITION (issue #693):
 *
 *   equity = capitalBase                      principal (resolveDrawdownCapitalBase)
 *          − totalCostBasis                   quote currently tied up in open bodies
 *          + realizedPnL                      realized quote P&L (cycle-pair model)
 *          + (totalAsset + realizedAssetPnL) × price
 *                                             open-body asset + zero-cost holdback
 *                                             reserves, marked to market
 *
 * i.e. quote capital + all held asset at market — the Total P&L model from
 * CLAUDE.md with the principal added so the percentage is a fund-level
 * drawdown rather than a P&L swing on a small denominator.
 *
 * Why not market value alone (totalAsset × price, the original definition):
 * a body TP sells asset for quote, so market value falls on every profitable
 * TP and a routine take-profit would read as a drawdown (and, once the
 * position is flat, equity is 0 and nothing is tracked at all).
 *
 * Under this definition a TP fill is non-negative: the body's cost leaves
 * totalCostBasis, its sold qty leaves totalAsset, the proceeds minus prorated
 * cost enter realizedPnL and the holdback enters realizedAssetPnL. Net change
 * is +costBasis × holdback/assetQty (the holdback's cost, which the P&L model
 * books as zero-cost reserve) plus (fill price − mark) × sold qty. A buy fill
 * is ~neutral (quote → asset at the fill price). Only price moves on held
 * asset (bodies + reserves) and realized losses move equity down.
 *
 * The +holdback-cost step is deliberate, not an accounting leak: CLAUDE.md's
 * P&L model books reserves as zero-cost (their cost went to the paired sell),
 * and this equity stays consistent with the dashboard's Total P&L. The step is
 * permanent — carried by both equity and the peak from then on — so the dollar
 * distance from the peak is unaffected; only the percentage denominator grows
 * by the accumulated holdback cost, a small fraction of fund capital.
 *
 * @param {Object} position - Position state (totalAsset, totalCostBasis, realizedPnL, realizedAssetPnL, depositedCapital)
 * @param {Object} config - Regime config
 * @param {number} currentPrice - Mark price
 * @returns {{equity: number, capitalBase: number}}
 */
const computeFundEquity = (position, config, currentPrice) => {
  const capitalBase = resolveDrawdownCapitalBase(position, config);
  const price = Number.isFinite(currentPrice) && currentPrice > 0 ? currentPrice : 0;
  const heldAsset = (position?.totalAsset || 0) + (position?.realizedAssetPnL || 0);
  const equity = capitalBase
    - (position?.totalCostBasis || 0)
    + (position?.realizedPnL || 0)
    + heldAsset * price;
  return { equity, capitalBase };
};

module.exports = {
  createRiskManager,
  computeFundEquity,
  resolveDrawdownCapitalBase,
};
