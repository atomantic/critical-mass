// @ts-check
/**
 * RSS Feed Poller
 *
 * Fetches and parses RSS/Atom feeds, normalizing items to a common format.
 * Handles per-feed errors gracefully (log + skip).
 */

const { XMLParser } = require('fast-xml-parser');
const { createContextLogger } = require('../logger');
const { safeFetch } = require('../url-validator');

/** Feed identity is per-call (one poller serves every configured feed). */
const feedPollerLogger = createContextLogger({ module: 'sentinel-feed-poller' });

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
});

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

/** Extract XML text constructs without coercing arbitrary parsed objects. */
const textValue = (value) => {
  const text = value && typeof value === 'object' ? value['#text'] : value;
  return typeof text === 'string' || typeof text === 'number' ? String(text) : '';
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
 * @param {Object} item - Raw RSS item
 * @param {string} sourceName - Feed name
 * @returns {Object} Normalized item
 */
const normalizeRSSItem = (item, sourceName) => ({
  guid: item.guid?.['#text'] || item.guid || item.link || `${sourceName}-${item.title}`,
  title: textValue(item.title).trim(),
  description: textValue(item.description || item['content:encoded']).replace(/<[^>]+>/g, '').trim().slice(0, 500),
  link: sanitizeLink(item.link),
  pubDate: item.pubDate ? new Date(item.pubDate).toISOString() : new Date().toISOString(),
  source: sourceName,
});

/**
 * Normalize an Atom entry to common format
 * @param {Object} entry - Raw Atom entry
 * @param {string} sourceName - Feed name
 * @returns {Object} Normalized item
 */
const normalizeAtomEntry = (entry, sourceName) => {
  const link = Array.isArray(entry.link)
    ? (entry.link.find(l => l['@_rel'] === 'alternate') || entry.link[0])
    : entry.link;
  const href = typeof link === 'string' ? link : (link?.['@_href'] || '');

  return {
    guid: entry.id || href || `${sourceName}-${entry.title}`,
    title: textValue(entry.title).trim(),
    description: textValue(entry.summary || entry.content).replace(/<[^>]+>/g, '').trim().slice(0, 500),
    link: sanitizeLink(href),
    pubDate: entry.updated || entry.published ? new Date(entry.updated || entry.published).toISOString() : new Date().toISOString(),
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
    let text;
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
      text = await response.text();
    } finally {
      clearTimeout(timeout);
    }

    const parsed = parser.parse(text);

    // RSS 2.0
    if (parsed.rss?.channel) {
      const channel = parsed.rss.channel;
      const items = Array.isArray(channel.item) ? channel.item : (channel.item ? [channel.item] : []);
      return ok(normalizeItems(items, normalizeRSSItem, feed));
    }

    // Atom
    if (parsed.feed?.entry) {
      const entries = Array.isArray(parsed.feed.entry) ? parsed.feed.entry : [parsed.feed.entry];
      return ok(normalizeItems(entries, normalizeAtomEntry, feed));
    }

    // Valid but empty containers are successful-empty feeds.
    if (parsed.rss?.channel !== undefined || parsed.feed !== undefined) return ok([]);

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
