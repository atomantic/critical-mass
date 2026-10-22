// @ts-check
/**
 * AI Routes — /api/providers and /api/runs.
 *
 * Owned API-provider management and prompt runs for the admin AI Providers
 * page (formerly mounted from portos-ai-toolkit). Only OpenAI-compatible API
 * providers whose origin is listed in AI_ALLOWED_ENDPOINTS can be saved,
 * tested or run; provider secrets are redacted in every response and restored
 * from the stored record when a client echoes the redaction marker back.
 */

const { createContextLogger } = require('../logger');
const { ts } = require('../time-utils');
const { parseAllowedOrigins, redactSecrets } = require('../ai-security');
const { createProviderStore } = require('../ai/provider-store');
const { createRunRecorder, isValidRunId } = require('../ai/run-recorder');
const { asyncRoute, parsePaging } = require('./route-utils');

/**
 * Context logger for the AI routes. These routes are provider-scoped, not
 * market-scoped, so the provider/model ride along per call.
 */
const aiRoutesLogger = createContextLogger({ module: 'ai-routes' });

const DEFAULT_RUN_LIST_LIMIT = 50;

/**
 * @param {import('express').Express} app
 * @param {{ DATA_DIR: string }} sharedDeps
 * @param {{ allowedOrigins?: Set<string>, fetchImpl?: typeof fetch, maxConcurrentRuns?: number }} [options] - injectable for tests
 */
module.exports = (app, { DATA_DIR }, { allowedOrigins = parseAllowedOrigins(), fetchImpl, maxConcurrentRuns = 3 } = {}) => {
  const providers = createProviderStore({ dataDir: DATA_DIR, allowedOrigins, fetchImpl });
  const runs = createRunRecorder({
    dataDir: DATA_DIR,
    providers,
    maxConcurrentRuns,
    onRunCompleted: (metadata) => {
      aiRoutesLogger.info(`ℹ️ [${ts()}] 🤖 AI run completed: ${metadata.providerName}/${metadata.model} (${(metadata.duration / 1000).toFixed(1)}s)`, {
        action: 'run-completed',
        provider: metadata.providerName,
        model: metadata.model,
        durationMs: metadata.duration,
      });
    },
    onRunFailed: (metadata) => {
      aiRoutesLogger.warn(`⚠️ [${ts()}] 🤖 AI run failed: ${metadata.providerName} — ${metadata.error}`, {
        action: 'run-failed',
        provider: metadata.providerName,
        error: String(metadata.error),
      });
    },
  });

  /** @param {import('express').Response} res @param {unknown} body */
  const sendRedacted = (res, body) => res.json(redactSecrets(body));
  /** @param {import('express').Response} res */
  const providerNotFound = (res) => res.status(404).json({ success: false, error: 'Provider not found' });

  // ── Providers ──────────────────────────────────────────────────────────
  // Static segments are registered before /:id so they are never read as IDs.

  app.get('/api/providers', (req, res) => sendRedacted(res, providers.list()));

  app.get('/api/providers/active', (req, res) => sendRedacted(res, providers.getActive()));

  app.put('/api/providers/active', (req, res) => {
    const id = req.body?.id;
    if (!id) return res.status(400).json({ success: false, error: 'Provider ID required' });
    const provider = providers.setActive(id);
    return provider ? sendRedacted(res, provider) : providerNotFound(res);
  });

  app.get('/api/providers/samples', (req, res) => sendRedacted(res, { providers: providers.samples() }));

  app.get('/api/providers/:id', (req, res) => {
    const provider = providers.get(req.params.id);
    return provider ? sendRedacted(res, provider) : providerNotFound(res);
  });

  app.post('/api/providers', (req, res) => {
    res.status(201);
    sendRedacted(res, providers.create(req.body || {}));
  });

  app.put('/api/providers/:id', (req, res) => {
    const provider = providers.update(req.params.id, req.body || {});
    return provider ? sendRedacted(res, provider) : providerNotFound(res);
  });

  app.delete('/api/providers/:id', (req, res) => {
    if (!providers.remove(req.params.id)) return providerNotFound(res);
    return res.status(204).end();
  });

  app.post('/api/providers/:id/test', asyncRoute(async (req, res) => {
    sendRedacted(res, await providers.test(req.params.id));
  }));

  app.post('/api/providers/:id/refresh-models', asyncRoute(async (req, res) => {
    const result = await providers.refreshModels(req.params.id);
    if ('error' in result) return res.status(502).json({ success: false, error: result.error });
    return sendRedacted(res, result.provider);
  }));

  // ── Runs ───────────────────────────────────────────────────────────────

  /** Reject a malformed run ID before it can reach a filesystem path. */
  const withRunId = (handler) => (req, res, next) => (
    isValidRunId(req.params.runId) ? handler(req, res, next) : res.status(400).json({ success: false, error: 'Invalid run ID' })
  );

  app.get('/api/runs', (req, res) => {
    const paging = parsePaging(req.query) || { limit: DEFAULT_RUN_LIST_LIMIT, offset: 0 };
    const source = typeof req.query.source === 'string' ? req.query.source : 'all';
    res.json(runs.list({ ...paging, source }));
  });

  app.post('/api/runs', (req, res) => {
    res.status(202).json(runs.start(req.body || {}));
  });

  app.delete('/api/runs', (req, res) => {
    if (req.query.filter !== 'failed') return res.status(400).json({ success: false, error: 'Only filter=failed is supported for bulk delete' });
    return res.json({ deletedCount: runs.removeFailed() });
  });

  app.get('/api/runs/:runId', withRunId((req, res) => {
    const run = runs.get(req.params.runId);
    return run ? res.json(run) : res.status(404).json({ success: false, error: 'Run not found' });
  }));

  app.get('/api/runs/:runId/output', withRunId((req, res) => {
    const output = runs.output(req.params.runId);
    return output === null ? res.status(404).json({ success: false, error: 'Run not found' }) : res.type('text/plain').send(output);
  }));

  app.get('/api/runs/:runId/prompt', withRunId((req, res) => {
    const prompt = runs.prompt(req.params.runId);
    return prompt === null ? res.status(404).json({ success: false, error: 'Run not found' }) : res.type('text/plain').send(prompt);
  }));

  app.post('/api/runs/:runId/stop', withRunId(asyncRoute(async (req, res) => {
    if (!(await runs.stop(req.params.runId))) return res.status(404).json({ success: false, error: 'Run not found or not active' });
    return res.json({ success: true });
  })));

  app.delete('/api/runs/:runId', withRunId((req, res) => {
    if (!runs.remove(req.params.runId)) return res.status(404).json({ success: false, error: 'Run not found' });
    return res.status(204).end();
  }));
};
