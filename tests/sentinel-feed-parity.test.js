// @ts-check
/**
 * Sentinel feed normalization parity (issue #1175). Every fixture under
 * tests/fixtures/sentinel-feeds was run through fetchFeedOutcome while it still
 * used fast-xml-parser, and the result was recorded in
 * recorded-normalization.json. The owned parser must reproduce that recording
 * exactly, except for the documented fixes below.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { spawnSync } = require('node:child_process');

const FIXTURES = path.join(__dirname, 'fixtures', 'sentinel-feeds');
const { fixtures: RECORDED } = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'recorded-normalization.json'), 'utf8'));
/** Recorded placeholder for a pubDate defaulted to the fetch time. */
const NOW = '<now>';

/**
 * Per-item field overrides where the recording was wrong: fast-xml-parser
 * coerced numeric/boolean-looking text (`007` → 7, `true` → '' and a numeric
 * guid became a number, which no longer matched its persisted string key after
 * a restart) and left numeric character references undecoded.
 * Every field not listed must match the recording exactly.
 */
const DOCUMENTED_FIXES = {
  'rss-numeric.xml': [
    { guid: '0042', title: '007', description: '0x1F' },
    { guid: '12345', title: '1e5', description: '-3.50' },
    { guid: 'false', title: 'true', description: '2026', pubDate: '2026-01-01T00:00:00.000Z' },
  ],
  'atom-numeric.xml': [{ guid: '000123', title: '1.10', description: '1e3' }],
  'rss-entities.xml': [{}, { title: 'Powell’s remarks — full text', description: 'Café &nbsp; &copy; unknown' }],
};

const expectedFor = (name) => {
  const recorded = RECORDED[name];
  const fixes = DOCUMENTED_FIXES[name] || [];
  return { ...recorded, items: recorded.items.map((item, i) => ({ ...item, ...fixes[i] })) };
};

const filename = path.resolve(__dirname, '../src/sentinel/feed-poller.js');
const realRequire = createRequire(filename);

/** Run fetchFeedOutcome over `xml` with the network and logger stubbed out. */
const fetchOutcome = async (xml) => {
  const warnings = [];
  const context = {
    module: { exports: {} }, URL, AbortController, setTimeout, clearTimeout,
    require: (id) => id === '../url-validator'
      ? { safeFetch: async () => ({ ok: true, text: async () => xml }) }
      : id === '../logger'
        ? { createContextLogger: () => ({ warn: (_message, meta) => warnings.push(meta?.action) }) }
        : realRequire(id),
  };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), context, { filename });
  const before = Date.now();
  const outcome = JSON.parse(JSON.stringify(
    await context.module.exports.fetchFeedOutcome({ name: 'fixture', url: 'https://example.com/feed' })));
  const after = Date.now();
  for (const item of outcome.items) {
    const at = Date.parse(item.pubDate);
    if (at >= before && at <= after) item.pubDate = NOW;
  }
  return { ...outcome, warnings };
};

describe('Sentinel feed normalization parity (issue #1175)', () => {
  const fixtureNames = fs.readdirSync(FIXTURES).filter(name => /\.(xml|html)$/.test(name)).sort();

  it('has a recording for every fixture', () => {
    assert.deepEqual(fixtureNames, Object.keys(RECORDED).sort());
  });

  for (const name of fixtureNames) {
    it(`reproduces the recorded normalization of ${name}`, async () => {
      const actual = await fetchOutcome(fs.readFileSync(path.join(FIXTURES, name), 'utf8'));
      assert.deepEqual(actual, expectedFor(name));
    });
  }
});

describe('Sentinel feed malformed documents (issue #1175)', () => {
  it('keeps complete items of a truncated feed and drops the item cut off mid-way', async () => {
    for (const tail of ['<item><title>Trading ha', '<item><guid>cut</guid><tit', '<item><title><![CDATA[Trading']) {
      const outcome = await fetchOutcome(`<rss><channel><item><guid>a</guid><title>Kept</title></item>${tail}`);
      assert.equal(outcome.ok, true, tail);
      assert.deepEqual(outcome.items.map(item => item.guid), ['a'], tail);
    }
  });

  it('keeps every item when only the trailing container tags are missing', async () => {
    const outcome = await fetchOutcome('<feed><entry><id>1</id></entry><entry><id>2</id></entry>');
    assert.deepEqual(outcome.items.map(item => item.guid), ['1', '2']);
  });

  it('reports a document with no recognizable feed root as a parse failure', async () => {
    for (const body of ['', 'plain text', '<!-- never closed', '<rss>text only</rss>', '<atom:feed><atom:entry/></atom:feed>']) {
      const outcome = await fetchOutcome(body);
      assert.deepEqual([outcome.ok, outcome.failure, outcome.warnings], [false, 'parse', ['parse-feed']], body);
    }
  });

  it('does not expand DOCTYPE entities into feed items', async () => {
    const outcome = await fetchOutcome('<!DOCTYPE rss [<!ENTITY a "AAAAAAAAAA"><!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;">]>'
      + '<rss><channel><item><guid>e</guid><title>&b;</title></item></channel></rss>');
    assert.equal(outcome.items[0].title, '&b;');
  });
});

describe('Sentinel bounded description normalization (issue #1727)', () => {
  it('preserves tag stripping, literal brackets, whitespace and XML text semantics', async () => {
    const cases = [
      ['<![CDATA[ \t<b>Hello</b> <i>world</i>\n ]]>', 'Hello world'],
      ['<![CDATA[ <> <<b>kept</b> <unfinished ]]>', '<> kept <unfinished'],
      ['<![CDATA[ < << unfinished ]]>', '< << unfinished'],
      ['&lt;b&gt;Decoded&lt;/b&gt; &amp; &#65;', 'Decoded & A'],
      ['<![CDATA[ &lt;b&gt;literal&lt;/b&gt; &amp; ]]>', '&lt;b&gt;literal&lt;/b&gt; &amp;'],
      ['<![CDATA[\uFEFF \t<b></b> \n]]>', ''],
      [`<![CDATA[${'x'.repeat(499)}   <b></b> ]]>`, 'x'.repeat(499)],
      [`<![CDATA[${'x'.repeat(499)}   <b>y</b>]]>`, `${'x'.repeat(499)} `],
      [`<![CDATA[${'x'.repeat(600)}]]>`, 'x'.repeat(500)],
    ];
    for (const [body, expected] of cases) {
      const outcome = await fetchOutcome(`<rss><channel><item><description>${body}</description></item></channel></rss>`);
      assert.equal(outcome.ok, true);
      assert.equal(outcome.items[0].description, expected, body);
    }
  });

  it('normalizes hostile RSS/Atom primary and fallback descriptions within a child watchdog', () => {
    // The old regex takes quadratic time on this complete, sub-MiB XML body.
    // A separate process bounds failure even while synchronous matching stalls.
    const script = `
      const assert = require('node:assert/strict');
      const fs = require('node:fs');
      const vm = require('node:vm');
      const { createRequire } = require('node:module');
      const filename = process.argv[1];
      const realRequire = createRequire(filename);
      const NOW = '<now>';
      const fetchOutcome = ${fetchOutcome.toString()};
      (async () => {
        const hostile = '<'.repeat(512 * 1024);
        for (const [root, container, item, id, field, emptyPrimary] of [
          ['rss', 'channel', 'item', 'guid', 'description', ''],
          ['rss', 'channel', 'item', 'guid', 'content:encoded', '<description/>'],
          ['feed', '', 'entry', 'id', 'summary', ''],
          ['feed', '', 'entry', 'id', 'content', '<summary/>'],
        ]) {
          const items = '<' + item + '><' + id + '>hostile</' + id + '>' + emptyPrimary
            + '<' + field + '><![CDATA[' + hostile + ']]></' + field + '></' + item + '>'
            + '<' + item + '><' + id + '>neighbor</' + id + '><title>Healthy</title></' + item + '>';
          const xml = '<' + root + '>' + (container ? '<' + container + '>' : '') + items
            + (container ? '</' + container + '>' : '') + '</' + root + '>';
          const outcome = await fetchOutcome(xml);
          assert.equal(outcome.ok, true, field);
          assert.deepEqual(outcome.items.map(item => item.guid), ['hostile', 'neighbor'], field);
          assert.equal(outcome.items[0].description, '<'.repeat(500), field);
          assert.equal(outcome.items[1].title, 'Healthy', field);
          assert.deepEqual(outcome.warnings, [], field);
        }
      })().catch(error => { console.error(error); process.exitCode = 1; });
    `;
    const child = spawnSync(process.execPath, ['-e', script, filename], { encoding: 'utf8', timeout: 10000 });
    assert.ifError(child.error);
    assert.equal(child.status, 0, child.stderr || child.stdout);
  });
});
