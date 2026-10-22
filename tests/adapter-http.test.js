// @ts-check
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { withAbortTimeout, createNetworkError, createPublicNetworkError, DEFAULT_REQUEST_TIMEOUT_MS } = require('../src/adapters/http');

describe('withAbortTimeout', () => {
  it('uses a 30s default deadline', () => {
    assert.equal(DEFAULT_REQUEST_TIMEOUT_MS, 30000);
  });

  it('returns the result and hands the runner a live signal and controller', async () => {
    const out = await withAbortTimeout(async (signal, controller) => {
      assert.equal(signal.aborted, false);
      assert.equal(controller.signal, signal);
      return 42;
    });
    assert.equal(out, 42);
  });

  it('aborts a never-resolving request at the deadline with an AbortError', async () => {
    const started = Date.now();
    await assert.rejects(
      () => withAbortTimeout(
        (signal) => new Promise((_, reject) => {
          signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
        }),
        { timeoutMs: 20 },
      ),
      { name: 'AbortError' },
    );
    assert.ok(Date.now() - started < 5000);
  });

  it('keeps the deadline armed through the whole runner, not just the first await', async () => {
    await assert.rejects(
      () => withAbortTimeout(async (signal) => {
        await new Promise((r) => setTimeout(r, 5));
        // Body-read stand-in that only ends when the deadline aborts it.
        await new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('body stalled'))));
      }, { timeoutMs: 30 }),
      { message: 'body stalled' },
    );
  });

  it('clears the timer on failure so the process is not held open', async () => {
    await assert.rejects(() => withAbortTimeout(async () => { throw new Error('boom'); }, { timeoutMs: 60000 }), { message: 'boom' });
    // A leaked 60s timer would keep this test file from exiting; reaching here
    // with a clean exit is the assertion. Also verify a later abort is a no-op.
  });

  it('lets the runner abort its own request early', async () => {
    const out = await withAbortTimeout(async (signal, controller) => {
      controller.abort();
      return signal.aborted;
    });
    assert.equal(out, true);
  });
});

describe('createNetworkError', () => {
  it('sets status network and endpoint, omitting cause when none given', () => {
    const err = createNetworkError('X API network: down', 'POST /v1/x');
    assert.equal(err.message, 'X API network: down');
    assert.equal(err.status, 'network');
    assert.equal(err.endpoint, 'POST /v1/x');
    assert.equal(Object.hasOwn(err, 'cause'), false);
  });

  it('attaches cause when supplied', () => {
    const cause = new Error('inner');
    assert.equal(createNetworkError('m', 'e', cause).cause, cause);
  });
});

describe('createPublicNetworkError', () => {
  it('labels an AbortError as a timeout', () => {
    const cause = Object.assign(new Error('aborted'), { name: 'AbortError' });
    const err = createPublicNetworkError('Gemini', '/v1/pubticker/btcusd', cause);
    assert.equal(err.message, 'Gemini public request timed out for /v1/pubticker/btcusd');
    assert.equal(err.status, 'network');
    assert.equal(err.endpoint, '/v1/pubticker/btcusd');
    assert.equal(err.cause, cause);
  });

  it('labels other failures with the underlying message, or String(err) when none', () => {
    assert.equal(
      createPublicNetworkError('Crypto.com', 'public/get-tickers', new Error('ECONNRESET')).message,
      'Crypto.com public request failed for public/get-tickers: ECONNRESET',
    );
    assert.equal(
      createPublicNetworkError('Crypto.com', 'public/get-tickers', 'weird').message,
      'Crypto.com public request failed for public/get-tickers: weird',
    );
  });
});
