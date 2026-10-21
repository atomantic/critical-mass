// @ts-check
/**
 * AI run recorder — data/runs/<runId>/{metadata.json,prompt.txt,output.txt}.
 *
 * Executes a prompt against an OpenAI-compatible `/chat/completions` endpoint
 * (streamed when the server supports it) and records the result in the same
 * on-disk layout the former portos-ai-toolkit runner used, so existing run
 * history keeps loading. Runs outlive the request that started them; only an
 * explicit stop, the provider timeout or the process exit ends one early.
 */

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { atomicWriteSync } = require('../durable-write');
const { httpError, DEFAULT_TIMEOUT_MS } = require('./provider-store');

const RUN_ID = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_OUTPUT_CHARS = 2_000_000;
const ERROR_BODY_CHARS = 300;

/** @param {unknown} runId */
const isValidRunId = (runId) => typeof runId === 'string' && RUN_ID.test(runId);

/**
 * Pull text out of one parsed completion payload (stream chunk or full body).
 * @param {any} payload
 * @returns {{ content: string, reasoning: string }}
 */
const completionText = (payload) => {
  const choice = payload?.choices?.[0];
  const part = choice?.delta || choice?.message || {};
  const text = (value) => (typeof value === 'string' ? value : '');
  return { content: text(part.content), reasoning: text(part.reasoning) || text(part.reasoning_content) };
};

/**
 * @param {{
 *   dataDir: string,
 *   providers: ReturnType<typeof import('./provider-store').createProviderStore>,
 *   maxConcurrentRuns?: number,
 *   onRunCompleted?: (metadata: any) => void,
 *   onRunFailed?: (metadata: any) => void,
 * }} options
 */
const createRunRecorder = ({ dataDir, providers, maxConcurrentRuns = 3, onRunCompleted = () => {}, onRunFailed = () => {} }) => {
  const runsPath = path.join(dataDir, 'runs');
  /** @type {Map<string, { controller: AbortController, reason: string | null, done: Promise<void> }>} */
  const active = new Map();

  const runDir = (runId) => path.join(runsPath, runId);
  const writeRunFile = (runId, name, content) => atomicWriteSync(path.join(runDir(runId), name), content);
  const readRunFile = (runId, name) => {
    const file = path.join(runDir(runId), name);
    return isValidRunId(runId) && fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  };
  const readMetadata = (runId) => {
    const content = readRunFile(runId, 'metadata.json');
    return content === null ? null : JSON.parse(content);
  };

  /** Stream (or read) the completion; resolves to the text it produced. */
  const requestCompletion = async (provider, model, prompt, signal) => {
    const response = await providers.allowlistedFetch(`${provider.endpoint}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...providers.authHeaders(provider) },
      signal,
      body: JSON.stringify({ model: model || undefined, messages: [{ role: 'user', content: prompt }], stream: true }),
    });
    if (!response.ok) {
      const body = (await response.text().catch(() => '')).replace(/\s+/g, ' ').trim().slice(0, ERROR_BODY_CHARS);
      throw new Error(`API error: HTTP ${response.status}${body ? ` — ${body}` : ''}`);
    }

    let content = '';
    let reasoning = '';
    const append = (payload) => {
      const text = completionText(payload);
      content += text.content;
      reasoning += text.reasoning;
      if (content.length + reasoning.length > MAX_OUTPUT_CHARS) throw new Error(`Output exceeded ${MAX_OUTPUT_CHARS} characters`);
    };

    // A server that ignores `stream: true` answers with one JSON body.
    if (!(response.headers.get('content-type') || '').includes('text/event-stream')) {
      append(JSON.parse(await response.text()));
    } else if (response.body) {
      const decoder = new TextDecoder();
      let buffered = '';
      const consume = (line) => {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) return;
        const data = trimmed.slice(5).trim();
        if (!data || data === '[DONE]') return;
        let payload;
        try { payload = JSON.parse(data); } catch { return; } // keep-alive or vendor noise
        append(payload);
      };
      for await (const chunk of response.body) {
        buffered += decoder.decode(chunk, { stream: true });
        const lines = buffered.split('\n');
        buffered = lines.pop() ?? '';
        lines.forEach(consume);
      }
      consume(buffered + decoder.decode());
    }
    // Reasoning models may put everything in the reasoning channel.
    return { output: content.trim() ? content : reasoning, hadReasoning: reasoning.length > 0, usedReasoningAsFallback: !content.trim() && !!reasoning.trim() };
  };

  const execute = async (runId, provider, model, prompt, timeoutMs, entry) => {
    const startTime = Date.now();
    const timer = setTimeout(() => {
      entry.reason ??= `Run timed out after ${Math.round(timeoutMs / 1000)}s`;
      entry.controller.abort();
    }, timeoutMs);
    let result = { output: '', hadReasoning: false, usedReasoningAsFallback: false };
    let error = null;
    try {
      result = await requestCompletion(provider, model, prompt, entry.controller.signal);
    } catch (err) {
      error = entry.reason || err.message;
    } finally {
      clearTimeout(timer);
    }

    const metadata = {
      ...readMetadata(runId),
      endTime: new Date().toISOString(),
      duration: Date.now() - startTime,
      exitCode: error ? 1 : 0,
      success: !error,
      error,
      outputSize: Buffer.byteLength(result.output),
      hadReasoning: result.hadReasoning,
      usedReasoningAsFallback: result.usedReasoningAsFallback,
    };
    writeRunFile(runId, 'output.txt', result.output);
    writeRunFile(runId, 'metadata.json', JSON.stringify(metadata, null, 2));
    (error ? onRunFailed : onRunCompleted)(metadata);
  };

  return {
    /**
     * Record a new run and start it in the background.
     * @param {{ providerId?: unknown, model?: unknown, prompt?: unknown, timeout?: unknown }} body
     */
    start(body) {
      const { providerId, model, prompt, timeout } = body;
      if (typeof providerId !== 'string' || !providerId) throw httpError(400, 'providerId is required');
      if (typeof prompt !== 'string' || !prompt.trim()) throw httpError(400, 'prompt is required');
      if (model !== undefined && model !== null && typeof model !== 'string') throw httpError(400, 'model must be a string');
      if (timeout !== undefined && (!Number.isInteger(timeout) || Number(timeout) < 1000 || Number(timeout) > 600000)) {
        throw httpError(400, 'timeout must be 1000-600000 ms');
      }
      const provider = providers.requireUsable(providerId);
      if (!provider.enabled) throw httpError(400, 'Provider is disabled');
      if (active.size >= maxConcurrentRuns) throw httpError(429, `Too many AI runs in progress (limit ${maxConcurrentRuns})`);

      const runId = randomUUID();
      const effectiveModel = model || provider.defaultModel || null;
      const metadata = {
        id: runId,
        type: 'ai',
        providerId,
        providerName: provider.name,
        model: effectiveModel,
        source: 'devtools',
        prompt: prompt.substring(0, 500),
        startTime: new Date().toISOString(),
        endTime: null,
        duration: null,
        exitCode: null,
        success: null,
        error: null,
        outputSize: 0,
      };
      fs.mkdirSync(runDir(runId), { recursive: true });
      writeRunFile(runId, 'prompt.txt', prompt);
      writeRunFile(runId, 'output.txt', '');
      writeRunFile(runId, 'metadata.json', JSON.stringify(metadata, null, 2));

      const entry = { controller: new AbortController(), reason: null, done: Promise.resolve() };
      active.set(runId, entry);
      const timeoutMs = Number(timeout) || provider.timeout || DEFAULT_TIMEOUT_MS;
      entry.done = execute(runId, provider, effectiveModel, prompt, timeoutMs, entry)
        .catch((err) => onRunFailed({ ...metadata, error: `Run could not be recorded: ${err.message}` }))
        .finally(() => active.delete(runId));
      return { runId, status: 'started', metadata };
    },

    /** Abort an active run and wait until its terminal record is written. */
    async stop(runId) {
      const entry = active.get(runId);
      if (!entry) return false;
      entry.reason ??= 'Run stopped by operator';
      entry.controller.abort();
      await entry.done;
      return true;
    },

    get(runId) {
      const metadata = readMetadata(runId);
      return metadata && { ...metadata, isActive: active.has(runId) };
    },

    output: (runId) => readRunFile(runId, 'output.txt'),
    prompt: (runId) => readRunFile(runId, 'prompt.txt'),

    /** Newest first; unreadable records are skipped rather than failing the list. */
    list({ limit = 50, offset = 0, source = 'all' } = {}) {
      const runs = fs.existsSync(runsPath)
        ? fs.readdirSync(runsPath, { withFileTypes: true })
          .filter((entry) => entry.isDirectory() && isValidRunId(entry.name))
          .map((entry) => { try { return { name: entry.name, metadata: readMetadata(entry.name) }; } catch { return null; } })
          // The directory name is the identity; a record naming another path is ignored.
          .filter((record) => record !== null && record.metadata?.id === record.name)
          .map((record) => record.metadata)
          .filter((metadata) => source === 'all' || (metadata.source || 'devtools') === source)
        : [];
      runs.sort((a, b) => Date.parse(b.startTime) - Date.parse(a.startTime));
      return { total: runs.length, runs: runs.slice(offset, offset + limit) };
    },

    remove(runId) {
      if (active.has(runId)) throw httpError(409, 'Stop the run before deleting it');
      if (!isValidRunId(runId) || !fs.existsSync(runDir(runId))) return false;
      fs.rmSync(runDir(runId), { recursive: true, force: true });
      return true;
    },

    removeFailed() {
      const failed = this.list({ limit: Infinity }).runs.filter((run) => run.success === false && !active.has(run.id));
      for (const run of failed) fs.rmSync(runDir(run.id), { recursive: true, force: true });
      return failed.length;
    },
  };
};

module.exports = { createRunRecorder, isValidRunId };
