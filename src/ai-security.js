// @ts-check
/**
 * AI provider security policy.
 *
 * Pure helpers shared by the owned AI provider/run routes, Sentinel and
 * UpDown: secret redaction for provider JSON, the outbound origin allowlist
 * (AI_ALLOWED_ENDPOINTS), provider eligibility and an allowlisted fetch that
 * re-checks every redirect hop.
 */

const REDACTED = '[REDACTED]';
const SECRET_KEYS = /(api[-_]?key|authorization|credential|password|private[-_]?key|secret|token)$/i;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 5;

/**
 * Replace secret-looking values (and declared secretEnvVars) with REDACTED.
 * @param {any} value
 * @returns {any}
 */
const redactSecrets = (value) => {
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (!value || typeof value !== 'object') return value;
  const declaredSecrets = new Set(Array.isArray(value.secretEnvVars) ? value.secretEnvVars : []);
  return Object.fromEntries(Object.entries(value).map(([key, nested]) => [
    key,
    key === 'envVars' && nested && typeof nested === 'object'
      ? Object.fromEntries(Object.entries(nested).map(([envKey, envValue]) => [
        envKey,
        (declaredSecrets.has(envKey) || SECRET_KEYS.test(envKey)) && envValue ? REDACTED : redactSecrets(envValue),
      ]))
      : SECRET_KEYS.test(key) && nested ? REDACTED : redactSecrets(nested),
  ]));
};

/**
 * Put stored values back wherever a client echoed REDACTED.
 * @param {any} incoming
 * @param {any} existing
 * @returns {any}
 */
const restoreRedactedValues = (incoming, existing) => {
  if (incoming === REDACTED) return existing;
  if (Array.isArray(incoming)) return incoming.map((value, index) => restoreRedactedValues(value, existing?.[index]));
  if (!incoming || typeof incoming !== 'object') return incoming;
  return Object.fromEntries(Object.entries(incoming).map(([key, value]) => [
    key,
    restoreRedactedValues(value, existing?.[key]),
  ]));
};

/**
 * @param {string} [value] - comma-separated origins (defaults to AI_ALLOWED_ENDPOINTS)
 * @returns {Set<string>}
 */
const parseAllowedOrigins = (value = process.env.AI_ALLOWED_ENDPOINTS || '') => new Set(
  value.split(',').map((entry) => entry.trim()).filter(Boolean).map((entry) => new URL(entry).origin)
);

/**
 * Why a provider may not be stored or contacted, or null when it may.
 * @param {any} provider
 * @param {Set<string>} allowedOrigins
 * @returns {string | null}
 */
const validateProvider = (provider, allowedOrigins) => {
  if (provider?.type === 'cli') return 'CLI providers are not supported; configure an API provider';
  if (provider?.type !== 'api') return 'Provider type must be api';
  if (typeof provider.endpoint !== 'string' || !URL.canParse(provider.endpoint)) return 'Provider endpoint must be a valid URL';
  const endpoint = new URL(provider.endpoint);
  if (endpoint.protocol !== 'http:' && endpoint.protocol !== 'https:') return 'Provider endpoint must use http or https';
  if (endpoint.username || endpoint.password) return 'Provider endpoint must not contain credentials';
  if (!allowedOrigins.has(endpoint.origin)) return `Provider endpoint origin is not allowlisted: ${endpoint.origin}`;
  return null;
};

/**
 * A fetch that only contacts allowlisted origins and follows redirects
 * manually, re-checking each hop and dropping Authorization across origins.
 * @param {Set<string>} allowedOrigins
 * @param {typeof fetch} [fetchImpl]
 * @returns {(input: string | URL, init?: RequestInit) => Promise<Response>}
 */
const createAllowlistedFetch = (allowedOrigins, fetchImpl = globalThis.fetch) => async (input, init = {}) => {
  let url = new URL(input);
  /** @type {RequestInit} */
  let options = { ...init, redirect: 'manual' };
  for (let redirects = 0; ; redirects += 1) {
    if (!allowedOrigins.has(url.origin)) {
      throw new Error(`AI provider ${redirects ? 'redirect ' : ''}origin is not allowlisted: ${url.origin}`);
    }
    const response = await fetchImpl(url, options);
    if (!REDIRECT_STATUSES.has(response.status)) return response;
    const location = response.headers.get('location');
    if (!location) return response;
    await response.body?.cancel().catch(() => {});
    if (redirects === MAX_REDIRECTS) throw new Error('AI provider exceeded the redirect limit');

    const nextUrl = new URL(location, url);
    if (response.status === 303 || ((response.status === 301 || response.status === 302) && options.method === 'POST')) {
      options = { ...options, method: 'GET' };
      delete options.body;
    }
    if (nextUrl.origin !== url.origin && options.headers) {
      const headers = new Headers(options.headers);
      headers.delete('authorization');
      options = { ...options, headers };
    }
    url = nextUrl;
  }
};

module.exports = { REDACTED, createAllowlistedFetch, parseAllowedOrigins, redactSecrets, restoreRedactedValues, validateProvider };
