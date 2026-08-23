const fs = require('fs');
const path = require('path');
const { AsyncLocalStorage } = require('async_hooks');

const REDACTED = '[REDACTED]';
const SECRET_KEYS = /(api[-_]?key|authorization|credential|password|private[-_]?key|secret|token)$/i;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const outboundPolicy = new AsyncLocalStorage();
const nativeFetch = globalThis.fetch;
let fetchGuardInstalled = false;

const installFetchGuard = () => {
  if (fetchGuardInstalled) return;
  globalThis.fetch = async (input, init = {}) => {
    const policy = outboundPolicy.getStore();
    if (!policy) return nativeFetch(input, init);

    let url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    let options = { ...init, redirect: 'manual' };
    for (let redirects = 0; redirects <= 5; redirects += 1) {
      if (!policy.allowedOrigins.has(url.origin)) {
        throw new Error(`AI provider redirect origin is not allowlisted: ${url.origin}`);
      }
      const response = await nativeFetch(url, options);
      if (!REDIRECT_STATUSES.has(response.status)) return response;
      const location = response.headers.get('location');
      if (!location) return response;
      if (redirects === 5) throw new Error('AI provider exceeded the redirect limit');

      const nextUrl = new URL(location, url);
      if (!policy.allowedOrigins.has(nextUrl.origin)) {
        throw new Error(`AI provider redirect origin is not allowlisted: ${nextUrl.origin}`);
      }
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
    throw new Error('AI provider exceeded the redirect limit');
  };
  fetchGuardInstalled = true;
};

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

const restoreRedactedValues = (incoming, existing) => {
  if (incoming === REDACTED) return existing;
  if (Array.isArray(incoming)) return incoming.map((value, index) => restoreRedactedValues(value, existing?.[index]));
  if (!incoming || typeof incoming !== 'object') return incoming;
  return Object.fromEntries(Object.entries(incoming).map(([key, value]) => [
    key,
    restoreRedactedValues(value, existing?.[key]),
  ]));
};

const redactJsonResponses = (req, res, next) => {
  const json = res.json.bind(res);
  res.json = (body) => json(redactSecrets(body));
  next();
};

const parseAllowedOrigins = (value = process.env.AI_ALLOWED_ENDPOINTS || '') => new Set(
  value.split(',').map((entry) => entry.trim()).filter(Boolean).map((entry) => new URL(entry).origin)
);

const resolveWorkspace = (requestedPath, roots) => {
  if (requestedPath !== undefined && typeof requestedPath !== 'string') return null;
  const candidatePath = path.resolve(requestedPath || roots[0]);
  if (!fs.existsSync(candidatePath)) return null;
  const candidate = fs.realpathSync(candidatePath);
  const allowed = roots.some((root) => candidate === root || candidate.startsWith(`${root}${path.sep}`));
  return allowed ? candidate : null;
};

const createAiSecurity = ({
  providerService,
  workspaceRoots = (process.env.AI_WORKSPACE_ROOTS || process.cwd()).split(','),
  allowedOrigins = parseAllowedOrigins(),
} = {}) => {
  installFetchGuard();
  const roots = workspaceRoots
    .map((root) => path.resolve(root.trim()))
    .filter((root) => fs.existsSync(root))
    .map((root) => fs.realpathSync(root));
  if (roots.length === 0) throw new Error('AI_WORKSPACE_ROOTS must contain at least one existing directory');

  const validateProvider = (provider) => {
    if (provider?.type === 'cli') return 'CLI providers are disabled because this toolkit version executes them through a shell';
    if (provider?.type !== 'api') return 'Provider type must be api';
    if (!provider.endpoint || !URL.canParse(provider.endpoint)) return 'Provider endpoint must be a valid URL';
    const endpoint = new URL(provider.endpoint);
    if (endpoint.username || endpoint.password) return 'Provider endpoint must not contain credentials';
    const origin = endpoint.origin;
    if (!allowedOrigins.has(origin)) return `Provider endpoint origin is not allowlisted: ${origin}`;
    return null;
  };

  const constrainOutboundRequests = (req, res, next) => outboundPolicy.run({ allowedOrigins }, next);

  const filterProviderSamples = (req, res, next) => {
    if (req.method !== 'GET' || req.path !== '/samples') return next();
    const json = res.json.bind(res);
    res.json = (body) => json({
      ...body,
      providers: Array.isArray(body?.providers)
        ? body.providers.filter((provider) => !validateProvider(provider))
        : body?.providers,
    });
    next();
  };

  const guardProviderMutation = (req, res, next) => {
    const segments = req.path.split('/').filter(Boolean);
    const createsProvider = req.method === 'POST' && segments.length === 0;
    const updatesProvider = ['PUT', 'PATCH'].includes(req.method) && segments.length === 1 && segments[0] !== 'active';
    if (!createsProvider && !updatesProvider) return next();
    const providerId = updatesProvider ? segments[0] : null;
    const existingPromise = providerId ? providerService.getProviderById(providerId) : Promise.resolve(null);
    existingPromise.then((existing) => {
      req.body = restoreRedactedValues(req.body || {}, existing || {});
      const provider = { ...existing, ...req.body };
      const error = validateProvider(provider);
      if (error) return res.status(400).json({ error });
      next();
    }).catch(next);
  };

  const guardProviderExecution = (req, res, next) => {
    const segments = req.path.split('/').filter(Boolean);
    if (req.method !== 'POST' || segments.length !== 2 || !['test', 'refresh-models'].includes(segments[1])) return next();
    providerService.getProviderById(segments[0]).then((provider) => {
      const error = validateProvider(provider);
      if (error) return res.status(400).json({ error });
      next();
    }).catch(next);
  };

  const guardRun = (req, res, next) => {
    if (req.method !== 'POST' || req.path !== '/') return next();
    const workspacePath = resolveWorkspace(req.body?.workspacePath, roots);
    if (!workspacePath) return res.status(400).json({ error: 'Workspace path is outside AI_WORKSPACE_ROOTS' });
    req.body.workspacePath = workspacePath;
    providerService.getProviderById(req.body?.providerId).then((provider) => {
      const error = validateProvider(provider);
      if (error) return res.status(400).json({ error });
      next();
    }).catch(next);
  };

  return { constrainOutboundRequests, filterProviderSamples, guardProviderExecution, guardProviderMutation, guardRun, redactJsonResponses, validateProvider };
};

module.exports = { REDACTED, createAiSecurity, redactSecrets, resolveWorkspace, restoreRedactedValues };
