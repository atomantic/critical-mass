const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const path = require('node:path');

const filename = path.resolve(__dirname, '../src/sentinel/feed-poller.js');
const realRequire = createRequire(filename);
const fetchXML = async (xml) => {
  const warnings = [];
  const context = {
    module: { exports: {} }, URL, AbortController, setTimeout, clearTimeout,
    require: (id) => id === '../url-validator'
      ? { safeFetch: async () => ({ ok: true, text: async () => xml }) }
      : id === '../logger'
        ? { createContextLogger: () => ({ warn: (...args) => warnings.push(args) }) }
        : realRequire(id),
  };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), context, { filename });
  const items = await context.module.exports.fetchFeed({ name: 'fixture', url: 'https://example.com/feed' });
  return { items: JSON.parse(JSON.stringify(items)), warnings };
};

describe('feed item normalization', () => {
  it('retains valid RSS items on either side of an invalid date', async () => {
    const { items, warnings } = await fetchXML(`<rss><channel>
      <item><guid>a</guid><title>First</title><pubDate>2026-09-01</pubDate></item>
      <item><guid>bad</guid><title>Bad date</title><pubDate>not-a-date</pubDate></item>
      <item><guid>b</guid><title>Last</title><link>javascript:alert(1)</link></item>
    </channel></rss>`);
    assert.deepEqual(items.map(item => item.guid), ['a', 'b']);
    assert.equal(items[0].pubDate, '2026-09-01T00:00:00.000Z');
    assert.equal(items[1].link, '');
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0][1].action, 'normalize-feed-item');
  });

  it('normalizes Atom text constructs with attributes and numeric RSS text', async () => {
    const { items } = await fetchXML(`<feed><entry><id>atom-1</id>
      <title type="text">News</title><summary type="html">&lt;p&gt;Details&lt;/p&gt;</summary>
      <link href="https://example.com/article"/><updated>2026-09-01</updated>
    </entry></feed>`);
    assert.equal(items.length, 1);
    assert.equal(items[0].title, 'News');
    assert.equal(items[0].description, 'Details');
    const rss = await fetchXML('<rss><channel><item><guid>r</guid><title>123</title><description>456</description></item></channel></rss>');
    assert.equal(rss.items[0].title, '123');
    assert.equal(rss.items[0].description, '456');
  });

  it('skips malformed Atom dates without dropping the remaining entries', async () => {
    const { items } = await fetchXML('<feed><entry><id>bad</id><updated>invalid</updated></entry><entry><id>good</id><title>Valid</title></entry></feed>');
    assert.deepEqual(items.map(item => item.guid), ['good']);
  });
});
