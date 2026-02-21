/**
 * Auto-Tuning Service
 * Monitors strategy performance and automatically adjusts parameters
 */

const { ts } = require('../../time-utils')

/**
 * Tuning thresholds
 */
const THRESHOLDS = {
  minTradesForAnalysis: 10,
  lowWinRate: 30,              // Win rate below this triggers tuning
  highStopLossRatio: 3,        // If stop losses > take profits * this ratio
  significantLoss: -50,        // Dollar loss that triggers position size reduction
  maxAdjustmentsPerHour: 3     // Rate limit tuning adjustments
}

/**
 * Analyze performance and generate tuning suggestions
 * @param {Object} analytics - Analytics data from analytics endpoint
 * @returns {Array<Object>} Tuning suggestions
 */
const analyzePerformance = (analytics) => {
  const suggestions = []

  if (!analytics?.summary || analytics.summary.totalTrades < THRESHOLDS.minTradesForAnalysis) {
    return suggestions
  }

  const { winRate, totalPnl, avgPnl } = analytics.summary
  const stopLossCount = analytics.byReason?.['Stop loss']?.count || 0
  const takeProfitCount = analytics.byReason?.['Take profit']?.count || 0
  const maxHoldCount = analytics.byReason?.['Max hold time']?.count || 0

  // Issue 1: Too many stop losses
  if (stopLossCount > takeProfitCount * THRESHOLDS.highStopLossRatio && stopLossCount > 5) {
    suggestions.push({
      issue: 'high_stop_loss_ratio',
      severity: 'warning',
      message: `Stop losses (${stopLossCount}) dominate exits vs take profits (${takeProfitCount})`,
      recommendation: 'Widen stop loss percentage',
      adjustments: {
        stopLossPct: { action: 'multiply', factor: 1.5, min: 0.05, max: 0.30 }
      }
    })
  }

  // Issue 2: Low win rate
  if (winRate < THRESHOLDS.lowWinRate) {
    suggestions.push({
      issue: 'low_win_rate',
      severity: 'warning',
      message: `Win rate (${winRate.toFixed(1)}%) is below ${THRESHOLDS.lowWinRate}%`,
      recommendation: 'Be more selective - increase edge threshold',
      adjustments: {
        edgeThreshold: { action: 'multiply', factor: 1.25, min: 0.05, max: 0.25 }
      }
    })
  }

  // Issue 3: Significant losses
  if (totalPnl < THRESHOLDS.significantLoss) {
    suggestions.push({
      issue: 'significant_losses',
      severity: 'critical',
      message: `Total P&L ($${totalPnl.toFixed(2)}) indicates significant losses`,
      recommendation: 'Reduce position size to limit exposure',
      adjustments: {
        positionSize: { action: 'set', value: 3 }
      }
    })
  }

  // Issue 4: Max hold exits dominate (positions timing out)
  if (maxHoldCount > (stopLossCount + takeProfitCount) && maxHoldCount > 3) {
    suggestions.push({
      issue: 'max_hold_exits',
      severity: 'info',
      message: `Many positions timeout (${maxHoldCount} max hold exits)`,
      recommendation: 'Increase max hold time or lower take profit threshold',
      adjustments: {
        maxHoldSeconds: { action: 'multiply', factor: 1.5, min: 60, max: 300 },
        takeProfitPct: { action: 'multiply', factor: 0.75, min: 0.05, max: 0.30 }
      }
    })
  }

  // Issue 5: Negative average P&L per trade
  if (avgPnl < -0.10 && analytics.summary.totalTrades >= 20) {
    suggestions.push({
      issue: 'negative_expectancy',
      severity: 'critical',
      message: `Negative average P&L ($${avgPnl.toFixed(2)}) per trade`,
      recommendation: 'Strategy may need fundamental changes',
      adjustments: {
        edgeThreshold: { action: 'multiply', factor: 1.5, min: 0.10, max: 0.30 },
        confirmationUpdates: { action: 'add', value: 1, min: 2, max: 5 }
      }
    })
  }

  return suggestions
}

/**
 * Apply tuning adjustments to strategy parameters
 * @param {Object} currentParams - Current strategy parameters
 * @param {Object} adjustments - Adjustments to apply
 * @returns {Object} Updated parameters
 */
const applyAdjustments = (currentParams, adjustments) => {
  const newParams = { ...currentParams }

  for (const [param, adjustment] of Object.entries(adjustments)) {
    const currentValue = currentParams[param]
    if (currentValue === undefined) continue

    let newValue
    switch (adjustment.action) {
      case 'multiply':
        newValue = currentValue * adjustment.factor
        break
      case 'add':
        newValue = currentValue + adjustment.value
        break
      case 'set':
        newValue = adjustment.value
        break
      default:
        continue
    }

    // Apply bounds
    if (adjustment.min !== undefined) newValue = Math.max(adjustment.min, newValue)
    if (adjustment.max !== undefined) newValue = Math.min(adjustment.max, newValue)

    // Round to reasonable precision
    newParams[param] = Number.isInteger(adjustment.value || currentValue)
      ? Math.round(newValue)
      : Math.round(newValue * 100) / 100

    console.log(`[${ts()}] 🔧 Auto-tune: ${param} ${currentValue} -> ${newParams[param]}`)
  }

  return newParams
}

/**
 * Auto-tuning manager class
 */
class AutoTuner {
  constructor() {
    this.enabled = false
    this.lastAdjustment = null
    this.adjustmentCount = 0
    this.adjustmentWindow = 60 * 60 * 1000 // 1 hour window
  }

  enable() {
    this.enabled = true
    console.log(`[${ts()}] 🤖 Auto-tuner enabled`)
  }

  disable() {
    this.enabled = false
    console.log(`[${ts()}] 🤖 Auto-tuner disabled`)
  }

  /**
   * Check if we can make an adjustment (rate limiting)
   */
  canAdjust() {
    if (!this.enabled) return false

    const now = Date.now()
    if (this.lastAdjustment && now - this.lastAdjustment < this.adjustmentWindow) {
      if (this.adjustmentCount >= THRESHOLDS.maxAdjustmentsPerHour) {
        return false
      }
    } else {
      // Reset counter if window passed
      this.adjustmentCount = 0
    }

    return true
  }

  /**
   * Record an adjustment
   */
  recordAdjustment() {
    this.lastAdjustment = Date.now()
    this.adjustmentCount++
  }

  /**
   * Run auto-tuning check
   * @param {Object} analytics - Current analytics
   * @param {Object} strategies - Current strategy configs
   * @param {Function} saveCallback - Callback to save updated strategies
   */
  async check(analytics, strategies, saveCallback) {
    if (!this.canAdjust()) return null

    const suggestions = analyzePerformance(analytics)

    // Only act on critical or warning suggestions
    const actionable = suggestions.filter(s =>
      s.severity === 'critical' || s.severity === 'warning'
    )

    if (actionable.length === 0) return null

    // Apply first actionable suggestion
    const suggestion = actionable[0]
    console.log(`[${ts()}] 🤖 Auto-tune: ${suggestion.message}`)

    let adjusted = false
    const updatedStrategies = { ...strategies }

    for (const [stratKey, strategy] of Object.entries(updatedStrategies)) {
      if (!strategy.enabled) continue

      const newParams = applyAdjustments(strategy.params || {}, suggestion.adjustments)
      if (JSON.stringify(newParams) !== JSON.stringify(strategy.params)) {
        updatedStrategies[stratKey] = { ...strategy, params: newParams }
        adjusted = true
      }
    }

    if (adjusted) {
      this.recordAdjustment()
      if (saveCallback) {
        await saveCallback(updatedStrategies)
      }
      return { suggestion, strategies: updatedStrategies }
    }

    return null
  }
}

const autoTuner = new AutoTuner()

module.exports = {
  analyzePerformance,
  applyAdjustments,
  AutoTuner,
  autoTuner,
  THRESHOLDS
}
