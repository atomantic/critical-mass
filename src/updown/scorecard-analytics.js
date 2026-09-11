// @ts-check
/**
 * Pure scorecard outcome interpretation and historical analysis.
 * Runtime lifecycle belongs in scorecard.js; journal I/O belongs to callers.
 */
const { INDICATORS, INDICATOR_LABELS, INDICATOR_WEIGHTS } = require('./indicator-config')
const { ALL_SIGNAL_TFS: ALL_TFS } = require('./signal-engine')
const { calculatePerpPnl } = require('./perp-contract')

const WINDOW_MS = { '1m': 60_000, '5m': 300_000, '15m': 900_000, '1h': 3_600_000 }
const DIRECTION_THRESHOLD = 15 // aligned with signal-engine's neutralThreshold for BUY signals
// Prevents 1-tick noise from inflating short-window accuracy stats.
const EVAL_NOISE_FLOORS_BPS = {
  60000: 5,      // 1m: 5 bps (~$4 on $80k BTC) — noise filter
  300000: 10,    // 5m: 10 bps
  900000: 20,    // 15m: 20 bps
  3600000: 40,   // 1h: 40 bps
}

/**
 * Classify a score into a directional prediction
 * @param {number} score
 * @returns {'up' | 'down' | 'neutral'}
 */
const getDirection = (score) => {
  if (score > DIRECTION_THRESHOLD) return 'up'
  if (score < -DIRECTION_THRESHOLD) return 'down'
  return 'neutral'
}

/**
 * Evaluate if a directional prediction was correct.
 *
 * Two products, two treatments of "didn't move":
 *  - `options` (default): no-move is a miss. A Crypto.com Up option that expires
 *    unchanged is out of the money.
 *  - `perp`: no-move is a scratch (null). A Coinbase perp flip that never reaches
 *    the noise floor is not a win or a loss — just not a trade.
 *
 * Pure/module-level so it can back both live evaluation and restart backfill (issue #212E).
 * @param {'up' | 'down' | 'neutral'} direction
 * @param {number} priceChangeBps
 * @param {number} [windowMs=300000] - Evaluation window in ms (determines noise floor)
 * @param {'options' | 'perp'} [mode='options']
 * @returns {boolean | null} null if skipped (neutral, or perp scratch)
 */
const evaluateDirection = (direction, priceChangeBps, windowMs = 300000, mode = 'options') => {
  if (direction === 'neutral') return null
  const noiseBps = EVAL_NOISE_FLOORS_BPS[windowMs] ?? 10
  if (mode === 'perp' && Math.abs(priceChangeBps) <= noiseBps) return null
  if (direction === 'up') return priceChangeBps > noiseBps
  return priceChangeBps < -noiseBps
}

/**
 * Perp correctness: explicit field on new outcomes, derived from noise floor
 * for JSONL rows persisted before perpCorrect existed.
 * @param {Object} o
 * @returns {boolean | null}
 */
const resolvePerpCorrect = (o) => {
  if (o.perpCorrect !== undefined) return o.perpCorrect
  if (o.compositeCorrect == null) return null
  const floor = EVAL_NOISE_FLOORS_BPS[WINDOW_MS[o.window]] ?? 10
  if (Math.abs(o.priceChangeBps ?? 0) <= floor) return null
  return o.compositeCorrect
}

/**
 * Keep one durable prediction/outcome per semantic journal key. Append-only
 * recovery and legacy backfill reruns can otherwise train and report duplicates.
 * Non-scoring event records (weights/fills) are preserved.
 * @param {Array<Object|null>} records
 * @returns {Array<Object|null>}
 */
const dedupeScorecardRecords = (records) => {
  const seen = new Set()
  const result = []
  for (const record of records) {
    if (!record) continue
    let key = null
    if (record.type === 'prediction' && record.id) key = `prediction:${record.id}`
    if (record.type === 'outcome' && record.predictionId && record.window) {
      key = `outcome:${record.predictionId}:${record.window}`
    }
    if (key && seen.has(key)) continue
    if (key) seen.add(key)
    result.push(record)
  }
  return result
}

const buildIndicatorTimeframeHeatmap = (
  predictions,
  outcomes,
  indicators = INDICATORS,
  timeframes = ALL_TFS,
) => {
  const predictionById = new Map(predictions.map(p => [p.id, p]));
  const heatmap = {};
  for (const ind of indicators) {
    heatmap[ind] = {};
    for (const tf of timeframes) heatmap[ind][tf] = { correct: 0, total: 0, accuracy: null };
  }
  for (const outcome of outcomes) {
    for (const ind of indicators) {
      for (const tf of timeframes) {
        let exact = outcome.indicatorTfResults?.[ind]?.[tf]?.correct;
        if (exact === undefined) {
          const prediction = predictionById.get(outcome.predictionId);
          const score = prediction?.timeframes?.[tf]?.scores?.[ind];
          if (!Number.isFinite(score) || !Number.isFinite(outcome.priceChangeBps)) continue;
          exact = evaluateDirection(getDirection(score), outcome.priceChangeBps, WINDOW_MS[outcome.window], 'perp');
        }
        if (exact == null) continue;
        heatmap[ind][tf].total++;
        if (exact) heatmap[ind][tf].correct++;
      }
    }
  }
  for (const ind of indicators) {
    for (const tf of timeframes) {
      const cell = heatmap[ind][tf];
      cell.accuracy = cell.total > 0 ? Math.round(cell.correct / cell.total * 10000) / 100 : null;
    }
  }
  return heatmap;
};

/**
 * Aggregate historical journal records without mutating retained data.
 * Date selection belongs to the transport; semantic deduplication belongs here.
 * @param {Array<Object|null>} journalRecords
 * @returns {Object}
 */
const buildScorecardAnalysis = (journalRecords) => {
  const records = dedupeScorecardRecords(journalRecords);
  const predictions = records.filter(r => r.type === 'prediction');
  const predictionById = new Map(predictions.map(p => [p.id, p]));
  const outcomes = records.filter(r => r.type === 'outcome' && r.compositeDirection !== 'down');
  const weights = records.filter(r => r.type === 'weights');
  const perpFills = records.filter(r => r.type === 'perp_fill');

  // --- accuracyOverTime: hourly accuracy buckets ---
  const hourlyBuckets = {};
  for (const o of outcomes) {
    if (o.compositeCorrect == null) continue;
    const hour = o.ts?.slice(0, 13); // YYYY-MM-DDTHH
    if (!hour) continue;
    if (!hourlyBuckets[hour]) hourlyBuckets[hour] = { correct: 0, total: 0 };
    hourlyBuckets[hour].total++;
    if (o.compositeCorrect) hourlyBuckets[hour].correct++;
  }
  const accuracyOverTime = Object.entries(hourlyBuckets)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([hour, data]) => ({
      hour,
      accuracy: Math.round(data.correct / data.total * 10000) / 100,
      correct: data.correct,
      total: data.total,
    }));

  // --- heatmap: indicator × timeframe accuracy ---
  const heatmap = buildIndicatorTimeframeHeatmap(predictions, outcomes, INDICATORS, ALL_TFS);

  // --- indicatorAccuracyOverTime: per-indicator hourly trends ---
  const indHourly = {};
  for (const ind of INDICATORS) indHourly[ind] = {};
  for (const o of outcomes) {
    const hour = o.ts?.slice(0, 13);
    if (!hour) continue;
    for (const ind of INDICATORS) {
      const indResult = o.indicatorResults?.[ind];
      if (!indResult || indResult.predictions === 0) continue;
      if (!indHourly[ind][hour]) indHourly[ind][hour] = { correct: 0, total: 0 };
      indHourly[ind][hour].total += indResult.predictions;
      indHourly[ind][hour].correct += indResult.correct;
    }
  }
  // Collect all unique hours across all indicators
  const allHours = [...new Set(Object.values(indHourly).flatMap(h => Object.keys(h)))].sort();
  const indicatorAccuracyOverTime = allHours.map(hour => {
    const point = { hour };
    for (const ind of INDICATORS) {
      const data = indHourly[ind][hour];
      point[ind] = data && data.total > 0 ? Math.round(data.correct / data.total * 10000) / 100 : null;
    }
    return point;
  });

  // --- weightEvolution: weight snapshots over time ---
  const weightEvolution = weights.map(w => ({
    ts: w.ts,
    ...w.weights,
  }));

  // --- failurePatterns: indicator combos that predict wrong together ---
  const comboFailures = {};
  for (const o of outcomes) {
    if (o.compositeCorrect !== false) continue;
    const failedInds = [];
    for (const ind of INDICATORS) {
      const indResult = o.indicatorResults?.[ind];
      if (indResult && indResult.predictions > 0 && indResult.correct === 0) {
        failedInds.push(ind);
      }
    }
    if (failedInds.length < 2) continue;
    const key = failedInds.sort().join('+');
    if (!comboFailures[key]) comboFailures[key] = { indicators: failedInds, count: 0, total: 0 };
    comboFailures[key].count++;
  }
  // Also count total occurrences where these indicators appeared together
  for (const o of outcomes) {
    for (const key of Object.keys(comboFailures)) {
      const inds = comboFailures[key].indicators;
      const allPresent = inds.every(ind => {
        const indResult = o.indicatorResults?.[ind];
        return indResult && indResult.predictions > 0;
      });
      if (allPresent) comboFailures[key].total++;
    }
  }
  const failurePatterns = Object.values(comboFailures)
    .filter(p => p.total >= 3)
    .map(p => ({
      indicators: p.indicators,
      failures: p.count,
      total: p.total,
      failureRate: Math.round(p.count / p.total * 10000) / 100,
    }))
    .sort((a, b) => b.failureRate - a.failureRate)
    .slice(0, 20);

  // --- summary ---
  const totalOutcomes = outcomes.filter(o => o.compositeCorrect != null).length;
  const totalCorrect = outcomes.filter(o => o.compositeCorrect === true).length;
  const overallAccuracy = totalOutcomes > 0 ? Math.round(totalCorrect / totalOutcomes * 10000) / 100 : null;
  const perpOutcomes = outcomes.map(resolvePerpCorrect).filter(correct => correct != null);
  const perpCorrect = perpOutcomes.filter(correct => correct === true).length;
  const perpDirectionalAccuracy = perpOutcomes.length > 0
    ? Math.round(perpCorrect / perpOutcomes.length * 10000) / 100
    : null;

  // Best/worst indicator
  const indStats = {};
  for (const ind of INDICATORS) {
    let total = 0, correct = 0;
    for (const o of outcomes) {
      const r = o.indicatorResults?.[ind];
      if (!r || r.predictions === 0) continue;
      total += r.predictions;
      correct += r.correct;
    }
    indStats[ind] = { accuracy: total > 0 ? Math.round(correct / total * 10000) / 100 : null, total };
  }
  const sortedInds = Object.entries(indStats).filter(([, v]) => v.accuracy != null).sort(([, a], [, b]) => b.accuracy - a.accuracy);
  const bestIndicator = sortedInds[0]?.[0] ?? null;
  const worstIndicator = sortedInds[sortedInds.length - 1]?.[0] ?? null;

  // Best/worst timeframe
  const tfStats = {};
  for (const tf of ALL_TFS) {
    let total = 0, correct = 0;
    for (const o of outcomes) {
      const r = o.tfResults?.[tf];
      if (r?.correct == null) continue;
      total++;
      if (r.correct) correct++;
    }
    tfStats[tf] = { accuracy: total > 0 ? Math.round(correct / total * 10000) / 100 : null, total };
  }
  const sortedTfs = Object.entries(tfStats).filter(([, v]) => v.accuracy != null).sort(([, a], [, b]) => b.accuracy - a.accuracy);
  const bestTimeframe = sortedTfs[0]?.[0] ?? null;

  // Best window
  const windowStats = {};
  for (const o of outcomes) {
    if (o.compositeCorrect == null || !o.window) continue;
    if (!windowStats[o.window]) windowStats[o.window] = { correct: 0, total: 0 };
    windowStats[o.window].total++;
    if (o.compositeCorrect) windowStats[o.window].correct++;
  }
  const sortedWindows = Object.entries(windowStats)
    .map(([w, d]) => ({ window: w, accuracy: Math.round(d.correct / d.total * 10000) / 100 }))
    .sort((a, b) => b.accuracy - a.accuracy);
  const bestWindow = sortedWindows[0]?.window ?? null;

  // Contract-aware analysis: aggregate contract outcomes by range
  const contractOutcomes = outcomes.filter(o => o.window === 'contract' &&
    (o.contractOutcome === 'win' || o.contractOutcome === 'loss'));
  const contractByRange = {};
  for (const o of contractOutcomes) {
    // Find matching prediction for range info
    const pred = predictionById.get(o.predictionId);
    const range = pred?.contract?.range ?? 'unknown';
    if (!contractByRange[range]) contractByRange[range] = { wins: 0, losses: 0, total: 0 };
    contractByRange[range].total++;
    if (o.contractOutcome === 'win') contractByRange[range].wins++;
    else if (o.contractOutcome === 'loss') contractByRange[range].losses++;
  }
  for (const key of Object.keys(contractByRange)) {
    const d = contractByRange[key];
    d.accuracy = d.total > 0 ? Math.round(d.wins / d.total * 10000) / 100 : null;
  }
  const contractAnalysis = contractOutcomes.length > 0 ? {
    total: contractOutcomes.length,
    byRange: contractByRange,
  } : null;

  const closedRounds = perpFills
    .filter(f => f.action === 'CLOSE' && f.trade)
    .map(f => ({
      ...f,
      normalizedPnl: calculatePerpPnl(f.trade.avgEntry, f.trade.exitPrice, f.trade.contracts),
    }))
  const perpWins = closedRounds.filter(f => f.normalizedPnl > 0)
  const perpLosses = closedRounds.filter(f => f.normalizedPnl <= 0)
  const perpRealized = closedRounds.reduce((s, f) => s + f.normalizedPnl, 0)
  const perpAnalysis = perpFills.length > 0 ? {
    opens: perpFills.filter(f => f.action === 'OPEN').length,
    adds: perpFills.filter(f => f.action === 'ADD').length,
    closes: closedRounds.length,
    wins: perpWins.length,
    losses: perpLosses.length,
    winRate: closedRounds.length > 0
      ? Math.round(perpWins.length / closedRounds.length * 10000) / 100
      : null,
    realizedPnl: Math.round(perpRealized * 100) / 100,
  } : null

  return {
    success: true,
    catalog: {
      indicators: INDICATORS.map(key => ({ key, label: INDICATOR_LABELS[key] ?? key })),
      baseWeights: INDICATOR_WEIGHTS,
      timeframes: [...ALL_TFS],
    },
    accuracyOverTime,
    heatmap,
    indicatorAccuracyOverTime,
    weightEvolution,
    failurePatterns,
    contractAnalysis,
    perpAnalysis,
    summary: {
      accuracy: overallAccuracy,
      perpDirectionalAccuracy,
      predictions: predictions.length,
      outcomes: totalOutcomes,
      bestIndicator,
      worstIndicator,
      bestTimeframe,
      bestWindow,
      perpRealizedPnl: perpAnalysis?.realizedPnl ?? null,
      perpWinRate: perpAnalysis?.winRate ?? null,
      perpRounds: perpAnalysis?.closes ?? 0,
    },
  };
}

module.exports = {
  getDirection,
  evaluateDirection,
  resolvePerpCorrect,
  dedupeScorecardRecords,
  WINDOW_MS,
  buildIndicatorTimeframeHeatmap,
  buildScorecardAnalysis,
}
