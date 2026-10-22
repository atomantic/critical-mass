// @ts-check
/**
 * UpDown AI-vision client.
 *
 * Builds and sends the OpenAI-compatible vision request that extracts contract
 * fields from an UpDown screenshot, then parses and sanitizes the model reply.
 * Screenshots are processed from memory only and never persisted. No Express
 * dependency: the route validates the HTTP request and shapes the response.
 */

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


const ALLOWED_EXTRACTED_KEYS = new Set([
  'screenType', 'currentPrice', 'direction', 'range', 'target', 'stop',
  'expiresIn', 'upPrice', 'downPrice', 'maxProfit', 'maxLoss',
  'contractPrice', 'contracts', 'maxProfitAmount', 'maxLossAmount',
  'youPay', 'priceToClose', 'unrealizedPnl', 'entryPrice', 'expiresOn',
]);

const EXTRACTED_NUMERIC_KEYS = new Set([
  'currentPrice', 'range', 'target', 'stop', 'upPrice', 'downPrice',
  'contractPrice', 'contracts', 'maxProfitAmount', 'maxLossAmount',
  'youPay', 'priceToClose', 'unrealizedPnl', 'entryPrice',
]);
const EXTRACTED_STRING_KEYS = new Set(['expiresIn', 'expiresOn', 'maxProfit', 'maxLoss']);
const EXTRACTED_SCREEN_TYPES = new Set(['select', 'order', 'position']);
const EXTRACTED_DIRECTIONS = new Set(['Up', 'Down']);

/**
 * Keep model-produced screenshot fields inside the types expected by the UI.
 * Invalid or unreadable values are represented as null, matching the prompt.
 * @param {unknown} value
 * @returns {Record<string, unknown>}
 */
const sanitizeExtractedFields = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};

  const extracted = {};
  for (const [key, raw] of Object.entries(value)) {
    if (!ALLOWED_EXTRACTED_KEYS.has(key)) continue;
    if (raw == null) {
      extracted[key] = null;
    } else if (EXTRACTED_NUMERIC_KEYS.has(key)) {
      const number = parseFiniteNumber(raw);
      extracted[key] = Number.isFinite(number) && (key === 'unrealizedPnl' || number > 0) ? number : null;
    } else if (EXTRACTED_STRING_KEYS.has(key)) {
      extracted[key] = typeof raw === 'string' && raw.length <= 64 ? raw : null;
    } else if (key === 'screenType') {
      extracted[key] = typeof raw === 'string' && EXTRACTED_SCREEN_TYPES.has(raw) ? raw : null;
    } else if (key === 'direction') {
      extracted[key] = typeof raw === 'string' && EXTRACTED_DIRECTIONS.has(raw) ? raw : null;
    }
  }
  return extracted;
};

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
 * Strip thinking tags / markdown fences / preamble and parse the first JSON
 * object in a model reply, then sanitize it.
 * @param {string} aiResponse
 * @returns {Record<string, unknown>}
 * @throws {Error} when no JSON object is found or it fails to parse
 */
const parseExtractedResponse = (aiResponse) => {
  let cleaned = aiResponse;
  // Strip <think>...</think> blocks (thinking/reasoning models)
  cleaned = cleaned.replace(/<think>[\s\S]*?<\/think>/g, '');
  // Strip markdown code fences
  cleaned = cleaned.replace(/```json\s*/g, '').replace(/```\s*/g, '');
  // Extract first JSON object from the response
  const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('No JSON object found');
  const raw = JSON.parse(jsonMatch[0]);

  // Sanitize key names and value types before the fields reach expiry
  // conversion or the operator-facing contract and position forms.
  return sanitizeExtractedFields(raw);
};

/**
 * Add `expiryMs` / `expiryISO` to the extracted fields from either the
 * relative "Expires in Xd Xh Ym" or absolute "Expires on Feb 28, 2026 at ..."
 * value. Mutates and returns `extracted`.
 * @param {Record<string, any>} extracted
 * @param {number} [now]
 * @returns {Record<string, any>}
 */
const applyExpiry = (extracted, now = Date.now()) => {
  if (typeof extracted.expiresIn === 'string' && extracted.expiresIn) {
    const match = extracted.expiresIn.match(/(?:(\d+)d)?\s*(?:(\d+)h)?\s*(?:(\d+)m)?/);
    if (match && (match[1] || match[2] || match[3])) {
      const days = parseInt(match[1] || '0', 10);
      const hours = parseInt(match[2] || '0', 10);
      const minutes = parseInt(match[3] || '0', 10);
      const expiryMs = now + days * 86400000 + hours * 3600000 + minutes * 60000;
      const expiryDate = new Date(expiryMs);
      if (Number.isFinite(expiryMs) && Number.isFinite(expiryDate.getTime())) {
        extracted.expiryMs = expiryMs;
        extracted.expiryISO = expiryDate.toISOString();
      }
    }
  }
  if (!extracted.expiryMs && typeof extracted.expiresOn === 'string' && extracted.expiresOn) {
    const ms = new Date(extracted.expiresOn.replace(' at ', ' ')).getTime();
    if (Number.isFinite(ms)) {
      extracted.expiryMs = ms;
      extracted.expiryISO = new Date(ms).toISOString();
    }
  }
  return extracted;
};

/**
 * @typedef {{info: Function, warn: Function, error: Function}} VisionLogger
 * @typedef {{ok: true, extracted: Record<string, any>} | {ok: false, status: number, error: string, raw?: string}} VisionResult
 */

/**
 * @param {{validateEndpointUrl: (url: string) => Promise<{valid: boolean, error?: string}>, safeFetch: Function, allowedOrigins: Set<string>}} deps
 */
const createVisionClient = ({ validateEndpointUrl, safeFetch, allowedOrigins }) => {
  /**
   * Send a screenshot to an OpenAI-compatible vision provider and return the
   * sanitized extracted fields, or an `{ ok:false, status, error }` the route
   * relays verbatim.
   * @param {{provider: Record<string, any>, providerId: string, model: string, imageBuffer: Buffer, mediaType: string, logger: VisionLogger}} args
   * @returns {Promise<VisionResult>}
   */
  const analyzeScreenshot = async ({ provider, providerId, model, imageBuffer, mediaType, logger }) => {
    const base64Image = imageBuffer.toString('base64');
    const headers = { 'Content-Type': 'application/json' };
    if (provider.apiKey) headers['Authorization'] = `Bearer ${provider.apiKey}`;

    const body = {
      model,
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
      logger.warn(`⚠️ 🤖 UpDown screenshot rejected: unsafe endpoint for "${providerId}": ${endpointValidation.error}`, {
        action: 'screenshot',
        provider: providerId,
        error: endpointValidation.error,
      });
      return { ok: false, status: 400, error: 'Provider endpoint is misconfigured. Contact the administrator.' };
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), provider.timeout || 120_000);

    let aiResponse;
    try {
      logger.info(`ℹ️ 🤖 UpDown screenshot → ${providerId}/${model}`, {
        action: 'screenshot',
        provider: providerId,
        model,
      });
      // safeFetch re-validates every redirect target through validateEndpointUrl,
      // strips Authorization on cross-origin redirects, and re-checks the
      // resolved IP at connect time (closes the redirect + TOCTOU SSRF gaps
      // that a bare fetch() would leave open — issue #207).
      const response = await safeFetch(`${provider.endpoint}/chat/completions`, {
        method: 'POST',
        allowedOrigins,
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
          model,
          status: response.status,
        });
        return { ok: false, status: 502, error: `AI provider returned ${response.status}: ${errBody.slice(0, 200)}` };
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
        model,
        ssrfBlocked: isSsrfBlock,
        error: err.message,
      });
      if (isSsrfBlock) {
        return { ok: false, status: 502, error: 'AI provider endpoint is misconfigured. Contact the administrator.' };
      }
      return { ok: false, status: 502, error: `AI request failed: ${err.message}` };
    }

    let extracted;
    try {
      extracted = parseExtractedResponse(aiResponse);
    } catch (err) {
      logger.error(`❌ 🤖 UpDown screenshot parse failed`, {
        action: 'screenshot',
        provider: providerId,
        model,
        error: err.message,
      });
      return { ok: false, status: 422, error: 'AI returned unparseable response', raw: aiResponse.slice(0, 500) };
    }

    applyExpiry(extracted);

    logger.info(`ℹ️ 📸 UpDown screenshot extracted: screenType=${extracted.screenType} direction=${extracted.direction} target=${extracted.target} stop=${extracted.stop} range=${extracted.range}`, {
      action: 'screenshot',
      provider: providerId,
      model,
      screenType: extracted.screenType,
      direction: extracted.direction,
    });
    return { ok: true, extracted };
  };

  return { analyzeScreenshot };
};

module.exports = {
  createVisionClient,
  parseFiniteNumber,
  sanitizeExtractedFields,
  parseExtractedResponse,
  applyExpiry,
  VISION_PROMPT,
};
