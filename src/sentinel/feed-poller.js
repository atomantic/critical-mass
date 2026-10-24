// @ts-check
/**
 * RSS Feed Poller
 *
 * Fetches and parses RSS/Atom feeds, normalizing items to a common format.
 * Handles per-feed errors gracefully (log + skip).
 */

const { createContextLogger } = require('../logger');
const { safeFetch } = require('../url-validator');
const { parseFeedXml, child, children, text } = require('./feed-xml');

/** @typedef {import('./feed-xml').FeedNode} FeedNode */

/** Feed identity is per-call (one poller serves every configured feed). */
const feedPollerLogger = createContextLogger({ module: 'sentinel-feed-poller' });

/**
 * Only allow http(s) links through to storage/display — feed items are
 * attacker-controlled, and a `javascript:`/`data:` link rendered as an
 * `<a href>` in the admin dashboard would execute in the operator's
 * browser session (issue #395).
 * @param {string} link - Raw link from a feed item
 * @returns {string} The link if it is http/https, otherwise ''
 */
const sanitizeLink = (link) => {
  if (!link || typeof link !== 'string') return '';
  if (!URL.canParse(link)) return '';
  const { protocol } = new URL(link);
  return protocol === 'http:' || protocol === 'https:' ? link : '';
};

/** Text of the first `name` child ('' when absent). */
const childText = (node, name) => text(child(node, name));

/** Feed description text: markup stripped, capped at 500 characters. */
const plainDescription = (value) => {
  let result = '';
  let lastTextLength = 0;
  let mayHaveTags = true;
  for (let i = 0; i < value.length; i++) {
    const character = value[i];
    if (mayHaveTags && character === '<') {
      const end = value.indexOf('>', i + 1);
      if (end > i + 1) {
        i = end;
        continue;
      }
      // No closing bracket remains: keep the literal suffix without searching
      // it again for each '<'. Empty '<>' also stays literal, as before.
      if (end === -1) mayHaveTags = false;
    }
    const whitespace = character.trim() === '';
    if (!result.length && whitespace) continue;
    if (!whitespace) {
      if (result.length === 500) return result;
      lastTextLength = result.length + 1;
    }
    if (result.length < 500) result += character;
    if (lastTextLength === 500) return result;
  }
  // Keep scanning after a whitespace-filled cap until text or EOF decides
  // whether those spaces survive trim(). The output buffer stays bounded.
  return result.slice(0, lastTextLength);
};

/** Normalize independently so one malformed item cannot suppress the feed. */
const normalizeItems = (items, normalize, feed) => items.flatMap(item => {
  try {
    return [normalize(item, feed.name)];
  } catch (err) {
    feedPollerLogger.warn(`⚠️ Sentinel: skipping malformed item from ${feed.name}`, {
      action: 'normalize-feed-item', feed: feed.name, url: feed.url, error: err.message,
    });
    return [];
  }
});

/**
 * Normalize an RSS 2.0 item to common format
 * @param {FeedNode} item - RSS <item> element
 * @param {string} sourceName - Feed name
 * @returns {Object} Normalized item
 */
const normalizeRSSItem = (item, sourceName) => {
  const pubDate = childText(item, 'pubDate');
  return {
    guid: childText(item, 'guid') || childText(item, 'link') || `${sourceName}-${childText(item, 'title')}`,
    title: childText(item, 'title').trim(),
    description: plainDescription(childText(item, 'description') || childText(item, 'content:encoded')),
    link: sanitizeLink(childText(item, 'link')),
    pubDate: pubDate ? new Date(pubDate).toISOString() : new Date().toISOString(),
    source: sourceName,
  };
};

/**
 * Normalize an Atom entry to common format
 * @param {FeedNode} entry - Atom <entry> element
 * @param {string} sourceName - Feed name
 * @returns {Object} Normalized item
 */
const normalizeAtomEntry = (entry, sourceName) => {
  const links = children(entry, 'link');
  const link = links.find(l => l.attrs.rel === 'alternate') || links[0];
  const href = link?.attrs.href || text(link);
  const pubDate = childText(entry, 'updated') || childText(entry, 'published');

  return {
    guid: childText(entry, 'id') || href || `${sourceName}-${childText(entry, 'title')}`,
    title: childText(entry, 'title').trim(),
    description: plainDescription(childText(entry, 'summary') || childText(entry, 'content')),
    link: sanitizeLink(href),
    pubDate: pubDate ? new Date(pubDate).toISOString() : new Date().toISOString(),
    source: sourceName,
  };
};

/** Safe, credential-free failure category for public diagnostics. */
const classifyFailure = (err) => {
  if (err?.name === 'AbortError') return 'timeout';
  if (err?.feedFailureCategory) return err.feedFailureCategory;
  if (/^Blocked/.test(err?.message || '')) return 'blocked';
  return 'network';
};

/**
 * Fetch and parse a single feed, reporting whether acquisition succeeded.
 * A valid feed with zero items is a success; transport/HTTP/parse failures are not.
 * @param {{ name: string, url: string }} feed - Feed config
 * @param {number} [timeoutMs=15000] - Request timeout
 * @returns {Promise<{ ok: boolean, items: Object[], feed: string, failure: string|null }>}
 */
const fetchFeedOutcome = async (feed, timeoutMs = 15000) => {
  const ok = (items) => ({ ok: true, items, feed: feed.name, failure: null });
  const failed = (failure) => ({ ok: false, items: [], feed: feed.name, failure });
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    let body;
    try {
      // safeFetch validates the URL (and any redirect target) against the
      // SSRF denylist and re-checks the resolved IP at connect time — a
      // bare fetch() here would follow redirects to internal addresses
      // unchecked (issue #215-A).
      const response = await safeFetch(feed.url, {
        headers: { 'User-Agent': 'CriticalMass-Sentinel/1.0' },
        signal: controller.signal,
      });
      if (!response.ok) {
        throw Object.assign(new Error(`HTTP ${response.status}`), { feedFailureCategory: 'http' });
      }
      body = await response.text();
    } finally {
      clearTimeout(timeout);
    }

    const { root, unclosed } = parseFeedXml(body);
    // An item still open when the body ended was cut off: normalizing it would
    // mark its guid seen with a partial title and suppress the complete alert.
    const complete = (nodes) => nodes.filter(node => !unclosed.has(node));

    // RSS 2.0 (a channel with no items is a successful-empty feed)
    const channel = root?.name === 'rss' ? child(root, 'channel') : null;
    if (channel) return ok(normalizeItems(complete(children(channel, 'item')), normalizeRSSItem, feed));

    // Atom (likewise for a feed with no entries)
    if (root?.name === 'feed') return ok(normalizeItems(complete(children(root, 'entry')), normalizeAtomEntry, feed));

    feedPollerLogger.warn(`⚠️ Sentinel: unrecognized feed format from ${feed.name}`, {
      action: 'parse-feed',
      feed: feed.name,
      url: feed.url,
    });
    return failed('parse');
  } catch (err) {
    feedPollerLogger.warn(`⚠️ Sentinel: failed to fetch ${feed.name}: ${err.message}`, {
      action: 'fetch-feed',
      feed: feed.name,
      url: feed.url,
      error: err.message,
    });
    return failed(classifyFailure(err));
  }
};

/**
 * Fetch and parse a single RSS/Atom feed
 * @param {{ name: string, url: string }} feed - Feed config
 * @param {number} [timeoutMs=15000] - Request timeout
 * @returns {Promise<Object[]>} Normalized items ([] on failure; use fetchFeedOutcome to distinguish)
 */
const fetchFeed = async (feed, timeoutMs = 15000) => (await fetchFeedOutcome(feed, timeoutMs)).items;

/**
 * Fetch all enabled feeds
 * @param {Object[]} feeds - Array of feed configs
 * @returns {Promise<{ items: Object[], enabled: number, succeeded: number, failed: number, failures: Array<{ feed: string, category: string }> }>}
 */
const fetchAllFeeds = async (feeds) => {
  const enabledFeeds = feeds.filter(f => f.enabled !== false);
  const results = await Promise.allSettled(enabledFeeds.map(f => fetchFeedOutcome(f)));

  const items = [];
  const failures = [];
  let succeeded = 0;
  results.forEach((result, i) => {
    if (result.status === 'fulfilled' && result.value.ok) {
      succeeded++;
      items.push(...result.value.items);
    } else {
      failures.push({ feed: enabledFeeds[i].name, category: result.status === 'fulfilled' ? result.value.failure : 'network' });
    }
  });
  return { items, enabled: enabledFeeds.length, succeeded, failed: failures.length, failures };
};

module.exports = { fetchFeed, fetchFeedOutcome, fetchAllFeeds, sanitizeLink };
