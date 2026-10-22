// @ts-check
/**
 * UpDown Dashboard API Routes
 *
 * REST endpoints for the UpDown BTC perp-long signal dashboard.
 * Controls contract config, position tracking, signal engine lifecycle.
 */

const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { createContextLogger } = require('../logger');
const { UPDOWN_DATA_DIR } = require('../paths');
const { validateEndpointUrl, safeFetch } = require('../url-validator');
const { parseAllowedOrigins } = require('../ai-security');
const { parsePaging } = require('./route-utils');
const { createTradeLog } = require('../updown/trade-log');
const { createVisionClient, parseFiniteNumber, sanitizeExtractedFields } = require('../updown/vision-client');
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

/**
 * Operator-entered buy time ("Bought at"). Trades are logged after they close,
 * so the log time is not the entry — this is what the flush-setup calibration
 * needs to line up entries with the chart. Accepts ISO strings or epoch ms;
 * rejects unparseable and future times.
 * @param {unknown} value
 * @param {number} [now]
 * @returns {number|null|undefined} ms, null when invalid, undefined when absent
 */
const parseBoughtAt = (value, now = Date.now()) => {
  if (value == null || value === '') return undefined;
  const ms = typeof value === 'number' ? value : Date.parse(String(value));
  if (!Number.isFinite(ms) || ms > now + 60_000) return null;
  return ms;
};

const parseTradeDate = (value) => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const ms = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === value;
};

const parseTradeTime = (value, now = Date.now()) => {
  if (value == null || value === '') return { absent: true };
  if (typeof value !== 'number' && (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !parseTradeDate(value.slice(0, 10)))) return { error: true };
  const ms = typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isFinite(ms) || Math.abs(ms) > 8.64e15 || ms > now) return { error: true };
  return { ms, iso: new Date(ms).toISOString() };
};

const validateTradeDescription = (body) => {
  if (body.date != null && !parseTradeDate(body.date)) return 'date must be a valid YYYY-MM-DD date';
  if (body.note != null && (typeof body.note !== 'string' || body.note.length > 500)) return 'note must be a string of at most 500 characters';
  if (body.direction != null && body.direction !== 'up' && body.direction !== 'down') return 'direction must be "up" or "down"';
  if (body.exitTime != null) {
    const time = parseTradeTime(body.exitTime);
    if (time.error || time.absent) return 'exitTime must be a valid time that is not in the future';
  }
  return null;
};

// Promisified child_process.execFile (argument array, no shell) for use in async routes
const execFileAsync = promisify(execFile);

// PM2 process names are passed as argv entries, but still constrain them.
const PM2_PROCESS_NAME_RE = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;
const PM2_PREFLIGHT_TIMEOUT_MS = 10_000;

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
 * @param {{updownService: Object, readJSON: Function, DATA_DIR: string, validateEndpointUrl?: Function, safeFetch?: Function, allowedAiOrigins?: Set<string>}} deps
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
    allowedAiOrigins = parseAllowedOrigins(),
  } = deps;
  const PROVIDERS_PATH = path.join(DATA_DIR, 'providers.json');
  const visionClient = createVisionClient({
    validateEndpointUrl: validateEndpointUrlFn,
    safeFetch: safeFetchFn,
    allowedOrigins: allowedAiOrigins,
  });

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
    if (!URL.canParse(provider.endpoint) || !allowedAiOrigins.has(new URL(provider.endpoint).origin)) {
      return res.status(400).json({ success: false, error: 'Provider endpoint origin is not allowlisted in AI_ALLOWED_ENDPOINTS' });
    }

    const selectedModel = model || provider.defaultModel;
    if (!selectedModel) return res.status(400).json({ success: false, error: `No model specified and provider has no defaultModel` });

    const result = await visionClient.analyzeScreenshot({
      provider,
      providerId,
      model: selectedModel,
      imageBuffer,
      mediaType: req.headers['content-type'] || 'image/png',
      logger,
    });
    if (!result.ok) {
      const payload = { success: false, error: result.error };
      if (result.raw !== undefined) payload.raw = result.raw;
      return res.status(result.status).json(payload);
    }
    res.json({ success: true, extracted: result.extracted });
  });

  // --- Scorecard Analysis (historical) ---
  const SCORECARD_DIR = path.join(UPDOWN_DATA_DIR, 'scorecard');

  // The admin page re-polls this endpoint every minute and a day's journal is
  // ~3MB, so reads are async and the newest days are cached by (size, mtime):
  // a cached, unchanged closed day costs one stat() instead of a read +
  // JSON.parse on the gateway event loop. Only the newest MAX_CACHED_DAYS
  // journals are kept, which covers the default 7-day window and bounds memory;
  // older days in the 30-day view are re-read on each request. Stat happens
  // before the read, so a cached entry is never older than its signature; an
  // append in between just forces a re-read next poll.
  const MAX_CACHED_DAYS = 10;
  const dayRecordCache = new Map(); // file (YYYY-MM-DD.jsonl) -> { sig, records }
  let lastAnalysis = null; // { key: file signature, result } for the most recent request

  const parseJSONL = (content) => {
    const records = [];
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
    return records;
  };

  const readDayRecords = async (file) => {
    const filePath = path.join(SCORECARD_DIR, file);
    const { size, mtimeMs } = await fs.promises.stat(filePath);
    const sig = `${size}:${mtimeMs}`;
    const cached = dayRecordCache.get(file);
    if (cached && cached.sig === sig) return { sig, records: cached.records };
    const records = parseJSONL(await fs.promises.readFile(filePath, 'utf-8'));
    dayRecordCache.set(file, { sig, records });
    // Evict the oldest journal date (file names sort chronologically) rather than
    // the least recently used: a 30-day request reads oldest-first, so LRU would
    // push out the recent days before reaching them and re-read all 31 files.
    while (dayRecordCache.size > MAX_CACHED_DAYS) {
      let oldest = null;
      for (const key of dayRecordCache.keys()) if (oldest === null || key < oldest) oldest = key;
      dayRecordCache.delete(oldest);
    }
    return { sig, records };
  };

  const readJSONLFiles = async (from, to) => {
    let entries;
    try {
      entries = await fs.promises.readdir(SCORECARD_DIR);
    } catch (err) {
      if (err.code === 'ENOENT') return { records: [], signature: '' };
      throw err;
    }
    const fromStr = from.toISOString().slice(0, 10);
    const toStr = to.toISOString().slice(0, 10);
    const files = entries
      .filter(f => f.endsWith('.jsonl'))
      .sort()
      .filter(f => {
        const dateStr = f.replace('.jsonl', '');
        return dateStr >= fromStr && dateStr <= toStr;
      });
    const records = [];
    const sigs = [];
    for (const file of files) {
      const day = await readDayRecords(file);
      sigs.push(`${file}@${day.sig}`);
      for (const rec of day.records) records.push(rec);
    }
    return { records, signature: sigs.join('|') };
  };

  app.get('/api/updown/scorecard-analysis', async (req, res) => {
    const now = new Date();
    const fromParam = req.query.from;
    const toParam = req.query.to;

    // Validate from/to date format (YYYY-MM-DD) before parsing
    const dateFormatRegex = /^\d{4}-\d{2}-\d{2}$/;
    if (fromParam && !dateFormatRegex.test(fromParam)) {
      return res.status(400).json({ success: false, error: 'from must be in YYYY-MM-DD format' });
    }
    if (toParam && !dateFormatRegex.test(toParam)) {
      return res.status(400).json({ success: false, error: 'to must be in YYYY-MM-DD format' });
    }

    const to = toParam ? new Date(toParam + 'T23:59:59Z') : now;
    const from = fromParam ? new Date(fromParam + 'T00:00:00Z') : new Date(now.getTime() - 7 * 86400000);

    // Validate that dates parsed successfully
    if (fromParam && Number.isNaN(from.getTime())) {
      return res.status(400).json({ success: false, error: 'from date is invalid' });
    }
    if (toParam && Number.isNaN(to.getTime())) {
      return res.status(400).json({ success: false, error: 'to date is invalid' });
    }

    const { records, signature } = await readJSONLFiles(from, to);
    // buildScorecardAnalysis is pure over the records, and the records are fully
    // determined by the in-range files' names + size + mtime.
    if (!lastAnalysis || lastAnalysis.key !== signature) {
      lastAnalysis = { key: signature, result: buildScorecardAnalysis(records) };
    }
    res.json(lastAnalysis.result);
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
    const { expiry, target, stop, range, direction } = req.body || {};
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
    const { entryPrice, contracts, direction, entryTime } = req.body || {};
    if (!entryPrice || !contracts || !direction) {
      return res.status(400).json({ success: false, error: 'entryPrice, contracts, and direction are required' });
    }
    if (direction !== 'up' && direction !== 'down') {
      return res.status(400).json({ success: false, error: 'direction must be "up" or "down"' });
    }
    const parsedEntryTime = parseTradeTime(entryTime);
    if (parsedEntryTime.error || (Object.hasOwn(req.body || {}, 'entryTime') && parsedEntryTime.absent)) {
      return res.status(400).json({ success: false, error: 'entryTime must be a valid time that is not in the future' });
    }
    // Reject numeric-prefix junk and non-positive values before persistence.
    const px = parseFiniteNumber(entryPrice);
    const qty = parseFiniteNumber(contracts);
    if (!Number.isFinite(px) || px <= 0 || !Number.isFinite(qty) || qty <= 0) {
      return res.status(400).json({ success: false, error: 'entryPrice and contracts must be positive numbers' });
    }
    updownService.setPosition({ entryPrice: px, contracts: qty, direction, entryTime: parsedEntryTime.ms });
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

  app.post('/api/updown/restart', async (req, res) => {
    const processName = process.env.PM2_PROCESS_NAME ?? 'critical-mass';
    const logger = updownRouteLogger('/api/updown/restart');

    logger.info('ℹ️ 🔄 PM2 restart requested via API', { action: 'restart', processName });

    if (!PM2_PROCESS_NAME_RE.test(processName)) {
      logger.error('❌ 🔄 PM2_PROCESS_NAME contains unsupported characters', { action: 'restart-preflight', processName });
      return res.status(500).json({ success: false, error: 'PM2_PROCESS_NAME is invalid — fix the server configuration' });
    }

    // Pre-flight check: verify PM2 is managing this process
    try {
      // A wedged PM2 daemon would otherwise hold this request open forever.
      await execFileAsync('pm2', ['describe', processName], { timeout: PM2_PREFLIGHT_TIMEOUT_MS });
    } catch (err) {
      const errorMsg = err.killed
        ? `PM2 did not respond within ${PM2_PREFLIGHT_TIMEOUT_MS / 1000}s — check the PM2 daemon on the host, then retry`
        : 'PM2 is not managing this process — restart it from the host (see README)';
      logger.error(`❌ 🔄 PM2 pre-flight check failed code=${err.code} err=${err.message}`, {
        action: 'restart-preflight',
        processName,
        error: err.message,
        exitCode: err.code,
      });
      return res.status(503).json({ success: false, error: errorMsg });
    }

    // Pre-flight passed, respond with 202 Accepted
    res.status(202).json({ success: true, message: 'Restarting...' });

    // Schedule the actual restart with error logging
    setTimeout(() => {
      execFile('pm2', ['restart', processName], (err, stdout, stderr) => {
        if (err) {
          const firstLine = stderr?.split('\n')[0] || err.message || 'Unknown error';
          logger.error(`❌ 🔄 PM2 restart failed code=${err.code} stderr=${firstLine}`, {
            action: 'restart-exec',
            processName,
            exitCode: err.code,
            error: err.message,
            stderr,
          });
        } else {
          logger.info('ℹ️ ✅ 🔄 PM2 restart succeeded', {
            action: 'restart-exec',
            processName,
          });
        }
      });
    }, 500);
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

  const tradeLog = createTradeLog({ path: TRADES_PATH, writeJSON });

  app.get('/api/updown/trades', (req, res, next) => {
    try {
      const trades = tradeLog.list();

      const paging = parsePaging(req.query);
      res.json({
        success: true,
        trades: paging ? trades.slice(paging.offset, paging.offset + paging.limit) : trades,
        ...(paging && { total: trades.length, limit: paging.limit, offset: paging.offset }),
        summary: tradeLog.summarize(trades),
      });
    } catch (err) {
      next(err);
    }
  });

  app.post('/api/updown/trades', (req, res, next) => {
    const { date, cost, returnAmount, note, direction: bodyDirection } = req.body || {};
    if (cost == null || returnAmount == null) {
      return res.status(400).json({ success: false, error: 'cost and returnAmount are required' });
    }
    const costNum = parseFiniteNumber(cost);
    const returnNum = parseFiniteNumber(returnAmount);
    if (!Number.isFinite(costNum) || !Number.isFinite(returnNum)) {
      return res.status(400).json({ success: false, error: 'cost and returnAmount must be numbers' });
    }
    const descriptionError = validateTradeDescription(req.body || {});
    if (descriptionError) return res.status(400).json({ success: false, error: descriptionError });
    const exitTime = req.body?.exitTime == null ? null : parseTradeTime(req.body.exitTime).iso;
    const boughtAtMs = parseBoughtAt(req.body?.boughtAt);
    if (boughtAtMs === null) {
      return res.status(400).json({ success: false, error: 'boughtAt must be a valid time that is not in the future' });
    }
    try {
      const trade = tradeLog.add(
        { date, cost: costNum, returnAmount: returnNum, note, direction: bodyDirection, exitTime, boughtAtMs },
        { ctx: updownService.getTradeContext?.() ?? {}, getPriceAt: (ms) => updownService.getPriceAt?.(ms) }
      );
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
      next(err);
    }
  });

  app.put('/api/updown/trades/:id', (req, res, next) => {
    const id = parseInt(req.params.id, 10);
    const body = req.body || {};
    try {
      if (!tradeLog.has(id)) return res.status(404).json({ success: false, error: 'Trade not found' });

      const descriptionError = validateTradeDescription(body);
      if (descriptionError) return res.status(400).json({ success: false, error: descriptionError });

      // Reject non-numeric updates before mutating the trade (issue #151).
      for (const field of ['cost', 'returnAmount', 'btcPriceAtExit']) {
        if (body[field] != null && !Number.isFinite(parseFiniteNumber(body[field]))) {
          return res.status(400).json({ success: false, error: `${field} must be a number` });
        }
      }

      const boughtAtMs = parseBoughtAt(body.boughtAt);
      if (boughtAtMs === null) {
        return res.status(400).json({ success: false, error: 'boughtAt must be a valid time that is not in the future' });
      }

      const trade = tradeLog.update(id, {
        boughtAtMs,
        date: body.date,
        cost: body.cost != null ? parseFiniteNumber(body.cost) : undefined,
        returnAmount: body.returnAmount != null ? parseFiniteNumber(body.returnAmount) : undefined,
        note: body.note,
        direction: body.direction,
        exitTime: body.exitTime != null ? parseTradeTime(body.exitTime).iso : undefined,
        btcPriceAtExit: body.btcPriceAtExit != null ? parseFiniteNumber(body.btcPriceAtExit) : undefined,
      }, { getPriceAt: (ms) => updownService.getPriceAt?.(ms) });
      res.json({ success: true, trade });
    } catch (err) {
      next(err);
    }
  });

  app.delete('/api/updown/trades/:id', (req, res, next) => {
    const id = parseInt(req.params.id, 10);
    try {
      if (!tradeLog.remove(id)) return res.status(404).json({ success: false, error: 'Trade not found' });
      updownRouteLogger('/api/updown/trades/:id').info(`ℹ️ 📊 UpDown trade deleted: id=${id}`, {
        action: 'delete-trade',
        tradeId: id,
      });
      res.json({ success: true });
    } catch (err) {
      next(err);
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
module.exports.parseBoughtAt = parseBoughtAt;
module.exports.sanitizeExtractedFields = sanitizeExtractedFields;
