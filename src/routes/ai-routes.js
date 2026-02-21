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
const { log } = require('../logger');
const { ts } = require('../time-utils');

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
      enableProviderStatus: true,
      hooks: {
        onRunCompleted: (metadata) => {
          log('INFO', `[${ts()}] 🤖 AI run completed: ${metadata.providerName}/${metadata.model} (${(metadata.duration / 1000).toFixed(1)}s)`);
        },
        onRunFailed: (metadata, error) => {
          log('WARN', `[${ts()}] 🤖 AI run failed: ${metadata.providerName} — ${error}`);
        }
      }
    });

    // Mount providerStatus before providers (so /providers/status isn't caught as a param)
    if (toolkit.routes.providerStatus) {
      aiRouter.use('/providers/status', toolkit.routes.providerStatus);
    }
    aiRouter.use('/providers', toolkit.routes.providers);
    aiRouter.use('/runs', toolkit.routes.runs);
    aiRouter.use('/prompts', toolkit.routes.prompts);

    log('INFO', `[${ts()}] 🤖 AI toolkit routes mounted at /api/providers, /api/runs, /api/prompts`);
  }).catch(err => {
    log('WARN', `[${ts()}] ⚠️ AI toolkit failed to load: ${err.message}`);
  });
};
