// @ts-check
/**
 * UpDown Dashboard API Routes
 *
 * REST endpoints for the UpDown BTC Options Signal Dashboard.
 * Controls contract config, position tracking, signal engine lifecycle.
 */

const path = require('path');
const fs = require('fs');
const { log } = require('../logger');

const ALLOWED_IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp']);

const ALLOWED_EXTRACTED_KEYS = new Set([
  'currentPrice', 'direction', 'range', 'target', 'stop',
  'expiresIn', 'upPrice', 'downPrice', 'maxProfit', 'maxLoss',
]);

const VISION_PROMPT = `You are analyzing a screenshot from the Crypto.com UpDown Bitcoin options trading screen.

Extract the following data from the screenshot and return ONLY valid JSON (no markdown, no explanation):

{
  "currentPrice": <number - current BTC price shown at top>,
  "direction": "<string - 'Up' or 'Down' - whichever button is highlighted/selected>",
  "range": <number - 500 or 2000 - whichever Contract Range option is selected>,
  "target": <number - the Target price shown in the contract details>,
  "stop": <number - the Stop price shown in the contract details>,
  "expiresIn": "<string - the 'Expires in' value, e.g. '6h 20m'>",
  "upPrice": <number - the price shown under the Up button>,
  "downPrice": <number - the price shown under the Down button>,
  "maxProfit": "<string - e.g. '+$419.50'>",
  "maxLoss": "<string - e.g. '-$580.50'>"
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
  const { updownService, readJSON, DATA_DIR } = deps;
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

    // Convert "Expires in Xh Ym" to absolute ms timestamp
    if (extracted.expiresIn) {
      const match = extracted.expiresIn.match(/(?:(\d+)h)?\s*(?:(\d+)m)?/);
      if (match && (match[1] || match[2])) {
        const hours = parseInt(match[1] || '0', 10);
        const minutes = parseInt(match[2] || '0', 10);
        extracted.expiryMs = Date.now() + hours * 3600000 + minutes * 60000;
        extracted.expiryISO = new Date(extracted.expiryMs).toISOString();
      }
    }

    log('INFO', `📸 UpDown screenshot extracted: direction=${extracted.direction} target=${extracted.target} stop=${extracted.stop} range=${extracted.range}`);
    res.json({ success: true, extracted });
  });

  app.get('/api/updown/status', (req, res) => {
    res.json({ success: true, ...updownService.getStatus() });
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

  app.get('/api/updown/signals', (req, res) => {
    const status = updownService.getStatus();
    res.json({ success: true, signals: status.signalHistory });
  });
};
