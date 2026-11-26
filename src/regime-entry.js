'use strict';

/**
 * Entry evaluation for one fund: the mode-aware trigger
 * (`evaluateEntryTrigger`), the reactive and ladder entry paths it delegates
 * to, and `executeEntry` with the helpers only it uses (the cap_reached
 * announcer and the insufficient-funds cooldown). Extracted verbatim from
 * regime-engine (issue #1980); the engine wires `createEntryEvaluator({...})`
 * and keeps the same `_test` entries.
 *
 * The engine still owns when an evaluation runs: the ticker handler calls
 * `evaluateEntryTrigger` under its backup fence and tracked write. Every path
 * takes the same locks it took inline, through the engine's own `engineLocks`:
 * the entry lock for a reactive entry, the entry lock then the ladder lock
 * (without waiting) for a ladder. Admission is captured through the engine's
 * own `captureEntryAdmission` / `captureReactiveEntryAdmission`, and an
 * unresolved placement intent still holds every new entry
 * (`blockingPlacementIntents`). Sizing, the risk-cap check, the balance
 * preflight and the executor call run in the same order.
 *
 * `positionState` is passed directly: the engine keeps one object identity
 * (replacePositionState, #1594). `getAdapter`, `getOrderExecutor`,
 * `getPriceIncrement`, `getCycleResetGeneration` and `getFlashCancelSweep`
 * are accessors because the engine reassigns those bindings (tests swapping
 * the exchange deps, product details, each cycle reset, each flash-cancel
 * sweep); `getMarketState` reads the engine's `let` binding the same way the
 * operator actions do. The log / alert latches
 * (`loggedEntryBlockKinds`, `budgetExhaustedWarningLogged`, `announcedCaps`,
 * `lowBalancePauseLogged`) stay in the engine, which clears them on a cycle
 * reset and persists `announcedCaps` with the episode state; they are read and
 * replaced here through `get*` / `set*` pairs. The insufficient-funds cooldown
 * deadline is used by nothing else, so it lives here.
 */

const { getQuoteCurrency } = require('./config-utils');
const { LIFECYCLE } = require('./regime-state-store');
const { tradeEvents } = require('./trade-events');
const { fmtCurrency: fmtPrice, ENTRY_NOT_ADMITTED } = require('./shared-utils');
const { computeAdaptiveStaleMs, roundUSDC } = require('./volatility-utils');
const { resolveEntryBudget, isInsufficientFundsMessage, sizeEntry, entryOffsetBps } = require('./regime-pure-helpers');

/**
 * Risk-manager block-reason prefixes that are cap conditions, mapped to the
 * label a cap_reached notification shows. Drawdown pauses are not caps.
 */
const CAP_ALERT_LABELS = {
  asset_cap_exceeded: 'Asset',
  usdc_cap_exceeded: 'USDC',
  cycle_buys_limit_reached: 'Cycle buys',
};

/**
 * @param {Object} deps
 * @returns {{evaluateEntryTrigger: Function, evaluateLadderEntry: Function}}
 */
const createEntryEvaluator = ({
  exchange, productId, isDryRun, config, exchangeConfig, logger, fundEventData,
  positionState, engineLocks,
  healthMonitor, tailEvents, regimeDetector, macroRegime, positionSizer, riskManager, ladderCalculator,
  getAdapter, getOrderExecutor, getMarketState, getPriceIncrement, getCycleResetGeneration, getFlashCancelSweep,
  // Log / alert latches owned by the engine (cleared on a cycle reset)
  getLoggedEntryBlockKinds, setLoggedEntryBlockKinds,
  getBudgetExhaustedWarningLogged, setBudgetExhaustedWarningLogged,
  getAnnouncedCaps, setAnnouncedCaps,
  getLowBalancePauseLogged, setLowBalancePauseLogged,
  lookupOrNull, blockingPlacementIntents, captureEntryAdmission, captureReactiveEntryAdmission,
  // Ladder helpers shared with the operator's ladder rebuild
  getAllocatedCapital, buildLadderFromMarket, abandonLadderPlacedAcrossReset,
  // State persistence (regime-state-persistence)
  saveLiveState,
}) => {
  let insufficientFundsCooldownUntil = 0; // Cooldown after InsufficientFunds to prevent rapid retry spam

  /**
   * Evaluate volatility-based entry trigger (mode-aware)
   * Delegates to either reactive or ladder entry evaluation based on config
   */
  const evaluateEntryTrigger = async () => {
    // Prevent concurrent entry evaluations (race condition from rapid ticker updates)
    if (engineLocks.isEntryInProgress()) return;

    // A placement whose outcome we could not establish (ambiguous response we
    // could not reconcile, or a crash inside the dispatch window) leaves a
    // durable intent on disk. While one is outstanding, an order we cannot see
    // may be resting live against this fund's capital, so no new entry may be
    // submitted — and because the record is on disk, the guard survives a
    // restart. Monitoring, fill processing, TP repair, cancels and lifecycle
    // operations all keep running; only NEW entries are held.
    if (blockingPlacementIntents().length > 0) return;

    // Determine effective entry mode
    let effectiveMode = config.entryMode || 'reactive';

    // Auto-switch to ladder mode if enabled and volatility is expanded
    if (config.ladderAutoSwitch && getMarketState().volBaseline > 0) {
      const volExpansion = getMarketState().realizedVol / getMarketState().volBaseline;
      const volThreshold = config.ladderAutoSwitchVolMult || 2.0;
      if (volExpansion >= volThreshold) {
        if (effectiveMode !== 'ladder') {
          logger.info(`🔀 [${exchange}] Auto-switch: reactive→ladder (volExpansion=${volExpansion.toFixed(2)}x >= ${volThreshold}x threshold, rVol=${getMarketState().realizedVol.toFixed(4)} baseline=${getMarketState().volBaseline.toFixed(4)})`);
        }
        effectiveMode = 'ladder';
      }
    }

    // Don't switch modes mid-cycle if we have an active position
    // (prevents inconsistent behavior during a trade cycle)
    if (positionState.totalAsset > 0) {
      // If ladder is active, stay in ladder mode
      if (positionState.ladderActive) {
        effectiveMode = 'ladder';
      } else {
        // Otherwise stay in reactive mode
        effectiveMode = 'reactive';
      }
    }

    if (effectiveMode === 'ladder') {
      await evaluateLadderEntry();
    } else {
      await evaluateReactiveEntry();
    }
  };

  /**
   * Evaluate reactive entry trigger (original volatility-based logic)
   */
  const evaluateReactiveEntry = async () => {
    const now = Date.now();

    // Fund lifecycle guard: when draining/closed, never place new entries
    if (positionState.lifecycle && positionState.lifecycle !== LIFECYCLE.ACTIVE) return;
    // A flash-cancel sweep is pulling reactive bids (#1028): placing one now
    // would race it. The next tick after the sweep settles re-evaluates.
    if (getFlashCancelSweep()) return;
    const isAdmitted = captureReactiveEntryAdmission();

    // Don't place a new reactive entry if there's already a pending entry OR a
    // resting ladder rung on the exchange. ladder_entry orders were previously
    // invisible to this guard, so after ladderAutoSwitch reverted to reactive
    // mode (vol dropped before any rung filled, totalAsset still 0) reactive
    // entries stacked on top of the full-budget ladder — over-committing
    // beyond maxUsdcDeployed (issue #107 M5).
    const pending = getOrderExecutor().getPendingCounts();
    if (pending.entries > 0 || pending.ladderEntries > 0) return;

    // Skip if in insufficient funds cooldown (prevents rapid retry spam on 406 errors)
    if (now < insufficientFundsCooldownUntil) return;

    const timeSinceLastEntry = now - positionState.lastEntryTime;

    // Minimum interval guard
    if (timeSinceLastEntry < config.minIntervalMs) return;

    // Check health
    const healthCheck = healthMonitor.canPlaceEntry();
    if (!healthCheck.allowed) return;

    // Check tail events
    const tailCheck = tailEvents.canPlaceEntry(positionState.cycleBuys);
    if (!tailCheck.allowed) return;

    // Check regime allows entries
    if (!regimeDetector.allowsEntries()) return;

    // Calculate price move from anchor
    const priceMove = positionState.anchorPrice > 0
      ? Math.abs(getMarketState().lastPrice - positionState.anchorPrice)
      : Infinity;

    const volTrigger = getMarketState().atr1m > 0 && priceMove >= config.kFactor * getMarketState().atr1m;
    const timeTrigger = timeSinceLastEntry >= config.maxIntervalMs;

    if (volTrigger || timeTrigger) {
      await engineLocks.withEntryLock(() =>
        executeEntry(volTrigger ? 'volatility' : 'timer', isAdmitted)
      );
    }
  };

  /**
   * Evaluate ladder entry - pre-position liquidity ladder
   */
  const evaluateLadderEntry = async () => {
    // Fund lifecycle guard: when draining/closed, never place new entries
    if (positionState.lifecycle && positionState.lifecycle !== LIFECYCLE.ACTIVE) return;
    const isFundAdmitted = captureEntryAdmission();
    const isAdmitted = () => isFundAdmitted() && allowsMacroEntries();
    if (!allowsMacroEntries()) return;

    // Skip if in insufficient funds cooldown
    if (Date.now() < insufficientFundsCooldownUntil) return;

    // Skip if ladder already active with pending orders
    if (positionState.ladderActive && positionState.pendingLadderOrders.length > 0) {
      return;
    }

    // Check health
    const healthCheck = healthMonitor.canPlaceEntry();
    if (!healthCheck.allowed) return;

    // Skip tail events check — ladder IS the flash event strategy,
    // orders should stay in place regardless of spread/depth/flash conditions

    // Fund drawdown pause blocks NEW ladders too (the reactive path gets it via
    // canPlaceEntry). Already-resting rungs are left alone.
    if (riskManager.getState().isDrawdownPaused) return;

    // Check regime allows entries
    if (!regimeDetector.allowsEntries()) return;

    // Claim the entry lock BEFORE the first await. Ticker events fire many
    // times per second; the balance fetch below is an async gap, and the
    // evaluateEntryTrigger guard (`if (engineLocks.isEntryInProgress()) return`)
    // only blocks re-entry once this flag is set. Setting it after the await
    // (the old bug) let every tick that landed during the balance round-trip
    // place its own full-budget ladder — multi-x budget over-commitment, with
    // only the last ladder's orders tracked (issue #98). All early-returns from
    // here must clear it, so the rest of the function runs under withEntryLock.
    if (engineLocks.isEntryInProgress()) return;
    // A rebuild/cancel/cycle-reset sweep in flight owns the ladder (#766): it
    // may have cleared ladderActive mid-sweep, and placing here would stack a
    // second ladder on the one it is about to place. Skip — the next tick
    // re-evaluates — rather than queue: taken without waiting, so held for the
    // whole placement and a sweep requested meanwhile runs after it.
    await engineLocks.withEntryLock(() => engineLocks.withLadderLock(async () => {
      // Calculate remaining budget, capped at actual available balance
      let remainingBudget = config.maxUsdcDeployed - getAllocatedCapital();
      const quoteCurrency = getQuoteCurrency(productId);
      const quoteBalance = await lookupOrNull('getAccountBalance', quoteCurrency, getAdapter().getAccountBalance(quoteCurrency));
      if (!quoteBalance) {
        // Can't verify balance — skip ladder to avoid placing orders we can't fund
        return;
      }
      // A stop/close that landed during the balance await closes admission (#1009).
      if (!isAdmitted()) {
        logger.info(`🚦 [${exchange}] Ladder skipped during the balance preflight — ${ENTRY_NOT_ADMITTED}`);
        return;
      }
      const availableQuote = parseFloat(quoteBalance.available) || 0;
      if (availableQuote < remainingBudget) {
        remainingBudget = availableQuote;
      }

      // Quick sanity check - need at least 1 order worth of budget
      if (remainingBudget < config.baseSizeUsdc) {
        if (!getBudgetExhaustedWarningLogged()) {
          logger.info(`ℹ️ [${exchange}] Insufficient budget for ladder: $${remainingBudget.toFixed(2)} available (${quoteCurrency}=${availableQuote.toFixed(2)}) < $${config.baseSizeUsdc}`);
          setBudgetExhaustedWarningLogged(true);
        }
        return;
      }

      const placeLadder = async () => {
        // Build ladder first to determine actual level count (may be fewer than config due to min-size filtering)
        const ladder = buildLadderFromMarket(getMarketState(), remainingBudget, getPriceIncrement());

        if (ladder.levels.length === 0) {
          if (!getBudgetExhaustedWarningLogged()) {
            logger.info(`ℹ️ [${exchange}] Ladder build produced 0 levels for budget $${remainingBudget.toFixed(2)}`);
            setBudgetExhaustedWarningLogged(true);
          }
          return;
        }

        // Check order limit using actual built level count
        const pendingCounts = getOrderExecutor().getPendingCounts();
        const requiredSlots = ladder.levels.length + 1; // +1 for TP order

        if (pendingCounts.total + requiredSlots > config.maxOpenOrders) {
          logger.warn(`⚠️ [${exchange}] Insufficient order slots for ladder: need ${requiredSlots}, max=${config.maxOpenOrders}, current=${pendingCounts.total}`);
          return;
        }

        logger.info(`📊 [${exchange}] Building ladder: ${ladderCalculator.getSummary(ladder)}`);

        // Place ladder orders
        const generationAtPlace = getCycleResetGeneration();
        const result = await getOrderExecutor().placeLadderOrders(ladder.levels, { isAdmitted });
        if (await abandonLadderPlacedAcrossReset(generationAtPlace, 'Ladder placement')) return;
        // Admission closed before any rung went out: nothing to track. Rungs
        // that DID go out are recorded below like any ladder, so their fills
        // and cancels reconcile normally.
        if (result.notAdmitted && result.orders.length === 0) {
          logger.info(`🚦 [${exchange}] Ladder not placed — ${ENTRY_NOT_ADMITTED}`);
          return;
        }

        // Update position state
        positionState.ladderActive = true;
        positionState.ladderPlacedAt = Date.now();
        positionState.ladderLowerBound = ladder.lowerBound;
        positionState.pendingLadderOrders = result.orders;

        logger.info(`📊 [${exchange}] Ladder placed: ${result.orders.length} levels from ${fmtPrice(getMarketState().lastPrice)} to ${fmtPrice(ladder.lowerBound)}${result.failedCount > 0 ? ` (${result.failedCount} failed)` : ''}`);

        tradeEvents.emitTradeEvent('ladder_placed', exchange, `${result.orders.length} levels to ${fmtPrice(ladder.lowerBound)}`, {
          levels: result.orders.length,
          topPrice: getMarketState().lastPrice,
          bottomPrice: ladder.lowerBound,
          lowerBoundPct: ladder.lowerBoundPct,
          totalBudget: ladder.totalBudget,
          failedCount: result.failedCount,
        });

        // Persist state
        saveLiveState();
      };

      await placeLadder();
    }, { wait: false }));
  };

  /**
   * Publish cap_reached once per cap-block episode (issue #1030). The risk
   * manager re-evaluates every cap on each entry check, so `reason` (its
   * comma-joined block reasons, '' when allowed) is the complete set of caps
   * blocking right now: a newly present cap alerts, and a cap that cleared is
   * forgotten so hitting it again later alerts again.
   * @param {string} reason
   */
  const announceCapTransitions = (reason) => {
    const blocking = new Map();
    for (const part of reason.split(',')) {
      const match = part.trim().match(/^(\w+):(.+?)>=?(.+)$/);
      if (match && CAP_ALERT_LABELS[match[1]]) {
        blocking.set(match[1], { current: Number(match[2]), limit: Number(match[3]) });
      }
    }
    for (const [capKey, { current, limit }] of blocking) {
      if (!getAnnouncedCaps().has(capKey)) {
        tradeEvents.capReached(exchange, CAP_ALERT_LABELS[capKey], current, limit, fundEventData);
      }
    }
    setAnnouncedCaps(new Set(blocking.keys()));
  };

  /** Arm the insufficient-funds cooldown; returns its duration in ms. */
  const startInsufficientFundsCooldown = () => {
    const cooldownMs = config.insufficientFundsCooldownMs || 60000;
    insufficientFundsCooldownUntil = Date.now() + cooldownMs;
    return cooldownMs;
  };

  const logInsufficientFundsPause = () => {
    const cooldownMs = startInsufficientFundsCooldown();
    logger.info(`⏸️ [${exchange}] Insufficient funds — pausing entries for ${cooldownMs / 1000}s`);
  };

  const allowsMacroEntries = () => !macroRegime || macroRegime.getMultipliers().sizeMult > 0;

  /**
   * Execute entry
   * @param {string} triggerType - What triggered the entry
   * @param {() => boolean} isFundAdmitted - Entry admission captured when the evaluation began (#1009)
   */
  const executeEntry = async (triggerType, isFundAdmitted) => {
    const isAdmitted = () => isFundAdmitted() && allowsMacroEntries();
    const regime = regimeDetector.getMode();

    // Calculate size (apply macro multiplier to sizing)
    const sizing = positionSizer.calculateEntrySize({
      regime,
      cycleBuys: positionState.cycleBuys,
      totalCostBasis: positionState.totalCostBasis,
      currentPrice: getMarketState().bid,
      avgCostBasis: positionState.avgCostBasis,
    });

    // Apply macro regime size multiplier, then the minimum-size floor / last-order rule
    const macroMult = macroRegime ? macroRegime.getMultipliers() : { sizeMult: 1.0, tpMult: 1.0, offsetMult: 1.0 };
    if (macroMult.sizeMult === 0) return;
    const minSize = config.minOrderSizeUsdc || exchangeConfig.minOrderSize || 1;
    const remainingBudget = roundUSDC(Math.max(0, config.maxUsdcDeployed - positionState.totalCostBasis));
    // Auto-aggressiveness (Phase 3): depression-score multiplier damped by the capital governor
    const deployedRatio = config.maxUsdcDeployed > 0 ? positionState.totalCostBasis / config.maxUsdcDeployed : 1;
    const autoMult = macroRegime?.getAutoSizeMult ? macroRegime.getAutoSizeMult(deployedRatio) : { active: false, multiplier: 1 };
    const entryMult = { ...macroMult, sizeMult: macroMult.sizeMult * autoMult.multiplier };
    sizing.sizeUsdc = sizeEntry({ sizing, macroMult: entryMult, minSize, remainingBudget });
    // A boost must never push a buy past the remaining budget
    if (autoMult.active && remainingBudget >= minSize) sizing.sizeUsdc = Math.min(sizing.sizeUsdc, remainingBudget);

    // Check risk caps
    const assetQty = positionSizer.calculateBTCQuantity(sizing.sizeUsdc, getMarketState().bid);
    const riskCheck = riskManager.canPlaceEntry(positionState, assetQty, sizing.sizeUsdc);

    // Handle cycle buys auto-reset (time-based reset after being at max limit)
    if (riskCheck.shouldResetCycleBuys) {
      logger.info(`🔄 [${exchange}] Cycle buys auto-reset triggered, resetting buys ${positionState.cycleBuys} -> 0`);
      positionState.cycleBuys = 0;
    }

    announceCapTransitions(riskCheck.allowed ? '' : riskCheck.reason);

    if (!riskCheck.allowed) {
      // Log once per block episode: only when a new block kind appears, not on
      // every tick while the same caps/pauses persist (values like the drawdown
      // % drift tick to tick, so key on the kind, not the full reason).
      const kinds = new Set(riskCheck.reason.split(',').map((part) => part.trim().split(':')[0]));
      if ([...kinds].some((kind) => !getLoggedEntryBlockKinds().has(kind))) {
        logger.warn(`⚠️ [${exchange}] Entry blocked: ${riskCheck.reason}`);
      }
      setLoggedEntryBlockKinds(kinds);
      return;
    }
    setLoggedEntryBlockKinds(new Set());

    // Check for zero/budget-exhausted (with spam protection)
    if (sizing.sizeUsdc <= 0) {
      if (!getBudgetExhaustedWarningLogged()) {
        logger.info(`ℹ️ [${exchange}] Budget exhausted`);
        setBudgetExhaustedWarningLogged(true);
      }
      return;
    }

    // Real-balance preflight (see resolveEntryBudget): cap entries at the real
    // available quote balance so a maxUsdcDeployed cap above funded capital can't
    // make the engine hot-loop on unfundable orders. Mirror the ladder path.
    const quoteCurrency = getQuoteCurrency(productId);
    const quoteBalance = await lookupOrNull('getAccountBalance', quoteCurrency, getAdapter().getAccountBalance(quoteCurrency));
    const availableQuote = quoteBalance ? (quoteBalance.available || 0) : null;
    const budget = resolveEntryBudget(sizing.sizeUsdc, availableQuote, minSize);
    if (budget.action === 'skip') {
      // Balance unverifiable — skip this entry rather than risk an unfundable order.
      return;
    }
    if (budget.action === 'cooldown') {
      const cooldownMs = startInsufficientFundsCooldown();
      // Log once per low-balance episode, not on every cooldown re-trigger — the
      // pause re-fires each cycle while the wallet stays underfunded (#187). The
      // flag resets below once an entry can be funded again.
      if (!getLowBalancePauseLogged()) {
        logger.info(`⏸️ [${exchange}] Wallet ${quoteCurrency} balance $${(availableQuote || 0).toFixed(2)} below min order $${minSize} — pausing entries for ${cooldownMs / 1000}s`);
        setLowBalancePauseLogged(true);
      }
      return;
    }
    setLowBalancePauseLogged(false);
    sizing.sizeUsdc = budget.sizeUsdc;

    // A stop/close that landed during the balance await closes admission (#1009).
    if (!isAdmitted()) {
      logger.info(`🚦 [${exchange}] Entry skipped during the balance preflight — ${ENTRY_NOT_ADMITTED}`);
      return;
    }

    // Dynamic offset based on momentum direction, scaled by the macro offset multiplier
    const momentumDirection = getMarketState().momentum?.direction || 'neutral';
    const effectiveOffsetBps = entryOffsetBps(momentumDirection, config, macroMult);

    // Give the bid time proportional to how far below mid it rests: a deep
    // momentum-down bid on the fixed orderStaleMs timer gets cancelled long
    // before price can plausibly reach it (~8% fill at 18bps/120s), defeating
    // the catch-the-dip intent. Floor orderStaleMs, cap maxIntervalMs.
    const entryStaleMs = computeAdaptiveStaleMs(effectiveOffsetBps, getMarketState().atr1m, getMarketState().lastPrice, config);

    // Place entry with dynamic offset
    let result;
    try {
      result = await getOrderExecutor().placeEntryBid(sizing.sizeUsdc, getMarketState().bid, getMarketState().ask, 0, effectiveOffsetBps, entryStaleMs, { isAdmitted });
    } catch (err) {
      if (isInsufficientFundsMessage(err.message) || err.status === 406) {
        logInsufficientFundsPause();
        return;
      }
      throw err; // Re-throw other errors
    }

    // Coinbase returns insufficient-funds as {success:false, errorMessage:"INSUFFICIENT_FUND"}
    // rather than throwing — apply the same cooldown so we don't hot-loop on a drained wallet.
    if (result && result.success === false && isInsufficientFundsMessage(result.errorMessage)) {
      logInsufficientFundsPause();
      return;
    }

    if (result.notAdmitted) {
      logger.info(`🚦 [${exchange}] Entry not placed — ${ENTRY_NOT_ADMITTED}`);
      return;
    }

    // An accepted bid is tracked even if admission closed while its response
    // was pending: the order is live on the exchange and must reconcile.
    if (result.success) {
      positionState.lastEntryTime = Date.now();
      positionState.anchorPrice = getMarketState().lastPrice;

      // Persist entry order to state for recovery across restarts
      if (!isDryRun) {
        if (!positionState.pendingEntryOrders) positionState.pendingEntryOrders = [];
        positionState.pendingEntryOrders.push({
          orderId: result.orderId,
          price: result.price,
          assetQty: result.assetQty,
          sizeUsdc: sizing.sizeUsdc,
          placedAt: Date.now(),
          // The adaptive window this bid was placed with, so a restart re-arms
          // the same deadline instead of the orderStaleMs floor.
          staleMs: entryStaleMs,
        });
        saveLiveState();
      }

      const macroLabel = macroRegime ? ` macro=${macroRegime.getMode()}(×${macroMult.sizeMult})` : '';
      const autoLabel = autoMult.active ? ` auto=×${autoMult.multiplier.toFixed(2)}(gov ${autoMult.governor.toFixed(2)})` : '';
      logger.info(`📝 [${exchange}] Entry placed: regime=${regime}${macroLabel}${autoLabel} buys=${positionState.cycleBuys} size=$${sizing.sizeUsdc} price=${fmtPrice(result.price)} trigger=${triggerType} momentum=${momentumDirection} offset=${effectiveOffsetBps}bps`);

      tradeEvents.emitTradeEvent('entry_placed', exchange, `$${sizing.sizeUsdc} @ ${fmtPrice(result.price)}`, {
        regime,
        macroMode: macroRegime ? macroRegime.getMode() : null,
        macroSizeMult: macroMult.sizeMult,
        autoSizeMult: autoMult.multiplier,
        step: positionState.cycleBuys,
        sizeUsdc: sizing.sizeUsdc,
        price: result.price,
        trigger: triggerType,
        momentum: momentumDirection,
        offsetBps: effectiveOffsetBps,
      });
    }
  };

  return { evaluateEntryTrigger, evaluateLadderEntry };
};

module.exports = { createEntryEvaluator, CAP_ALERT_LABELS };
