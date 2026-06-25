// @ts-check
/**
 * UpDown Dashboard API Routes
 *
 * REST endpoints for the UpDown BTC Options Signal Dashboard.
 * Controls contract config, position tracking, signal engine lifecycle.
 */

const path = require('path');
const fs = require('fs');
const { exec } = require('child_process');
const { readFileSync, readdirSync } = fs;
const { log } = require('../logger');
const { UPDOWN_DATA_DIR } = require('../paths');
const { validateEndpointUrl } = require('../url-validator');

const ALLOWED_IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp']);

const ALLOWED_EXTRACTED_KEYS = new Set([
  'screenType', 'currentPrice', 'direction', 'range', 'target', 'stop',
  'expiresIn', 'upPrice', 'downPrice', 'maxProfit', 'maxLoss',
  'contractPrice', 'contracts', 'maxProfitAmount', 'maxLossAmount',
  'youPay', 'priceToClose', 'unrealizedPnl', 'entryPrice', 'expiresOn',
]);

const VISION_PROMPT = `You are analyzing a screenshot from the Crypto.com UpDown Bitcoin options trading interface.

First, identify which screen this is:
- "select" = Select UpDown Option screen (shows Up/Down buttons, Contract Range 500/2000, Target, Stop, Max Profit/Loss as strings like "+$419.50")
- "order" = Place Order / Order Confirmation screen (shows Contract Price, number of Contracts, Max Profit/Loss amounts, You Pay total, and a "Place Order" or confirmation button)
- "position" = Position Details screen (shows an open position with Entry Price, Price to Close, Unrealized P&L)

Extract fields relevant to the detected screen type and return ONLY valid JSON (no markdown, no explanation):

For "select" screen:
{
  "screenType": "select",
  "currentPrice": <number - current BTC price shown at top>,
  "direction": "<string - 'Up' or 'Down' - whichever button is highlighted/selected>",
  "range": <number - 500 or 2000 - whichever Contract Range option is selected>,
  "target": <number - the Target price>,
  "stop": <number - the Stop price>,
  "expiresIn": "<string - the 'Expires in' value, e.g. '6h 20m' or '6d 18h 52m'>",
  "upPrice": <number - the price shown under the Up button>,
  "downPrice": <number - the price shown under the Down button>,
  "maxProfit": "<string - e.g. '+$419.50'>",
  "maxLoss": "<string - e.g. '-$580.50'>"
}

For "order" screen:
{
  "screenType": "order",
  "direction": "<string - 'Up' or 'Down'>",
  "contractPrice": <number - the contract/entry price>,
  "contracts": <number - number of contracts>,
  "maxProfitAmount": <number - max profit as a number>,
  "maxLossAmount": <number - max loss as a number>,
  "youPay": <number - total cost>,
  "expiresIn": "<string - expiry value if shown, e.g. '6d 18h 52m'>",
  "target": <number - target price if shown>,
  "stop": <number - stop price if shown>,
  "range": <number - 500 or 2000 if shown>
}

For "position" screen:
{
  "screenType": "position",
  "direction": "<string - 'Up' or 'Down' - from the Up/Down badge or Position sign (+1=Up, -1=Down)>",
  "entryPrice": <number - the Average Entry Price>,
  "currentPrice": <number - Bitcoin price if shown>,
  "priceToClose": <number - Price to Close value>,
  "unrealizedPnl": <number - Unrealised PnL, negative if loss>,
  "contracts": <number - absolute number from Position field, e.g. +1 or -1 means 1>,
  "expiresIn": "<string - relative time remaining if shown, e.g. '6d 18h 42m'>",
  "expiresOn": "<string - absolute expiry date if shown, e.g. 'Feb 28, 2026 at 1:00:00 AM'>",
  "target": <number - target price if visible on chart or labels>,
  "range": <number - 500 or 2000, inferred from the price range in subtitle like '$67,000 - $69,000' = 2000>
}

If you cannot read a value, use null. Return ONLY the JSON object.`;

/**
 * Parse an expiry value to a millisecond timestamp.
 * Accepts: number (ms), ISO string, or null.
 * @param {*} value
 * @returns {number | null}
 */
const parseExpiryToMs = (value) => {
  if (value == null) return null;
  if (typeof value === 'number' && value > 0) {
    // Detect a seconds-epoch passed where ms is expected: anything below ~1e12
    // is a timestamp before 2001 in ms, i.e. almost certainly seconds. Treating
    // a seconds value as ms yields a 1970 date → timeToExpiry=Infinity →
    // NO_TRADE_ZONE/warning silently disabled for the whole contract (issue #108).
    return value < 1e12 ? value * 1000 : value;
  }
  if (typeof value === 'string') {
    const ms = new Date(value).getTime();
    return Number.isFinite(ms) ? ms : null;
  }
  return null;
};

/**
 * @param {import('express').Express} app
 * @param {{updownService: Object, readJSON: Function, DATA_DIR: string}} deps
 */
module.exports = (app, deps) => {
  const { updownService, candleCache, readJSON, DATA_DIR } = deps;
  const PROVIDERS_PATH = path.join(DATA_DIR, 'providers.json');
  const SCREENSHOTS_DIR = path.join(DATA_DIR, 'screenshots');

  // --- AI Vision: providers list ---
  app.get('/api/updown/providers', (req, res) => {
    const data = readJSON(PROVIDERS_PATH, { providers: {} });
    const result = [];
    for (const [id, p] of Object.entries(data.providers || {})) {
      if (p.type === 'api' && p.enabled) {
        result.push({ id, name: p.name || id, models: p.models || [], defaultModel: p.defaultModel });
      }
    }
    res.json({ success: true, providers: result });
  });

  // --- AI Vision: screenshot analysis ---
  app.post('/api/updown/screenshot', async (req, res) => {
    const { providerId, model } = req.query;
    if (!providerId) return res.status(400).json({ success: false, error: 'providerId query param required' });

    // Read raw image body
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const imageBuffer = Buffer.concat(chunks);
    if (!imageBuffer.length) return res.status(400).json({ success: false, error: 'Empty image body' });

    // Validate and save screenshot
    const ext = (req.headers['content-type'] || 'image/png').split('/')[1]?.split(';')[0] || 'png';
    if (!ALLOWED_IMAGE_EXTS.has(ext)) {
      return res.status(400).json({ success: false, error: `Unsupported image type: ${ext}. Allowed: ${[...ALLOWED_IMAGE_EXTS].join(', ')}` });
    }
    if (!fs.existsSync(SCREENSHOTS_DIR)) fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
    const filename = `updown-${Date.now()}.${ext}`;
    fs.writeFileSync(path.join(SCREENSHOTS_DIR, filename), imageBuffer);
    log('INFO', `📸 UpDown screenshot saved: ${filename} (${imageBuffer.length} bytes)`);

    // Load provider
    const data = readJSON(PROVIDERS_PATH, { providers: {} });
    const provider = data.providers?.[providerId];
    if (!provider) return res.status(400).json({ success: false, error: `Provider "${providerId}" not found` });
    if (provider.type !== 'api') return res.status(400).json({ success: false, error: `Provider "${providerId}" is type "${provider.type}", need "api"` });
    if (!provider.enabled) return res.status(400).json({ success: false, error: `Provider "${providerId}" is disabled` });

    const selectedModel = model || provider.defaultModel;
    if (!selectedModel) return res.status(400).json({ success: false, error: `No model specified and provider has no defaultModel` });

    // Build OpenAI-compatible vision request
    const base64Image = imageBuffer.toString('base64');
    const mediaType = req.headers['content-type'] || 'image/png';
    const headers = { 'Content-Type': 'application/json' };
    if (provider.apiKey) headers['Authorization'] = `Bearer ${provider.apiKey}`;

    const body = {
      model: selectedModel,
      messages: [{
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: `data:${mediaType};base64,${base64Image}` } },
          { type: 'text', text: VISION_PROMPT }
        ]
      }],
      stream: false
    };

    // Validate provider endpoint URL to prevent SSRF attacks (includes async DNS check).
    const endpointValidation = await validateEndpointUrl(provider.endpoint);
    if (!endpointValidation.valid) {
      // Log the full detail server-side (includes URL); return only a generic message to the caller.
      log('WARN', `🤖 UpDown screenshot rejected: unsafe endpoint for "${providerId}": ${endpointValidation.error}`);
      return res.status(400).json({ success: false, error: 'Provider endpoint is misconfigured. Contact the administrator.' });
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), provider.timeout || 120_000);

    let aiResponse;
    try {
      log('INFO', `🤖 UpDown screenshot → ${providerId}/${selectedModel}`);
      const response = await fetch(`${provider.endpoint}/chat/completions`, {
        method: 'POST',
        headers,
        signal: controller.signal,
        body: JSON.stringify(body)
      });
      clearTimeout(timeout);

      if (!response.ok) {
        const errBody = await response.text().catch(() => '');
        log('ERROR', `🤖 UpDown screenshot AI error: ${response.status}`);
        return res.status(502).json({ success: false, error: `AI provider returned ${response.status}: ${errBody.slice(0, 200)}` });
      }

      const result = await response.json();
      aiResponse = result.choices?.[0]?.message?.content || '';
    } catch (err) {
      clearTimeout(timeout);
      log('ERROR', `🤖 UpDown screenshot AI failed: ${err.message}`);
      return res.status(502).json({ success: false, error: `AI request failed: ${err.message}` });
    }

    // Parse JSON from AI response (strip thinking tags, markdown fences, preamble)
    let extracted;
    try {
      let cleaned = aiResponse;
      // Strip <think>...</think> blocks (thinking/reasoning models)
      cleaned = cleaned.replace(/<think>[\s\S]*?<\/think>/g, '');
      // Strip markdown code fences
      cleaned = cleaned.replace(/```json\s*/g, '').replace(/```\s*/g, '');
      // Extract first JSON object from the response
      const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error('No JSON object found');
      const raw = JSON.parse(jsonMatch[0]);

      // Sanitize: only keep expected keys
      extracted = {};
      for (const key of Object.keys(raw)) {
        if (ALLOWED_EXTRACTED_KEYS.has(key)) {
          extracted[key] = raw[key];
        }
      }
    } catch (err) {
      log('ERROR', `🤖 UpDown screenshot parse failed`);
      return res.status(422).json({ success: false, error: 'AI returned unparseable response', raw: aiResponse.slice(0, 500) });
    }

    // Convert expiry to absolute ms timestamp
    // "Expires in Xd Xh Ym" → relative offset from now
    if (extracted.expiresIn) {
      const match = extracted.expiresIn.match(/(?:(\d+)d)?\s*(?:(\d+)h)?\s*(?:(\d+)m)?/);
      if (match && (match[1] || match[2] || match[3])) {
        const days = parseInt(match[1] || '0', 10);
        const hours = parseInt(match[2] || '0', 10);
        const minutes = parseInt(match[3] || '0', 10);
        extracted.expiryMs = Date.now() + days * 86400000 + hours * 3600000 + minutes * 60000;
        extracted.expiryISO = new Date(extracted.expiryMs).toISOString();
      }
    }
    // "Expires on Feb 28, 2026 at 1:00:00 AM" → parse absolute date
    if (!extracted.expiryMs && extracted.expiresOn) {
      const ms = new Date(extracted.expiresOn.replace(' at ', ' ')).getTime();
      if (Number.isFinite(ms)) {
        extracted.expiryMs = ms;
        extracted.expiryISO = new Date(ms).toISOString();
      }
    }

    log('INFO', `📸 UpDown screenshot extracted: screenType=${extracted.screenType} direction=${extracted.direction} target=${extracted.target} stop=${extracted.stop} range=${extracted.range}`);
    res.json({ success: true, extracted });
  });

  // --- Scorecard Analysis (historical) ---
  const SCORECARD_DIR = path.join(UPDOWN_DATA_DIR, 'scorecard');
  const INDICATORS = ['rsi', 'stochastic', 'macd', 'bollinger', 'vwap', 'momentum'];
  const ALL_TFS = ['1m', '3m', '5m', '10m', '15m', '30m', '1h', '2h', '4h', '1d'];

  const readJSONLFiles = (from, to) => {
    if (!fs.existsSync(SCORECARD_DIR)) return [];
    const files = readdirSync(SCORECARD_DIR).filter(f => f.endsWith('.jsonl')).sort();
    const fromStr = from.toISOString().slice(0, 10);
    const toStr = to.toISOString().slice(0, 10);
    const records = [];
    for (const file of files) {
      const dateStr = file.replace('.jsonl', '');
      if (dateStr < fromStr || dateStr > toStr) continue;
      const content = readFileSync(path.join(SCORECARD_DIR, file), 'utf-8');
      for (const line of content.split('\n')) {
        if (!line.trim()) continue;
        // The journal is written via fire-and-forget appendFile, so a crash
        // mid-append can leave a torn line. Skip unparseable lines (mirrors
        // scorecard.js loadHistory) instead of 500-ing the whole endpoint
        // permanently (issue #108).
        let rec;
        try { rec = JSON.parse(line); } catch { continue; }
        records.push(rec);
      }
    }
    return records;
  };

  app.get('/api/updown/scorecard-analysis', (req, res) => {
    const now = new Date();
    const fromParam = req.query.from;
    const toParam = req.query.to;
    const to = toParam ? new Date(toParam + 'T23:59:59Z') : now;
    const from = fromParam ? new Date(fromParam + 'T00:00:00Z') : new Date(now.getTime() - 7 * 86400000);

    const records = readJSONLFiles(from, to);
    const predictions = records.filter(r => r.type === 'prediction');
    const outcomes = records.filter(r => r.type === 'outcome');
    const weights = records.filter(r => r.type === 'weights');

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
    const heatmap = {};
    for (const ind of INDICATORS) {
      heatmap[ind] = {};
      for (const tf of ALL_TFS) {
        heatmap[ind][tf] = { correct: 0, total: 0, accuracy: null };
      }
    }
    for (const o of outcomes) {
      for (const ind of INDICATORS) {
        for (const tf of ALL_TFS) {
          const tfResult = o.tfResults?.[tf];
          if (!tfResult || tfResult.correct == null) continue;
          const indResult = o.indicatorResults?.[ind];
          if (!indResult || indResult.predictions === 0) continue;
          // Check if this indicator had a non-neutral prediction in this timeframe
          // We use the prediction's per-tf per-indicator scores via the outcome's indicator data
          heatmap[ind][tf].total++;
          if (tfResult.correct) heatmap[ind][tf].correct++;
        }
      }
    }
    for (const ind of INDICATORS) {
      for (const tf of ALL_TFS) {
        const cell = heatmap[ind][tf];
        cell.accuracy = cell.total > 0 ? Math.round(cell.correct / cell.total * 10000) / 100 : null;
      }
    }

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
    const contractOutcomes = outcomes.filter(o => o.contractOutcome != null);
    const contractByRange = {};
    for (const o of contractOutcomes) {
      // Find matching prediction for range info
      const pred = predictions.find(p => p.id === o.predictionId);
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

    res.json({
      success: true,
      accuracyOverTime,
      heatmap,
      indicatorAccuracyOverTime,
      weightEvolution,
      failurePatterns,
      contractAnalysis,
      summary: {
        accuracy: overallAccuracy,
        predictions: predictions.length,
        outcomes: totalOutcomes,
        bestIndicator,
        worstIndicator,
        bestTimeframe,
        bestWindow,
      },
    });
  });

  app.get('/api/updown/status', (req, res) => {
    res.json({ success: true, ...updownService.getStatus() });
  });

  app.get('/api/updown/scorecard', (req, res) => {
    res.json({ success: true, ...updownService.getScorecard() });
  });

  app.get('/api/updown/signal', (req, res) => {
    const status = updownService.getStatus();
    const ctx = updownService.getTradeContext?.() ?? {};
    res.json({
      success: true,
      signal: ctx.latestSignal ?? null,
      trendFilter: ctx.trendFilter ?? null,
      volatility: ctx.volatility ?? null,
      lastPrice: ctx.lastPrice ?? null,
      running: status.running ?? false,
    });
  });

  app.put('/api/updown/contract', (req, res) => {
    const { expiry, target, stop, range, direction } = req.body;
    if (direction && direction !== 'up' && direction !== 'down') {
      return res.status(400).json({ success: false, error: 'direction must be "up" or "down"' });
    }
    const expiryMs = parseExpiryToMs(expiry);
    updownService.setContract({ expiry: expiryMs, target: target ?? null, stop: stop ?? null, range: range ?? null, direction: direction ?? null });
    res.json({ success: true });
  });

  app.put('/api/updown/position', (req, res) => {
    const { entryPrice, contracts, direction } = req.body;
    if (!entryPrice || !contracts || !direction) {
      return res.status(400).json({ success: false, error: 'entryPrice, contracts, and direction are required' });
    }
    if (direction !== 'up' && direction !== 'down') {
      return res.status(400).json({ success: false, error: 'direction must be "up" or "down"' });
    }
    // Reject non-numeric/non-positive values: !entryPrice doesn't catch "abc",
    // and parseFloat('abc')=NaN would persist into the position and emit
    // {pnl: NaN} over the socket (issue #108).
    const px = parseFloat(entryPrice);
    const qty = parseFloat(contracts);
    if (!Number.isFinite(px) || px <= 0 || !Number.isFinite(qty) || qty <= 0) {
      return res.status(400).json({ success: false, error: 'entryPrice and contracts must be positive numbers' });
    }
    updownService.setPosition({ entryPrice: px, contracts: qty, direction, entryTime: req.body.entryTime });
    res.json({ success: true });
  });

  app.delete('/api/updown/position', (req, res) => {
    updownService.clearPosition();
    res.json({ success: true });
  });

  app.post('/api/updown/start', async (req, res) => {
    await updownService.start();
    log('INFO', '📊 UpDown service started via API');
    res.json({ success: true });
  });

  app.post('/api/updown/stop', (req, res) => {
    updownService.stop();
    log('INFO', '📊 UpDown service stopped via API');
    res.json({ success: true });
  });

  app.post('/api/updown/restart', (req, res) => {
    log('INFO', '🔄 PM2 restart requested via API');
    res.json({ success: true, message: 'Restarting...' });
    setTimeout(() => exec('pm2 restart critical-mass'), 500);
  });

  app.get('/api/updown/candles', (req, res) => {
    res.json({
      success: true,
      candles: candleCache.getAllCandles('cryptocom'),
    });
  });

  app.get('/api/updown/signals', (req, res) => {
    const status = updownService.getStatus();
    res.json({ success: true, signals: status.signalHistory });
  });

  // --- Trade History ---
  const TRADES_PATH = path.join(DATA_DIR, 'updown-trades.json');

  const readTrades = () => readJSON(TRADES_PATH, { trades: [], nextId: 1 });
  const writeTrades = (data) => fs.writeFileSync(TRADES_PATH, JSON.stringify(data, null, 2));
  // Strictly parse a finite number, or NaN. Unlike parseFloat, this rejects
  // numeric-prefix junk ('12abc'), empty/whitespace strings, arrays, and
  // booleans — non-numeric input must not persist as null over the wire and
  // break the win/loss pnl filters (issue #151).
  const parseFiniteNumber = (v) => {
    if (typeof v === 'number') return Number.isFinite(v) ? v : NaN;
    if (typeof v === 'string' && v.trim() !== '') {
      const n = Number(v);
      return Number.isFinite(n) ? n : NaN;
    }
    return NaN;
  };

  app.get('/api/updown/trades', (req, res) => {
    const data = readTrades();
    const trades = data.trades || [];
    const totalCost = trades.reduce((s, t) => s + (t.cost || 0), 0);
    const totalReturn = trades.reduce((s, t) => s + (t.returnAmount || 0), 0);
    const totalPnl = trades.reduce((s, t) => s + (t.pnl || 0), 0);
    const wins = trades.filter(t => t.pnl > 0).length;
    const losses = trades.filter(t => t.pnl <= 0).length;

    // Directional win rates
    const upTrades = trades.filter(t => t.direction === 'up');
    const downTrades = trades.filter(t => t.direction === 'down');
    const upWins = upTrades.filter(t => t.pnl > 0).length;
    const downWins = downTrades.filter(t => t.pnl > 0).length;

    res.json({
      success: true,
      trades,
      summary: {
        totalCost, totalReturn, totalPnl, wins, losses, count: trades.length,
        upWinRate: upTrades.length > 0 ? Math.round(upWins / upTrades.length * 10000) / 100 : null,
        downWinRate: downTrades.length > 0 ? Math.round(downWins / downTrades.length * 10000) / 100 : null,
        upCount: upTrades.length,
        downCount: downTrades.length,
      },
    });
  });

  app.post('/api/updown/trades', (req, res) => {
    const { date, cost, returnAmount, note, direction: bodyDirection } = req.body;
    if (cost == null || returnAmount == null) {
      return res.status(400).json({ success: false, error: 'cost and returnAmount are required' });
    }
    const costNum = parseFiniteNumber(cost);
    const returnNum = parseFiniteNumber(returnAmount);
    if (!Number.isFinite(costNum) || !Number.isFinite(returnNum)) {
      return res.status(400).json({ success: false, error: 'cost and returnAmount must be numbers' });
    }
    const data = readTrades();

    // Auto-capture trade context from service
    const ctx = updownService.getTradeContext?.() ?? {};
    const signalDirection = ctx.latestSignal?.type?.includes('BUY') ? 'up'
      : ctx.latestSignal?.type?.includes('SELL') ? 'down'
      : null;
    const inferredDirection = bodyDirection || ctx.position?.direction || ctx.contract?.direction || signalDirection;
    const manualOverride = bodyDirection && signalDirection ? bodyDirection !== signalDirection : false;

    const trade = {
      id: data.nextId || (data.trades.length + 1),
      date: date || new Date().toISOString().slice(0, 10),
      cost: costNum,
      returnAmount: returnNum,
      pnl: returnNum - costNum,
      note: note || '',
      direction: inferredDirection || null,
      entryTime: new Date().toISOString(),
      exitTime: null,
      btcPriceAtEntry: ctx.lastPrice || null,
      btcPriceAtExit: null,
      contract: ctx.contract?.target ? {
        target: ctx.contract.target,
        stop: ctx.contract.stop,
        range: ctx.contract.range,
        direction: ctx.contract.direction,
        expiry: ctx.contract.expiry,
      } : null,
      signal: ctx.latestSignal ? {
        type: ctx.latestSignal.type,
        score: ctx.latestSignal.score,
        confidence: ctx.latestSignal.confidence,
      } : null,
      manualOverride,
    };
    data.trades.push(trade);
    data.nextId = trade.id + 1;
    writeTrades(data);
    log('INFO', `📊 UpDown trade added: id=${trade.id} cost=${trade.cost} return=${trade.returnAmount} pnl=${trade.pnl} dir=${trade.direction}`);
    res.json({ success: true, trade });
  });

  app.put('/api/updown/trades/:id', (req, res) => {
    const id = parseInt(req.params.id, 10);
    const data = readTrades();
    const trade = data.trades.find(t => t.id === id);
    if (!trade) return res.status(404).json({ success: false, error: 'Trade not found' });

    // Reject non-numeric updates before mutating the trade (issue #151).
    for (const field of ['cost', 'returnAmount', 'btcPriceAtExit']) {
      if (req.body[field] != null && !Number.isFinite(parseFiniteNumber(req.body[field]))) {
        return res.status(400).json({ success: false, error: `${field} must be a number` });
      }
    }

    if (req.body.date != null) trade.date = req.body.date;
    if (req.body.cost != null) trade.cost = parseFiniteNumber(req.body.cost);
    if (req.body.returnAmount != null) trade.returnAmount = parseFiniteNumber(req.body.returnAmount);
    if (req.body.note != null) trade.note = req.body.note;
    if (req.body.direction != null) trade.direction = req.body.direction;
    if (req.body.exitTime != null) trade.exitTime = req.body.exitTime;
    if (req.body.btcPriceAtExit != null) trade.btcPriceAtExit = parseFiniteNumber(req.body.btcPriceAtExit);
    trade.pnl = trade.returnAmount - trade.cost;
    writeTrades(data);
    res.json({ success: true, trade });
  });

  app.delete('/api/updown/trades/:id', (req, res) => {
    const id = parseInt(req.params.id, 10);
    const data = readTrades();
    const idx = data.trades.findIndex(t => t.id === id);
    if (idx === -1) return res.status(404).json({ success: false, error: 'Trade not found' });
    data.trades.splice(idx, 1);
    writeTrades(data);
    log('INFO', `📊 UpDown trade deleted: id=${id}`);
    res.json({ success: true });
  });
};
