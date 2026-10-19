// @ts-check
/**
 * Minimal XML reader for Sentinel RSS/Atom feeds (issue #1175).
 *
 * Feed bodies are attacker-controlled, so this reads only what the poller uses:
 * the element tree, element text (CDATA included), quoted attributes, and the
 * five XML entities plus numeric character references. It is a single forward
 * scan — no backtracking regex runs over markup — and:
 * - never coerces text (`007` stays `007`);
 * - skips DOCTYPE declarations without expanding any entity they declare;
 * - ends the document at unterminated markup, or at nesting deeper than
 *   MAX_DEPTH, instead of throwing;
 * - closes a mismatched end tag back to its matching open ancestor and ignores
 *   end tags with no open match, so one unclosed `<br>` cannot swallow the rest.
 *
 * Text semantics match what the poller saw from fast-xml-parser: each text run
 * is trimmed, CDATA is kept verbatim, and an element's runs are concatenated
 * (child element text is not included in the parent's).
 */

/**
 * @typedef {Object} FeedNode
 * @property {string} name - Element name as written, prefix included (`content:encoded`)
 * @property {Record<string, string>} attrs - Quoted attribute values (null-prototype, read-only when empty)
 * @property {string} text - The element's own text and CDATA content
 * @property {FeedNode[]} children - Child elements in document order
 */

/** Mirrors fast-xml-parser's default `maxNestedTags`; real feeds nest far less. */
const MAX_DEPTH = 100;
/** Shared by every attribute-less element so most nodes allocate no attribute map. */
const NO_ATTRS = Object.freeze(Object.create(null));

const XML_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const ENTITY_REF = /&(?:#(\d{1,7})|#x([0-9a-fA-F]{1,6})|(amp|lt|gt|quot|apos));/g;

/** XML 1.0 `Char` production — references to anything else stay literal. */
const isXmlChar = (cp) => cp === 0x9 || cp === 0xA || cp === 0xD
  || (cp >= 0x20 && cp <= 0xD7FF) || (cp >= 0xE000 && cp <= 0xFFFD) || (cp >= 0x10000 && cp <= 0x10FFFF);

/** Decode the five XML entities and valid numeric references, exactly once. */
const decodeEntities = (raw) => (raw.includes('&') ? raw.replace(ENTITY_REF, (ref, dec, hex, named) => {
  if (named) return XML_ENTITIES[named];
  const cp = dec ? Number(dec) : parseInt(hex, 16);
  return isXmlChar(cp) ? String.fromCodePoint(cp) : ref;
}) : raw);

const isSpace = (c) => c === ' ' || c === '\n' || c === '\t' || c === '\r';

/** Can `c` begin an element name? (ASCII letters, `_`, `:` or any non-ASCII.) */
const isNameStart = (c) => (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_' || c === ':' || c > '\x7f';

/** Does `c` end an element or attribute name? */
const endsName = (c) => isSpace(c) || c === '>' || c === '/' || c === '=' || c === '"' || c === "'";

/** Does the `<` at `i` start markup (as opposed to a stray literal `<`)? */
const startsMarkup = (s, i) => {
  const next = s[i + 1];
  return next === '/' || next === '!' || next === '?' || isNameStart(next);
};

/**
 * Index just past a `<!...>` declaration, internal DOCTYPE subset included
 * (quoted strings and comments inside it may contain `]` or `>`), or -1 when
 * it is unterminated.
 */
const skipDeclaration = (s, from) => {
  let inSubset = false;
  for (let i = from; i < s.length; i++) {
    const c = s[i];
    if (c === '"' || c === "'") {
      i = s.indexOf(c, i + 1);
      if (i === -1) return -1;
    } else if (inSubset && s.startsWith('<!--', i)) {
      i = s.indexOf('-->', i + 4);
      if (i === -1) return -1;
      i += 2;
    } else if (c === '[') inSubset = true;
    else if (c === ']') inSubset = false;
    else if (c === '>' && !inSubset) return i + 1;
  }
  return -1;
};

/**
 * Read a start tag whose name begins at `from` (just past `<`). Valueless and
 * unquoted attributes are skipped; a repeated attribute keeps its last value.
 * @returns {{ name: string, attrs: Record<string, string>, selfClosing: boolean, end: number } | null}
 *   null when the tag (or one of its quoted values) is unterminated
 */
const readStartTag = (s, from) => {
  let i = from;
  while (i < s.length && !endsName(s[i])) i++;
  const name = s.slice(from, i);
  /** @type {Record<string, string>} */
  let attrs = NO_ATTRS;
  while (i < s.length) {
    const c = s[i];
    if (c === '>') return { name, attrs, selfClosing: false, end: i + 1 };
    if (c === '/' && s[i + 1] === '>') return { name, attrs, selfClosing: true, end: i + 2 };
    if (c === '"' || c === "'") {
      // A quoted value with no `name=` before it: skip it whole.
      i = s.indexOf(c, i + 1);
      if (i === -1) return null;
      i++;
      continue;
    }
    if (endsName(c)) { i++; continue; }

    const nameStart = i;
    while (i < s.length && !endsName(s[i])) i++;
    const attrName = s.slice(nameStart, i);
    while (i < s.length && isSpace(s[i])) i++;
    if (s[i] !== '=') continue;
    i++;
    while (i < s.length && isSpace(s[i])) i++;
    const quote = s[i];
    if (quote === '"' || quote === "'") {
      const close = s.indexOf(quote, i + 1);
      if (close === -1) return null;
      if (attrs === NO_ATTRS) attrs = Object.create(null);
      attrs[attrName] = decodeEntities(s.slice(i + 1, close).trim());
      i = close + 1;
    }
  }
  return null;
};

/**
 * Parse a feed document. Never throws.
 * @param {string} xml - Untrusted feed body
 * @returns {{ root: FeedNode | null, unclosed: Set<FeedNode> }} The first root
 *   element (null when there is none) and the elements still open when the
 *   document ended — a truncated body leaves its last item here.
 */
const parseFeedXml = (xml) => {
  const s = typeof xml === 'string' ? xml : '';
  /** @type {FeedNode | null} */
  let root = null;
  /** @type {FeedNode[]} */
  const stack = [];
  const appendText = (value) => {
    if (value && stack.length) stack[stack.length - 1].text += value;
  };

  let i = 0;
  while (i < s.length && !(root && stack.length === 0)) {
    let lt = s.indexOf('<', i);
    while (lt !== -1 && !startsMarkup(s, lt)) lt = s.indexOf('<', lt + 1);
    appendText(decodeEntities(s.slice(i, lt === -1 ? s.length : lt).trim()));
    if (lt === -1) break;

    if (s.startsWith('<!--', lt)) {
      const close = s.indexOf('-->', lt + 4);
      if (close === -1) break;
      i = close + 3;
    } else if (s.startsWith('<![CDATA[', lt)) {
      const close = s.indexOf(']]>', lt + 9);
      if (close === -1) break;
      appendText(s.slice(lt + 9, close));
      i = close + 3;
    } else if (s[lt + 1] === '?') {
      const close = s.indexOf('?>', lt + 2);
      if (close === -1) break;
      i = close + 2;
    } else if (s[lt + 1] === '!') {
      i = skipDeclaration(s, lt + 2);
      if (i === -1) break;
    } else if (s[lt + 1] === '/') {
      const close = s.indexOf('>', lt + 2);
      if (close === -1) break;
      const name = s.slice(lt + 2, close).trim();
      // At most MAX_DEPTH steps, so even a flood of stray end tags stays linear.
      let open = stack.length - 1;
      while (open >= 0 && stack[open].name !== name) open--;
      if (open !== -1) stack.length = open;
      i = close + 1;
    } else {
      const tag = stack.length < MAX_DEPTH ? readStartTag(s, lt + 1) : null;
      if (!tag) break;
      /** @type {FeedNode} */
      const node = { name: tag.name, attrs: tag.attrs, text: '', children: [] };
      if (stack.length) stack[stack.length - 1].children.push(node);
      else root = node;
      if (!tag.selfClosing) stack.push(node);
      i = tag.end;
    }
  }
  return { root, unclosed: new Set(stack) };
};

/**
 * First child element called `name`.
 * @param {FeedNode | null | undefined} node
 * @param {string} name
 * @returns {FeedNode | null}
 */
const child = (node, name) => node?.children.find(c => c.name === name) ?? null;

/**
 * Every child element called `name`.
 * @param {FeedNode | null | undefined} node
 * @param {string} name
 * @returns {FeedNode[]}
 */
const children = (node, name) => (node ? node.children.filter(c => c.name === name) : []);

/**
 * An element's own text ('' when the element is absent).
 * @param {FeedNode | null | undefined} node
 * @returns {string}
 */
const text = (node) => node?.text ?? '';

module.exports = { parseFeedXml, child, children, text };
