// @ts-check
/**
 * AI provider store — data/providers.json.
 *
 * Owns the API-provider subset the admin Providers page uses: CRUD, the
 * active provider, sample providers, a connectivity test and model refresh.
 * Only OpenAI-compatible API providers can be stored or contacted, and every
 * outbound request goes through the AI_ALLOWED_ENDPOINTS allowlist. Legacy CLI
 * records already in the file are still listed (so they can be deleted) but
 * are never executed.
 *
 * File shape (kept compatible with the former portos-ai-toolkit store, which
 * Sentinel and UpDown also read directly):
 *   { "activeProvider": "<id>" | null, "providers": { "<id>": Provider } }
 */

const fs = require('fs');
const path = require('path');
const { atomicWriteSync } = require('../durable-write');
const { createAllowlistedFetch, restoreRedactedValues, validateProvider } = require('../ai-security');

const DEFAULT_SAMPLES_FILE = path.join(__dirname, 'providers.sample.json');
const PROVIDER_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MODEL_FIELDS = ['defaultModel', 'lightModel', 'mediumModel', 'heavyModel'];
const DEFAULT_TIMEOUT_MS = 300000;
const PROBE_TIMEOUT_MS = 15000;

/**
 * @param {number} status
 * @param {string} message
 * @returns {Error & { status: number }}
 */
const httpError = (status, message) => Object.assign(new Error(message), { status });

/**
 * Validate and normalize the client-editable provider fields. Unknown keys are
 * dropped; absent keys stay absent so an update keeps the stored value.
 * @param {Record<string, any>} body
 * @returns {Record<string, any>}
 */
const pickProviderFields = (body) => {
  /** @type {Record<string, any>} */
  const fields = {};
  if (body.name !== undefined) {
    if (typeof body.name !== 'string' || !body.name.trim() || body.name.length > 100) throw httpError(400, 'Name must be 1-100 characters');
    fields.name = body.name.trim();
  }
  if (body.type !== undefined) fields.type = body.type;
  if (body.endpoint !== undefined) {
    if (typeof body.endpoint !== 'string') throw httpError(400, 'Provider endpoint must be a valid URL');
    fields.endpoint = body.endpoint.trim().replace(/\/+$/, '');
  }
  if (body.apiKey !== undefined) {
    if (body.apiKey !== null && typeof body.apiKey !== 'string') throw httpError(400, 'API key must be a string');
    fields.apiKey = body.apiKey || '';
  }
  if (body.models !== undefined) {
    if (!Array.isArray(body.models) || body.models.some((model) => typeof model !== 'string')) throw httpError(400, 'Models must be a list of strings');
    fields.models = [...new Set(body.models.map((model) => model.trim()).filter(Boolean))];
  }
  for (const field of MODEL_FIELDS) {
    if (body[field] === undefined) continue;
    if (body[field] !== null && typeof body[field] !== 'string') throw httpError(400, `${field} must be a string`);
    fields[field] = body[field]?.trim() || null;
  }
  if (body.timeout !== undefined) {
    if (!Number.isInteger(body.timeout) || body.timeout < 1000 || body.timeout > 600000) throw httpError(400, 'Timeout must be 1000-600000 ms');
    fields.timeout = body.timeout;
  }
  if (body.enabled !== undefined) {
    if (typeof body.enabled !== 'boolean') throw httpError(400, 'Enabled must be true or false');
    fields.enabled = body.enabled;
  }
  return fields;
};

/**
 * @param {{ dataDir: string, allowedOrigins: Set<string>, fetchImpl?: typeof fetch, samplesFile?: string }} options
 */
const createProviderStore = ({ dataDir, allowedOrigins, fetchImpl, samplesFile = DEFAULT_SAMPLES_FILE }) => {
  const providersPath = path.join(dataDir, 'providers.json');
  const allowlistedFetch = createAllowlistedFetch(allowedOrigins, fetchImpl);

  // Reads and writes are synchronous, so a read-modify-write never interleaves
  // with another request. A corrupt file throws instead of reading as empty,
  // which would let the next write discard every stored provider.
  const load = () => {
    if (!fs.existsSync(providersPath)) return { activeProvider: null, providers: {} };
    const data = JSON.parse(fs.readFileSync(providersPath, 'utf8'));
    return { activeProvider: data?.activeProvider ?? null, providers: data?.providers && typeof data.providers === 'object' ? data.providers : {} };
  };
  const save = (data) => {
    fs.mkdirSync(dataDir, { recursive: true });
    atomicWriteSync(providersPath, JSON.stringify(data, null, 2));
  };
  /** @returns {any} */
  const find = (data, id) => (typeof id === 'string' && Object.hasOwn(data.providers, id) ? data.providers[id] : null);

  const readSamples = () => {
    const parsed = JSON.parse(fs.readFileSync(samplesFile, 'utf8'));
    return Object.values(parsed.providers || {});
  };

  /** A provider that may be contacted, or a 4xx naming why not. */
  const requireUsable = (id) => {
    const provider = find(load(), id);
    if (!provider) throw httpError(404, 'Provider not found');
    const error = validateProvider(provider, allowedOrigins);
    if (error) throw httpError(400, error);
    return provider;
  };

  const authHeaders = (provider) => (provider.apiKey ? { Authorization: `Bearer ${provider.apiKey}` } : {});

  const fetchModels = async (provider) => {
    const response = await allowlistedFetch(`${provider.endpoint}/models`, {
      headers: authHeaders(provider),
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new Error(`API not reachable: HTTP ${response.status}`);
    }
    const body = await response.json().catch(() => null);
    // OpenAI: { data: [{ id }] }; some servers: { models: ["name"] | [{ name }] }.
    const entries = Array.isArray(body?.data) ? body.data : Array.isArray(body?.models) ? body.models : [];
    return entries
      .map((entry) => (typeof entry === 'string' ? entry : entry?.id || entry?.name || entry?.model))
      .filter((model) => typeof model === 'string' && model);
  };

  return {
    list() {
      const data = load();
      return { activeProvider: data.activeProvider, providers: Object.values(data.providers) };
    },

    get(id) {
      return find(load(), id);
    },

    getActive() {
      const data = load();
      return find(data, data.activeProvider);
    },

    setActive(id) {
      const data = load();
      const provider = find(data, id);
      if (!provider) return null;
      data.activeProvider = id;
      save(data);
      return provider;
    },

    /** Built-in API samples not yet configured whose endpoint is allowlisted. */
    samples() {
      const existing = load().providers;
      return readSamples().filter((sample) => !Object.hasOwn(existing, sample.id) && !validateProvider(sample, allowedOrigins));
    },

    create(body) {
      const data = load();
      if (typeof body.name !== 'string' || !body.name.trim()) throw httpError(400, 'Name must be 1-100 characters');
      const id = body.id ?? body.name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
      if (typeof id !== 'string' || !PROVIDER_ID.test(id)) throw httpError(400, 'Provider ID must be 1-64 letters, digits, dots, dashes or underscores');
      if (Object.hasOwn(data.providers, id)) throw httpError(409, 'Provider with this ID already exists');
      // A sample echoed back from the redacted samples list keeps its own key.
      const sample = readSamples().find((entry) => entry.id === id) || {};
      const provider = {
        id,
        type: 'api',
        endpoint: null,
        apiKey: '',
        models: [],
        defaultModel: null,
        lightModel: null,
        mediumModel: null,
        heavyModel: null,
        timeout: DEFAULT_TIMEOUT_MS,
        enabled: true,
        ...pickProviderFields(restoreRedactedValues(body, sample)),
      };
      const error = validateProvider(provider, allowedOrigins);
      if (error) throw httpError(400, error);
      data.providers[id] = provider;
      if (!data.activeProvider) data.activeProvider = id;
      save(data);
      return provider;
    },

    update(id, body) {
      const data = load();
      const existing = find(data, id);
      if (!existing) return null;
      const provider = { ...existing, ...pickProviderFields(restoreRedactedValues(body, existing)), id };
      const error = validateProvider(provider, allowedOrigins);
      if (error) throw httpError(400, error);
      data.providers[id] = provider;
      save(data);
      return provider;
    },

    remove(id) {
      const data = load();
      if (!find(data, id)) return false;
      delete data.providers[id];
      if (data.activeProvider === id) data.activeProvider = Object.keys(data.providers)[0] ?? null;
      save(data);
      return true;
    },

    /** Contact `${endpoint}/models`; failures are reported, not thrown. */
    async test(id) {
      const provider = requireUsable(id);
      return fetchModels(provider)
        .then((models) => ({ success: true, endpoint: provider.endpoint, models }))
        .catch((error) => ({ success: false, error: error.message }));
    },

    /**
     * Replace the stored model list with the provider's own. An upstream
     * failure is returned as { error } so its reason reaches the operator.
     * @returns {Promise<{ provider: any } | { error: string }>}
     */
    async refreshModels(id) {
      const provider = requireUsable(id);
      const result = await fetchModels(provider).then((models) => ({ models }), (error) => ({ error: error.message }));
      if ('error' in result) return { error: `Model refresh failed: ${result.error}` };
      if (result.models.length === 0) return { error: 'Model refresh failed: the provider listed no models' };
      // Re-read after the network wait so a concurrent edit is not overwritten.
      const data = load();
      const current = find(data, id);
      if (!current) throw httpError(404, 'Provider not found');
      data.providers[id] = { ...current, models: result.models };
      save(data);
      return { provider: data.providers[id] };
    },

    /** Contact-eligible provider for a run (404/400 otherwise). */
    requireUsable,
    authHeaders,
    allowlistedFetch,
  };
};

module.exports = { createProviderStore, httpError, DEFAULT_TIMEOUT_MS };
