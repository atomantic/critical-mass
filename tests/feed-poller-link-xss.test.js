// @ts-check
/**
 * Tests for issue #395 — RSS/Atom feed items with a non-http(s) link
 * scheme (javascript:, data:, or a relative link) must never survive
 * normalization, since the admin dashboard renders `item.link` directly
 * into an `<a href>`.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { sanitizeLink } = require('../src/sentinel/feed-poller');

describe('sanitizeLink (issue #395)', () => {
  it('passes through http and https links unchanged', () => {
    assert.equal(sanitizeLink('http://example.com/a'), 'http://example.com/a');
    assert.equal(sanitizeLink('https://example.com/a'), 'https://example.com/a');
  });

  it('strips javascript: links', () => {
    assert.equal(sanitizeLink("javascript:fetch('/api/x')"), '');
  });

  it('strips data: links', () => {
    assert.equal(sanitizeLink('data:text/html,<script>alert(1)</script>'), '');
  });

  it('strips relative and empty links', () => {
    assert.equal(sanitizeLink('/relative/path'), '');
    assert.equal(sanitizeLink(''), '');
    assert.equal(sanitizeLink(undefined), '');
    assert.equal(sanitizeLink(null), '');
  });

  it('strips other unsafe schemes (file:, vbscript:)', () => {
    assert.equal(sanitizeLink('file:///etc/passwd'), '');
    assert.equal(sanitizeLink('vbscript:msgbox(1)'), '');
  });
});
