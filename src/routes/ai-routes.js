/**
 * AI Routes
 *
 * Mounts portos-ai-toolkit Express routes for AI provider management,
 * prompt running, and model selection. Uses dynamic import() because
 * portos-ai-toolkit is ESM and this project is CommonJS.
 *
 * Routes mounted at /api/providers, /api/runs, /api/prompts.
 */

const { Router } = require('express');
const path = require('path');
const { createContextLogger } = require('../logger');
const { ts } = require('../time-utils');
const { createAiSecurity } = require('../ai-security');

/**
 * Context logger for the AI toolkit mount. These routes are provider-scoped,
 * not market-scoped, so the provider/model ride along per call.
 */
const aiRoutesLogger = createContextLogger({ module: 'ai-routes' });

module.exports = (app, sharedDeps) => {
  const { io } = sharedDeps;

  // Mount a placeholder router synchronously so it sits in the right
  // position (before the API catch-all). Sub-routes are populated async.
  const aiRouter = Router();
  app.use('/api', aiRouter);

  // Async load ESM portos-ai-toolkit
  import('portos-ai-toolkit/server').then(({ createAIToolkit }) => {
    const dataDir = path.join(__dirname, '..', '..', 'data');

    // DEFAULT_PROVIDERS_SAMPLE has a wrong path in the toolkit (src/server/defaults/
    // instead of src/defaults/). Resolve the correct path via require.resolve.
    let sampleProvidersFile = null;
    try {
      const toolkitSrcDir = path.dirname(require.resolve('portos-ai-toolkit'));
      sampleProvidersFile = path.join(toolkitSrcDir, 'defaults', 'providers.sample.json');
    } catch (_) { /* toolkit not found — samples won't auto-seed */ }

    const toolkit = createAIToolkit({
      dataDir,
      sampleProvidersFile,
      io,
      maxConcurrentRuns: 3,
      // 0.8.4 can silently fall back to a different provider during a run,
      // bypassing endpoint validation for the provider the operator selected.
      enableProviderStatus: false,
      hooks: {
        onRunCompleted: (metadata) => {
          aiRoutesLogger.info(`ℹ️ [${ts()}] 🤖 AI run completed: ${metadata.providerName}/${metadata.model} (${(metadata.duration / 1000).toFixed(1)}s)`, {
            action: 'run-completed',
            provider: metadata.providerName,
            model: metadata.model,
            durationMs: metadata.duration,
          });
        },
        onRunFailed: (metadata, error) => {
          aiRoutesLogger.warn(`⚠️ [${ts()}] 🤖 AI run failed: ${metadata.providerName} — ${error}`, {
            action: 'run-failed',
            provider: metadata.providerName,
            error: String(error),
          });
        }
      }
    });

    const security = createAiSecurity({ providerService: toolkit.services.providers });

    aiRouter.use('/providers', security.constrainOutboundRequests, security.filterProviderSamples, security.redactJsonResponses, security.guardProviderMutation, security.guardProviderExecution, toolkit.routes.providers);
    aiRouter.use('/runs', security.constrainOutboundRequests, security.guardRun, toolkit.routes.runs);
    aiRouter.use('/prompts', toolkit.routes.prompts);

    aiRoutesLogger.info(`ℹ️ [${ts()}] 🤖 AI toolkit routes mounted at /api/providers, /api/runs, /api/prompts`, {
      action: 'mount',
      routes: ['/api/providers', '/api/runs', '/api/prompts'],
    });
  }).catch(err => {
    aiRoutesLogger.warn(`⚠️ [${ts()}] ⚠️ AI toolkit failed to load: ${err.message}`, {
      action: 'mount',
      error: err.message,
    });
  });
};
