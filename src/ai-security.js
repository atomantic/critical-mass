const fs = require('fs');
const path = require('path');

const REDACTED = '[REDACTED]';
const SECRET_KEYS = /(api[-_]?key|authorization|credential|password|private[-_]?key|secret|token)$/i;

const redactSecrets = (value) => {
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, nested]) => [
    key,
    SECRET_KEYS.test(key) && nested ? REDACTED : redactSecrets(nested),
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

  const guardProviderMutation = (req, res, next) => {
    const segments = req.path.split('/').filter(Boolean);
    const createsProvider = req.method === 'POST' && segments.length === 0;
    const updatesProvider = ['PUT', 'PATCH'].includes(req.method) && segments.length === 1 && segments[0] !== 'active';
    if (!createsProvider && !updatesProvider) return next();
    const providerId = updatesProvider ? segments[0] : null;
    const existingPromise = providerId ? providerService.getProviderById(providerId) : Promise.resolve(null);
    existingPromise.then((existing) => {
      if (req.body?.apiKey === REDACTED) delete req.body.apiKey;
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

  return { guardProviderExecution, guardProviderMutation, guardRun, redactJsonResponses, validateProvider };
};

module.exports = { REDACTED, createAiSecurity, redactSecrets, resolveWorkspace };
