// @ts-check
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createIPCServer } = require('../src/ipc/ipc-server');
const { fetchFeed } = require('../src/sentinel/feed-poller');

// ---------------------------------------------------------------------------
// #314 — the non-core modules (routes, updown, sentinel, ipc, caches, notifier)
// log through the canonical context logger, so every operator-visible line keeps
// its original text AND carries structured context for centralized sinks.
// #253 covered the core trading modules; this suite guards the rest.
// ---------------------------------------------------------------------------

/** Every source file that must be free of console.* and the bare log() helper. */
const GUARDED_SOURCES = [
  '../src/routes/ai-routes.js',
  '../src/routes/backtest-routes.js',
  '../src/routes/exchange-routes.js',
  '../src/routes/keys-routes.js',
  '../src/routes/legacy-routes.js',
  '../src/routes/regime-routes.js',
  '../src/routes/sentinel-routes.js',
  '../src/routes/settings-routes.js',
  '../src/routes/updown-routes.js',
  '../src/updown/scorecard.js',
  '../src/updown/updown-service.js',
  '../src/ipc/ipc-client.js',
  '../src/ipc/ipc-server.js',
  '../src/sentinel/classifier.js',
  '../src/sentinel/feed-poller.js',
  '../src/sentinel/sentinel-service.js',
  '../src/candle-cache.js',
  '../src/long-term-candle-store.js',
  '../src/notifier.js',
];

const readSource = relativePath =>
  fs.readFileSync(path.join(__dirname, relativePath), 'utf8');

/** Split a rendered log line into its message and its trailing JSON context. */
const contextFor = (lines, prefix) => {
  const line = lines.find(candidate => candidate.startsWith(prefix));
  assert.ok(line, `missing log line starting with: ${prefix}`);
  const contextStart = line.lastIndexOf(' {');
  assert.notEqual(contextStart, -1, `missing structured context: ${line}`);
  return {
    context: JSON.parse(line.slice(contextStart + 1)),
    message: line.slice(0, contextStart),
  };
};

/** Capture everything the logger writes while `run` executes. */
const captureLogs = async (run) => {
  const lines = [];
  const originalLog = console.log;
  console.log = line => lines.push(line);
  try {
    return { result: await run(), lines };
  } finally {
    console.log = originalLog;
  }
};

describe('support module structured logging', () => {
  it('keeps the non-core modules on the canonical context logger', () => {
    for (const relativePath of GUARDED_SOURCES) {
      const source = readSource(relativePath);
      assert.doesNotMatch(source, /\bconsole\.(?:log|warn|error)\b/, relativePath);
      // The log(level, message) helper carries no structured context, in either
      // its bare `log('WARN', …)` or module-qualified `logger.log('WARN', …)`
      // form — these modules must route through createContextLogger instead.
      assert.doesNotMatch(source, /\blog\('(?:INFO|WARN|ERROR)'/, relativePath);
      assert.doesNotMatch(source, /\blogger\.log\('(?:INFO|WARN|ERROR)'/, relativePath);
      assert.match(source, /createContextLogger\(/, relativePath);
    }
  });

  it('never imports the context-free log helper into a migrated module', () => {
    for (const relativePath of GUARDED_SOURCES) {
      const source = readSource(relativePath);
      // `const { log } = require('../logger')` is the shape that reintroduces
      // the unstructured helper; `getLogFile`/`loadTransactionHistory` are fine.
      assert.doesNotMatch(
        source,
        /(?:^|[{,]\s*)log\s*(?:,|\}\s*=\s*require)/m,
        relativePath,
      );
    }
  });

  it('inlines the severity emoji exactly once per migrated message', () => {
    // createContextLogger writes with preserveMessage:true, so each call site
    // owns the emoji log() used to prepend — and must not double one that the
    // message already opens with.
    const severityEmoji = { info: 'ℹ️', warn: '⚠️', error: '❌' };
    let checked = 0;
    for (const relativePath of GUARDED_SOURCES) {
      const source = readSource(relativePath);
      for (const match of source.matchAll(/\.(info|warn|error)\(\s*(?:`|')(ℹ️|⚠️|❌)?/g)) {
        const [text, level, emoji] = match;
        checked++;
        assert.equal(
          emoji,
          severityEmoji[level],
          `${relativePath}: ${text.trim()} must open with ${severityEmoji[level]}`,
        );
        const rest = source.slice(match.index + text.length);
        assert.ok(
          !rest.startsWith(severityEmoji[level]),
          `${relativePath}: ${text.trim()} doubles ${severityEmoji[level]}`,
        );
      }
    }
    // Guard the guard: a regex that silently stopped matching would pass
    // vacuously. #314 migrated 128 call sites across these files.
    assert.ok(checked >= 128, `expected to inspect every migrated call site, saw ${checked}`);
  });

  it('names the module, peer and port on an IPC server lifecycle line', async () => {
    // Port 0 lets the OS pick a free port, so the suite can't collide with a
    // running engine.
    const server = createIPCServer(0, 'coinbase-engine');
    const { lines } = await captureLogs(async () => {
      server.start();
      server.stop();
    });

    const { context, message } = contextFor(lines, 'ℹ️ 🔗 [coinbase-engine] IPC server listening');
    assert.equal(message, 'ℹ️ 🔗 [coinbase-engine] IPC server listening on 127.0.0.1:0');
    assert.deepStrictEqual(context, {
      module: 'ipc-server',
      peer: 'coinbase-engine',
      event: 'listening',
      port: 0,
    });

    const stopped = contextFor(lines, 'ℹ️ 🔗 [coinbase-engine] IPC server stopped');
    assert.deepStrictEqual(stopped.context, {
      module: 'ipc-server',
      peer: 'coinbase-engine',
      event: 'stopped',
      port: 0,
    });
  });

  it('names the feed and error when a sentinel feed fetch fails', async () => {
    // A loopback URL is rejected by safeFetch's SSRF guard before any socket is
    // opened, so this exercises the failure path without touching the network.
    const feed = { name: 'Loopback Feed', url: 'http://127.0.0.1:9/blocked.xml' };
    const { result, lines } = await captureLogs(() => fetchFeed(feed));

    assert.deepStrictEqual(result, []);
    const { context, message } = contextFor(lines, `⚠️ Sentinel: failed to fetch ${feed.name}`);
    assert.equal(message, `⚠️ Sentinel: failed to fetch ${feed.name}: ${context.error}`);
    assert.match(context.error, /^Blocked endpoint/);
    assert.deepStrictEqual(context, {
      module: 'sentinel-feed-poller',
      action: 'fetch-feed',
      feed: feed.name,
      url: feed.url,
      error: context.error,
    });
  });
});
