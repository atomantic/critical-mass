// @ts-check
/**
 * Tests for issue #215-A — the RSS feed poller must run every feed URL
 * through the SSRF guard before fetching, and must never follow a
 * redirect to a private/reserved address either.
 *
 * The assertion is made at the real output boundary (console.log, where the
 * context logger writes) so we can confirm the SSRF guard specifically fired
 * rather than just observing "some error happened". Since #314 the poller logs
 * through createContextLogger, so patching the logger module's exported `log`
 * would no longer intercept anything.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { fetchFeed } = require('../src/sentinel/feed-poller');

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

describe('fetchFeed SSRF guard (issue #215-A)', () => {
  it('refuses to fetch a feed pointing at cloud metadata and returns no items', async () => {
    const { result, lines } = await captureLogs(() =>
      fetchFeed({ name: 'evil-metadata', url: 'http://169.254.169.254/latest/meta-data/' }));

    assert.deepEqual(result, []);
    assert.match(lines.join('\n'), /Blocked/, 'expected the SSRF guard to have fired, not just any fetch failure');
  });

  it('refuses to fetch a feed pointing at an internal engine IPC port', async () => {
    const { result, lines } = await captureLogs(() =>
      fetchFeed({ name: 'evil-ipc', url: 'http://127.0.0.1:5571/' }));

    assert.deepEqual(result, []);
    assert.match(lines.join('\n'), /Blocked/);
  });

  it('never throws — errors are caught and logged, feed is skipped', async () => {
    // fetchAllFeeds relies on fetchFeed never rejecting so one bad feed
    // doesn't take down the whole poll cycle.
    await assert.doesNotReject(() => captureLogs(() => fetchFeed({ name: 'evil', url: 'http://[::1]/' })));
  });
});
