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
const { log } = require('../logger');

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
  if (typeof value === 'number' && value > 0) return value;
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

  app.get('/api/updown/status', (req, res) => {
    res.json({ success: true, ...updownService.getStatus() });
  });

  app.get('/api/updown/scorecard', (req, res) => {
    res.json({ success: true, ...updownService.getScorecard() });
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
    updownService.setPosition({ entryPrice: parseFloat(entryPrice), contracts: parseFloat(contracts), direction, entryTime: req.body.entryTime });
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

  app.get('/api/updown/trades', (req, res) => {
    const data = readTrades();
    const trades = data.trades || [];
    const totalCost = trades.reduce((s, t) => s + (t.cost || 0), 0);
    const totalReturn = trades.reduce((s, t) => s + (t.returnAmount || 0), 0);
    const totalPnl = trades.reduce((s, t) => s + (t.pnl || 0), 0);
    const wins = trades.filter(t => t.pnl > 0).length;
    const losses = trades.filter(t => t.pnl <= 0).length;
    res.json({
      success: true,
      trades,
      summary: { totalCost, totalReturn, totalPnl, wins, losses, count: trades.length },
    });
  });

  app.post('/api/updown/trades', (req, res) => {
    const { date, cost, returnAmount, note } = req.body;
    if (cost == null || returnAmount == null) {
      return res.status(400).json({ success: false, error: 'cost and returnAmount are required' });
    }
    const data = readTrades();
    const trade = {
      id: data.nextId || (data.trades.length + 1),
      date: date || new Date().toISOString().slice(0, 10),
      cost: parseFloat(cost),
      returnAmount: parseFloat(returnAmount),
      pnl: parseFloat(returnAmount) - parseFloat(cost),
      note: note || '',
    };
    data.trades.push(trade);
    data.nextId = trade.id + 1;
    writeTrades(data);
    log('INFO', `📊 UpDown trade added: id=${trade.id} cost=${trade.cost} return=${trade.returnAmount} pnl=${trade.pnl}`);
    res.json({ success: true, trade });
  });

  app.put('/api/updown/trades/:id', (req, res) => {
    const id = parseInt(req.params.id, 10);
    const data = readTrades();
    const trade = data.trades.find(t => t.id === id);
    if (!trade) return res.status(404).json({ success: false, error: 'Trade not found' });

    if (req.body.date != null) trade.date = req.body.date;
    if (req.body.cost != null) trade.cost = parseFloat(req.body.cost);
    if (req.body.returnAmount != null) trade.returnAmount = parseFloat(req.body.returnAmount);
    if (req.body.note != null) trade.note = req.body.note;
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
