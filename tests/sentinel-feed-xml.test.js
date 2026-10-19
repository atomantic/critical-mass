// @ts-check
/**
 * Owned RSS/Atom XML reader (issue #1175). Feed bodies are attacker-controlled,
 * so beyond the element tree the poller reads these pin the hostile-input
 * contract: text is never coerced, DOCTYPE entities are never expanded,
 * malformed markup ends the document instead of throwing, and work stays
 * linear in the input size.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { parseFeedXml, child, children, text } = require('../src/sentinel/feed-xml');

/** Text of the first element named `name` under the root. */
const rootText = (xml, name) => text(child(parseFeedXml(xml).root, name));

/** Wall-clock milliseconds taken by `run`. */
const elapsedMs = (run) => {
  const start = process.hrtime.bigint();
  run();
  return Number(process.hrtime.bigint() - start) / 1e6;
};

describe('parseFeedXml element tree', () => {
  it('builds name/attrs/text/children nodes with namespaced names kept literally', () => {
    const { root } = parseFeedXml(`<?xml version="1.0"?>
      <rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/">
        <channel><title>Feed</title>
          <item><title>One</title><content:encoded>Body</content:encoded></item>
          <item/>
        </channel>
      </rss>`);
    assert.equal(root?.name, 'rss');
    assert.deepEqual({ ...root.attrs }, { version: '2.0', 'xmlns:content': 'http://purl.org/rss/1.0/modules/content/' });
    const channel = child(root, 'channel');
    assert.deepEqual(channel.children.map(node => node.name), ['title', 'item', 'item']);
    const items = children(channel, 'item');
    assert.equal(items.length, 2);
    assert.equal(text(child(items[0], 'content:encoded')), 'Body');
    assert.deepEqual(items[1].children, []);
    assert.equal(items[1].text, '');
  });

  it('returns a null root and safe helper results for empty or non-XML input', () => {
    for (const input of ['', 'not xml at all', '   ', undefined, null, 42]) {
      // @ts-ignore deliberately passing non-strings
      assert.equal(parseFeedXml(input).root, null);
    }
    assert.equal(child(null, 'channel'), null);
    assert.deepEqual(children(undefined, 'item'), []);
    assert.equal(text(null), '');
  });

  it('keeps only the first root element and ignores text outside it', () => {
    const { root } = parseFeedXml('﻿junk <rss><channel/></rss> trailing <feed><entry/></feed>');
    assert.equal(root?.name, 'rss');
    assert.equal(root.text, '');
    assert.deepEqual(root.children.map(node => node.name), ['channel']);
  });

  it('is case-sensitive about element names', () => {
    assert.equal(parseFeedXml('<RSS><Channel/></RSS>').root?.name, 'RSS');
    assert.equal(child(parseFeedXml('<rss><Channel/></rss>').root, 'channel'), null);
  });
});

describe('parseFeedXml text', () => {
  it('never coerces numeric or boolean-looking text', () => {
    const xml = '<r><a>007</a><b>1e5</b><c>0x1F</c><d>true</d><e>-3.50</e><f>12345678901234567890</f></r>';
    assert.deepEqual(['a', 'b', 'c', 'd', 'e', 'f'].map(name => rootText(xml, name)),
      ['007', '1e5', '0x1F', 'true', '-3.50', '12345678901234567890']);
  });

  it('trims each text run, keeps CDATA verbatim, and joins runs around children and comments', () => {
    assert.equal(rootText('<r><a>\n   spaced out \n</a></r>', 'a'), 'spaced out');
    assert.equal(rootText('<r><a><![CDATA[  <b>raw</b> &amp;  ]]></a></r>', 'a'), '  <b>raw</b> &amp;  ');
    assert.equal(rootText('<r><a>pre <![CDATA[ mid ]]> post</a></r>', 'a'), 'pre mid post');
    assert.equal(rootText('<r><a>Hello <b>world</b> foo</a></r>', 'a'), 'Hellofoo');
    assert.equal(rootText('<r><a>be<!-- note -->fore</a></r>', 'a'), 'before');
    assert.equal(rootText('<r><a>   </a></r>', 'a'), '');
    assert.equal(rootText('<r><a>\n line one\n line two \n</a></r>', 'a'), 'line one\n line two');
  });

  it('keeps a "<" that does not start markup as literal text', () => {
    assert.equal(rootText('<r><a>1 < 2 and 3 > 2</a></r>', 'a'), '1 < 2 and 3 > 2');
  });

  it('decodes only the five XML entities and valid numeric character references', () => {
    assert.equal(rootText('<r><a>&lt;p&gt; &amp; &quot;q&quot; &apos;s&apos;</a></r>', 'a'), '<p> & "q" \'s\'');
    assert.equal(rootText('<r><a>&#8217; &#x2014; &#65;&#x42;</a></r>', 'a'), '’ — AB');
    assert.equal(rootText('<r><a>&amp;lt; &#38;amp;</a></r>', 'a'), '&lt; &amp;', 'decodes exactly once');
    assert.equal(rootText('<r><a>&nbsp; &copy; &bogus; AT&T & co</a></r>', 'a'), '&nbsp; &copy; &bogus; AT&T & co');
    assert.equal(rootText('<r><a>&#00000039; &#x0000027;</a></r>', 'a'), "' '", 'leading zeros are legal');
    const huge = `&#${'9'.repeat(400)};`;
    assert.equal(rootText(`<r><a>&#0; &#xD800; &#x110000; &#X41; &#99999999; ${huge}</a></r>`, 'a'),
      `&#0; &#xD800; &#x110000; &#X41; &#99999999; ${huge}`, 'invalid or malformed references stay literal');
  });
});

describe('parseFeedXml attributes', () => {
  it('reads double- and single-quoted values, trimmed and entity-decoded', () => {
    const { root } = parseFeedXml('<link rel=\'alternate\' href="  https://ex.com/?a=1&amp;b=2&#38;c  " title="a > b"/>');
    assert.deepEqual({ ...root.attrs }, { rel: 'alternate', href: 'https://ex.com/?a=1&b=2&c', title: 'a > b' });
  });

  it('ignores valueless and unquoted attributes and lets the last duplicate win', () => {
    const { root } = parseFeedXml('<a disabled x=1 y="1" y="2" z = "3">t</a>');
    assert.deepEqual({ ...root.attrs }, { y: '2', z: '3' });
    assert.equal(root.text, 't');
  });

  it('cannot pollute prototypes through attribute names', () => {
    const { root } = parseFeedXml('<a __proto__="polluted" constructor="c" toString="t"/>');
    assert.equal(Object.getPrototypeOf(root.attrs), null);
    assert.equal(root.attrs.__proto__, 'polluted');
    assert.equal(/** @type {any} */ ({}).polluted, undefined);
    assert.equal(root.attrs.toString, 't');
  });
});

describe('parseFeedXml hostile and malformed input', () => {
  it('skips DOCTYPE declarations without expanding their entities', () => {
    const lol = '<!DOCTYPE r [<!ENTITY lol "lol"><!ENTITY lol1 "&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;">'
      + '<!ENTITY lol2 "&lol1;&lol1;&lol1;&lol1;&lol1;&lol1;&lol1;&lol1;&lol1;&lol1;">'
      + '<!ENTITY tricky "a]>b"><!-- ] > --><!ENTITY xxe SYSTEM "file:///etc/passwd">]>'
      + '<r><a>&lol2;</a><b>&xxe;</b></r>';
    const { root } = parseFeedXml(lol);
    assert.equal(root?.name, 'r');
    assert.equal(text(child(root, 'a')), '&lol2;');
    assert.equal(text(child(root, 'b')), '&xxe;');
  });

  it('ends the document at unterminated markup instead of throwing', () => {
    const cases = {
      'truncated start tag': '<rss><channel><item><title>A</title></item><item><tit',
      'unterminated attribute': '<rss><channel><item><title>A</title></item><item><link href="https://ex.com',
      'unterminated CDATA': '<rss><channel><item><title>A</title></item><item><title><![CDATA[abc</title></item></channel></rss>',
      'unterminated comment': '<rss><channel><item><title>A</title></item><!-- abc</channel></rss>',
      'unterminated processing instruction': '<rss><channel><item><title>A</title></item><?pi abc</channel></rss>',
      'unterminated end tag': '<rss><channel><item><title>A</title></item></chan',
    };
    for (const [label, xml] of Object.entries(cases)) {
      const { root } = parseFeedXml(xml);
      const items = children(child(root, 'channel'), 'item');
      assert.equal(text(child(items[0], 'title')), 'A', label);
    }
    assert.equal(parseFeedXml('<!DOCTYPE r [<!ENTITY a "never closed').root, null);
  });

  it('reports elements still open when the document ended', () => {
    const { root, unclosed } = parseFeedXml('<rss><channel><item><title>A</title></item><item><title>Trunc');
    const channel = child(root, 'channel');
    const [done, cut] = children(channel, 'item');
    assert.equal(unclosed.has(done), false);
    assert.equal(unclosed.has(cut), true);
    assert.equal(unclosed.has(channel), true);
    assert.equal(parseFeedXml('<rss><channel/></rss>').unclosed.size, 0);
  });

  it('closes back to the matching ancestor and ignores stray end tags', () => {
    const { root, unclosed } = parseFeedXml(
      '<rss><channel></foo><item><description>Hi<br>there</description></item><item><title>B</title></item></channel></rss>');
    const items = children(child(root, 'channel'), 'item');
    assert.equal(items.length, 2, 'an unclosed <br> must not swallow the following items');
    assert.equal(text(child(items[0], 'description')), 'Hi');
    assert.equal(text(child(items[1], 'title')), 'B');
    assert.equal(unclosed.size, 0);
  });

  it('caps nesting depth at 100 elements and ends the document there', () => {
    /** Length of the first-child chain from the root, root included. */
    const chainLength = (node) => {
      let length = 0;
      for (let at = node; at; at = at.children[0]) length++;
      return length;
    };
    const deep = parseFeedXml(`<r>${'<a>'.repeat(100_000)}${'</a>'.repeat(100_000)}</r>`);
    assert.equal(chainLength(deep.root), 100);
    assert.equal(deep.unclosed.size, 100);
    assert.equal(chainLength(parseFeedXml(`<r>${'<a>'.repeat(99)}${'</a>'.repeat(99)}</r>`).root), 100);
  });

  it('stays linear on stray end tags, entity-dense text and attribute floods', () => {
    let parsed;
    // Sized so a quadratic scan would take far longer than the budget below.
    const stray = `<r>${'<a>'.repeat(99)}${'</b>'.repeat(100_000)}${'</a>'.repeat(99)}</r>`;
    const strayMs = elapsedMs(() => { parsed = parseFeedXml(stray); });
    assert.equal(parsed.unclosed.size, 0);

    const dense = `<r><a>${'&amp;&#65;&bogus;<!---->'.repeat(50_000)}</a></r>`;
    const denseMs = elapsedMs(() => { parsed = parseFeedXml(dense); });
    assert.equal(text(child(parsed.root, 'a')).length, '&A&bogus;'.length * 50_000);

    const flood = `<r>${'<a x="1" y=\'2\' z/>'.repeat(50_000)}</r>`;
    const floodMs = elapsedMs(() => { parsed = parseFeedXml(flood); });
    assert.equal(parsed.root.children.length, 50_000);

    for (const [label, ms] of [['stray end tags', strayMs], ['dense text', denseMs], ['attributes', floodMs]]) {
      assert.ok(ms < 2000, `${label} took ${ms.toFixed(0)}ms`);
    }
  });
});
