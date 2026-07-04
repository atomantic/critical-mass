// @ts-check
/**
 * Tests for issue #215-A — the RSS feed poller must run every feed URL
 * through the SSRF guard before fetching, and must never follow a
 * redirect to a private/reserved address either.
 *
 * `log` is mocked (module is required and patched before feed-poller.js
 * is first required, so feed-poller's destructured reference picks up
 * the mock — node:test runs each test file in its own process, so this
 * doesn't leak across files) so we can assert the SSRF guard specifically
 * fired, rather than just observing "some error happened".
 */
const { describe, it, mock } = require('node:test');
const assert = require('node:assert/strict');

const logger = require('../src/logger');
const logCalls = [];
mock.method(logger, 'log', (...args) => { logCalls.push(args); });

const { fetchFeed } = require('../src/sentinel/feed-poller');

describe('fetchFeed SSRF guard (issue #215-A)', () => {
  it('refuses to fetch a feed pointing at cloud metadata and returns no items', async () => {
    logCalls.length = 0;
    const items = await fetchFeed({ name: 'evil-metadata', url: 'http://169.254.169.254/latest/meta-data/' });
    assert.deepEqual(items, []);
    const message = logCalls.map(([, msg]) => msg).join('\n');
    assert.match(message, /Blocked/, 'expected the SSRF guard to have fired, not just any fetch failure');
  });

  it('refuses to fetch a feed pointing at an internal engine IPC port', async () => {
    logCalls.length = 0;
    const items = await fetchFeed({ name: 'evil-ipc', url: 'http://127.0.0.1:5571/' });
    assert.deepEqual(items, []);
    const message = logCalls.map(([, msg]) => msg).join('\n');
    assert.match(message, /Blocked/);
  });

  it('never throws — errors are caught and logged, feed is skipped', async () => {
    // fetchAllFeeds relies on fetchFeed never rejecting so one bad feed
    // doesn't take down the whole poll cycle.
    await assert.doesNotReject(() => fetchFeed({ name: 'evil', url: 'http://[::1]/' }));
  });
});
