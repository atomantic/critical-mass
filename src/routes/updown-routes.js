// @ts-check
/**
 * UpDown Dashboard API Routes
 *
 * REST endpoints for the UpDown BTC perp-long signal dashboard.
 * Controls contract config, position tracking, signal engine lifecycle.
 */

const path = require('path');
const fs = require('fs');
const { exec } = require('child_process');
const { readFileSync, readdirSync } = fs;
const { createContextLogger } = require('../logger');
const { UPDOWN_DATA_DIR } = require('../paths');
const { validateEndpointUrl, safeFetch } = require('../url-validator');
const {
  buildScorecardAnalysis,
  buildIndicatorTimeframeHeatmap,
} = require('../updown/scorecard-analytics');

/**
 * Context logger for the UpDown routes. UpDown is a single paper-traded BTC
 * perp book with no exchange behind it, so `route` carries the operator-facing
 * scope instead of exchange/pair.
 * @param {string} route - Express route pattern being served
 * @returns {{info: (message: string, data?: Object) => void, warn: (message: string, data?: Object) => void, error: (message: string, data?: Object) => void}} Context logger
 */
const updownRouteLogger = (route) => createContextLogger({
  module: 'updown-routes',
  route,
});

const ALLOWED_IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp']);

// Hard cap on the raw screenshot body read from the request stream. A
// screenshot is a single PNG/JPEG frame — 25MB is generous headroom while
// still bounding worst-case memory use per request (issue #215-B).
const MAX_SCREENSHOT_BYTES = 25 * 1024 * 1024;

// Strictly parse a finite number, or NaN. Unlike parseFloat, this rejects
// numeric-prefix junk, empty strings, arrays, and booleans.
const parseFiniteNumber = (v) => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : NaN;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : NaN;
  }
  return NaN;
};

/**
 * Read a request body stream into a Buffer, aborting once `maxBytes` is
 * exceeded instead of buffering an unbounded amount of attacker-controlled
 * data into memory (issue #215-B: unbounded body read -> memory-exhaustion
 * DoS on the process that also runs the trade scheduler).
 * @param {import('http').IncomingMessage} req
 * @param {number} maxBytes
 * @returns {Promise<Buffer>}
 */
async function readBodyWithLimit(req, maxBytes) {
  const declaredLength = Number(req.headers['content-length']);
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    const err = new Error(`Request body exceeds maximum of ${maxBytes} bytes`);
    err.status = 413;
    throw err;
  }

  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) {
      const err = new Error(`Request body exceeds maximum of ${maxBytes} bytes`);
      err.status = 413;
      throw err;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

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
 * @param {{updownService: Object, readJSON: Function, DATA_DIR: string, validateEndpointUrl?: Function, safeFetch?: Function}} deps
 */
module.exports = (app, deps) => {
  const {
    updownService,
    candleCache,
    readJSON,
    writeJSON,
    DATA_DIR,
    validateEndpointUrl: validateEndpointUrlFn = validateEndpointUrl,
    safeFetch: safeFetchFn = safeFetch,
  } = deps;
  const PROVIDERS_PATH = path.join(DATA_DIR, 'providers.json');

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
    const logger = updownRouteLogger('/api/updown/screenshot');
    const { providerId, model } = req.query;
    if (!providerId) return res.status(400).json({ success: false, error: 'providerId query param required' });

    // Read raw image body, capped to avoid unbounded memory growth (issue #215-B).
    let imageBuffer;
    try {
      imageBuffer = await readBodyWithLimit(req, MAX_SCREENSHOT_BYTES);
    } catch (err) {
      if (err.status === 413) {
        logger.warn(`⚠️ 📸 UpDown screenshot rejected: body exceeds ${MAX_SCREENSHOT_BYTES} bytes`, {
          action: 'screenshot',
          reason: 'body-too-large',
          maxBytes: MAX_SCREENSHOT_BYTES,
        });
        return res.status(413).json({ success: false, error: 'Image body too large' });
      }
      throw err;
    }
    if (!imageBuffer.length) return res.status(400).json({ success: false, error: 'Empty image body' });

    // Validate the image type before provider work. Screenshots are deliberately
    // processed from memory and never persisted: they contain operator/account
    // details and retaining them made every analysis permanently consume disk.
    const ext = (req.headers['content-type'] || 'image/png').split('/')[1]?.split(';')[0] || 'png';
    if (!ALLOWED_IMAGE_EXTS.has(ext)) {
      return res.status(400).json({ success: false, error: `Unsupported image type: ${ext}. Allowed: ${[...ALLOWED_IMAGE_EXTS].join(', ')}` });
    }

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
    const endpointValidation = await validateEndpointUrlFn(provider.endpoint);
    if (!endpointValidation.valid) {
      // Log the full detail server-side (includes URL); return only a generic message to the caller.
      logger.warn(`⚠️ 🤖 UpDown screenshot rejected: unsafe endpoint for "${providerId}": ${endpointValidation.error}`, {
        action: 'screenshot',
        provider: providerId,
        error: endpointValidation.error,
      });
      return res.status(400).json({ success: false, error: 'Provider endpoint is misconfigured. Contact the administrator.' });
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), provider.timeout || 120_000);

    let aiResponse;
    try {
      logger.info(`ℹ️ 🤖 UpDown screenshot → ${providerId}/${selectedModel}`, {
        action: 'screenshot',
        provider: providerId,
        model: selectedModel,
      });
      // safeFetch re-validates every redirect target through validateEndpointUrl,
      // strips Authorization on cross-origin redirects, and re-checks the
      // resolved IP at connect time (closes the redirect + TOCTOU SSRF gaps
      // that a bare fetch() would leave open — issue #207).
      const response = await safeFetchFn(`${provider.endpoint}/chat/completions`, {
        method: 'POST',
        headers,
        signal: controller.signal,
        body: JSON.stringify(body)
      });
      clearTimeout(timeout);

      if (!response.ok) {
        const errBody = await response.text().catch(() => '');
        logger.error(`❌ 🤖 UpDown screenshot AI error: ${response.status}`, {
          action: 'screenshot',
          provider: providerId,
          model: selectedModel,
          status: response.status,
        });
        return res.status(502).json({ success: false, error: `AI provider returned ${response.status}: ${errBody.slice(0, 200)}` });
      }

      const result = await response.json();
      aiResponse = result.choices?.[0]?.message?.content || '';
    } catch (err) {
      clearTimeout(timeout);
      // safeFetch's redirect/TOCTOU guard errors ("Blocked endpoint...",
      // "Blocked private/reserved...") can name the internal address it
      // refused to connect to — log that detail server-side but return a
      // generic message to the caller (same treatment as the pre-check above).
      const isSsrfBlock = /^Blocked (endpoint|private)/.test(err.message || '');
      logger.error(`❌ 🤖 UpDown screenshot AI failed: ${err.message}`, {
        action: 'screenshot',
        provider: providerId,
        model: selectedModel,
        ssrfBlocked: isSsrfBlock,
        error: err.message,
      });
      if (isSsrfBlock) {
        return res.status(502).json({ success: false, error: 'AI provider endpoint is misconfigured. Contact the administrator.' });
      }
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
      logger.error(`❌ 🤖 UpDown screenshot parse failed`, {
        action: 'screenshot',
        provider: providerId,
        model: selectedModel,
        error: err.message,
      });
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

    logger.info(`ℹ️ 📸 UpDown screenshot extracted: screenType=${extracted.screenType} direction=${extracted.direction} target=${extracted.target} stop=${extracted.stop} range=${extracted.range}`, {
      action: 'screenshot',
      provider: providerId,
      model: selectedModel,
      screenType: extracted.screenType,
      direction: extracted.direction,
    });
    res.json({ success: true, extracted });
  });

  // --- Scorecard Analysis (historical) ---
  const SCORECARD_DIR = path.join(UPDOWN_DATA_DIR, 'scorecard');

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
    res.json(buildScorecardAnalysis(records));
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
    const numericFields = { target, stop, range };
    const parsed = {};
    for (const [key, value] of Object.entries(numericFields)) {
      if (value == null || value === '') {
        parsed[key] = null;
        continue;
      }
      parsed[key] = parseFiniteNumber(value);
      if (!Number.isFinite(parsed[key]) || parsed[key] <= 0) {
        return res.status(400).json({ success: false, error: `${key} must be a positive number` });
      }
    }
    if (expiry != null && expiry !== '' && !Number.isFinite(expiryMs)) {
      return res.status(400).json({ success: false, error: 'expiry must be a valid date or timestamp' });
    }
    updownService.setContract({ expiry: expiryMs, ...parsed, direction: direction ?? null });
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
    // Reject numeric-prefix junk and non-positive values before persistence.
    const px = parseFiniteNumber(entryPrice);
    const qty = parseFiniteNumber(contracts);
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
    const logger = updownRouteLogger('/api/updown/start');
    try {
      await updownService.start();
      logger.info('ℹ️ 📊 UpDown service started via API', { action: 'start' });
      res.json({ success: true });
    } catch (err) {
      logger.error(`❌ 📊 UpDown service start failed err=${err.message}`, {
        action: 'start',
        error: err.message,
      });
      res.status(500).json({ success: false, error: 'UpDown service failed to start' });
    }
  });

  app.post('/api/updown/stop', (req, res) => {
    updownService.stop();
    updownRouteLogger('/api/updown/stop').info('ℹ️ 📊 UpDown service stopped via API', { action: 'stop' });
    res.json({ success: true });
  });

  app.post('/api/updown/restart', (req, res) => {
    updownRouteLogger('/api/updown/restart').info('ℹ️ 🔄 PM2 restart requested via API', { action: 'restart' });
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

  const readTrades = () => {
    const defaultValue = { trades: [], nextId: 1 };
    // Missing or empty file is OK — return default. Corrupt file is an error.
    if (fs.existsSync(TRADES_PATH)) {
      const content = fs.readFileSync(TRADES_PATH, 'utf8');
      if (content && content.trim() !== '') {
        // File exists with content — it must be valid JSON, not silently corrupt.
        try {
          return JSON.parse(content);
        } catch (err) {
          const tmpPath = `${TRADES_PATH}.tmp`;
          const tmpExists = fs.existsSync(tmpPath);
          throw new Error(
            `Trades file is corrupted or incomplete: ${err.message}. ` +
            `Please restore from backup or repair ${TRADES_PATH}.` +
            (tmpExists ? ` A recovery file may exist at ${tmpPath}.` : '')
          );
        }
      }
    }
    return defaultValue;
  };

  const writeTrades = (data) => writeJSON(TRADES_PATH, data);
  app.get('/api/updown/trades', (req, res) => {
    try {
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
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
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
    try {
      const data = readTrades();

      // Auto-capture trade context from service
      const ctx = updownService.getTradeContext?.() ?? {};
      // UP-only: SELL is CLOSE, never a DOWN entry.
      const signalDirection = ctx.latestSignal?.type?.includes('BUY') ? 'up' : null;
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
      updownRouteLogger('/api/updown/trades').info(`ℹ️ 📊 UpDown trade added: id=${trade.id} cost=${trade.cost} return=${trade.returnAmount} pnl=${trade.pnl} dir=${trade.direction}`, {
        action: 'add-trade',
        tradeId: trade.id,
        cost: trade.cost,
        returnAmount: trade.returnAmount,
        pnl: trade.pnl,
        direction: trade.direction,
      });
      res.json({ success: true, trade });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.put('/api/updown/trades/:id', (req, res) => {
    const id = parseInt(req.params.id, 10);
    try {
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
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.delete('/api/updown/trades/:id', (req, res) => {
    const id = parseInt(req.params.id, 10);
    try {
      const data = readTrades();
      const idx = data.trades.findIndex(t => t.id === id);
      if (idx === -1) return res.status(404).json({ success: false, error: 'Trade not found' });
      data.trades.splice(idx, 1);
      writeTrades(data);
      updownRouteLogger('/api/updown/trades/:id').info(`ℹ️ 📊 UpDown trade deleted: id=${id}`, {
        action: 'delete-trade',
        tradeId: id,
      });
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });
};

// Exposed for direct unit testing (issue #215-B) alongside the default
// route-registration export; callers that only need `registerUpdownRoutes(app, deps)`
// are unaffected.
module.exports.readBodyWithLimit = readBodyWithLimit;
module.exports.MAX_SCREENSHOT_BYTES = MAX_SCREENSHOT_BYTES;
module.exports.buildIndicatorTimeframeHeatmap = buildIndicatorTimeframeHeatmap;
module.exports.parseFiniteNumber = parseFiniteNumber;
