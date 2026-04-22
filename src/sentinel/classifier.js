// @ts-check
/**
 * News Classifier
 *
 * Two-tier classification:
 * 1. Keyword pre-filter (instant, free) with severity mapping
 * 2. Optional AI classification via portos-ai-toolkit providers
 */

const { readFile } = require('fs/promises');
const path = require('path');
const { log } = require('../logger');
const { SENTINEL_DEFAULTS } = require('../config-utils');
const { validateEndpointUrl } = require('../url-validator');

const PROVIDERS_PATH = path.join(__dirname, '..', '..', 'data', 'providers.json');

/**
 * Classify an item using keyword matching
 * @param {Object} item - Normalized feed item
 * @param {Object} [keywords] - Keyword config (critical/warning/info arrays)
 * @returns {{ severity: string, matchedKeywords: string[] } | null}
 */
const classifyByKeywords = (item, keywords = SENTINEL_DEFAULTS.keywords) => {
  const text = `${item.title} ${item.description}`.toLowerCase();
  const matched = { critical: [], warning: [], info: [] };

  for (const [severity, patterns] of Object.entries(keywords)) {
    for (const pattern of patterns) {
      if (text.includes(pattern.toLowerCase())) {
        matched[severity].push(pattern);
      }
    }
  }

  if (matched.critical.length > 0) return { severity: 'critical', matchedKeywords: matched.critical };
  if (matched.warning.length > 0) return { severity: 'warning', matchedKeywords: matched.warning };
  if (matched.info.length > 0) return { severity: 'info', matchedKeywords: matched.info };

  return null;
};

/**
 * AI classification rate limiter state
 */
let aiCallsThisHour = 0;
let aiHourStart = Date.now();

/**
 * Classify an item using AI (optional, rate-limited)
 * @param {Object} item - Normalized feed item
 * @param {{ enabled: boolean, maxPerHour: number }} aiConfig - AI classification config
 * @returns {Promise<{ category: string, severity: string, summary: string, suggestedAction: string } | null>}
 */
const classifyByAI = async (item, aiConfig) => {
  if (!aiConfig?.enabled) return null;

  // Rate limiting
  const now = Date.now();
  if (now - aiHourStart > 3600000) {
    aiCallsThisHour = 0;
    aiHourStart = now;
  }
  if (aiCallsThisHour >= (aiConfig.maxPerHour || 10)) return null;

  try {
    // Load active provider
    const providersData = JSON.parse(await readFile(PROVIDERS_PATH, 'utf8'));
    const providers = providersData.providers || {};
    const activeProvider = Object.values(providers).find(p => p.enabled && p.type === 'api');
    if (!activeProvider) return null;

    const prompt = `Classify this financial news item for a crypto/stock trader. Return ONLY valid JSON.

Title: ${item.title}
Description: ${item.description}
Source: ${item.source}

Return:
{
  "category": "<one of: monetary_policy, geopolitical, economic_data, market_event, regulatory, other>",
  "severity": "<one of: critical, warning, info>",
  "summary": "<1-2 sentence summary of market impact>",
  "suggestedAction": "<brief action suggestion for a crypto trader>"
}`;

    // Validate provider endpoint URL to prevent SSRF attacks (includes async DNS check).
    const endpointValidation = await validateEndpointUrl(activeProvider.endpoint);
    if (!endpointValidation.valid) {
      log('WARN', `Sentinel AI classification rejected: unsafe endpoint: ${endpointValidation.error}`);
      return null;
    }

    const headers = { 'Content-Type': 'application/json' };
    if (activeProvider.apiKey) headers['Authorization'] = `Bearer ${activeProvider.apiKey}`;

    const response = await fetch(`${activeProvider.endpoint}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: activeProvider.defaultModel,
        messages: [{ role: 'user', content: prompt }],
        stream: false,
      }),
      signal: AbortSignal.timeout(30000),
    });

    if (!response.ok) return null;

    aiCallsThisHour++;
    const result = await response.json();
    const content = result.choices?.[0]?.message?.content || '';
    const jsonMatch = content.replace(/<think>[\s\S]*?<\/think>/g, '').match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;

    const parsed = JSON.parse(jsonMatch[0]);
    return {
      category: parsed.category || 'other',
      severity: parsed.severity || 'info',
      summary: (parsed.summary || '').slice(0, 300),
      suggestedAction: (parsed.suggestedAction || '').slice(0, 200),
    };
  } catch (err) {
    log('WARN', `Sentinel AI classification failed: ${err.message}`);
    return null;
  }
};

module.exports = { classifyByKeywords, classifyByAI };
