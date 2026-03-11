// @ts-check
/**
 * RSS Feed Poller
 *
 * Fetches and parses RSS/Atom feeds, normalizing items to a common format.
 * Handles per-feed errors gracefully (log + skip).
 */

const axios = require('axios');
const { XMLParser } = require('fast-xml-parser');
const { log } = require('../logger');

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
});

/**
 * Normalize an RSS 2.0 item to common format
 * @param {Object} item - Raw RSS item
 * @param {string} sourceName - Feed name
 * @returns {Object} Normalized item
 */
const normalizeRSSItem = (item, sourceName) => ({
  guid: item.guid?.['#text'] || item.guid || item.link || `${sourceName}-${item.title}`,
  title: (item.title || '').trim(),
  description: (item.description || item['content:encoded'] || '').replace(/<[^>]+>/g, '').trim().slice(0, 500),
  link: item.link || '',
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
    title: (typeof entry.title === 'string' ? entry.title : entry.title?.['#text'] || '').trim(),
    description: (entry.summary || entry.content || '').replace(/<[^>]+>/g, '').trim().slice(0, 500),
    link: href,
    pubDate: entry.updated || entry.published ? new Date(entry.updated || entry.published).toISOString() : new Date().toISOString(),
    source: sourceName,
  };
};

/**
 * Fetch and parse a single RSS/Atom feed
 * @param {{ name: string, url: string }} feed - Feed config
 * @param {number} [timeoutMs=15000] - Request timeout
 * @returns {Promise<Object[]>} Normalized items
 */
const fetchFeed = async (feed, timeoutMs = 15000) => {
  try {
    const response = await axios.get(feed.url, {
      timeout: timeoutMs,
      headers: { 'User-Agent': 'CriticalMass-Sentinel/1.0' },
      responseType: 'text',
    });

    const parsed = parser.parse(response.data);

    // RSS 2.0
    if (parsed.rss?.channel) {
      const channel = parsed.rss.channel;
      const items = Array.isArray(channel.item) ? channel.item : (channel.item ? [channel.item] : []);
      return items.map(item => normalizeRSSItem(item, feed.name));
    }

    // Atom
    if (parsed.feed?.entry) {
      const entries = Array.isArray(parsed.feed.entry) ? parsed.feed.entry : [parsed.feed.entry];
      return entries.map(entry => normalizeAtomEntry(entry, feed.name));
    }

    log('WARN', `Sentinel: unrecognized feed format from ${feed.name}`);
    return [];
  } catch (err) {
    log('WARN', `Sentinel: failed to fetch ${feed.name}: ${err.message}`);
    return [];
  }
};

/**
 * Fetch all enabled feeds
 * @param {Object[]} feeds - Array of feed configs
 * @returns {Promise<Object[]>} All normalized items from all feeds
 */
const fetchAllFeeds = async (feeds) => {
  const enabledFeeds = feeds.filter(f => f.enabled !== false);
  const results = await Promise.allSettled(enabledFeeds.map(f => fetchFeed(f)));

  const allItems = [];
  for (const result of results) {
    if (result.status === 'fulfilled') {
      allItems.push(...result.value);
    }
  }
  return allItems;
};

module.exports = { fetchFeed, fetchAllFeeds };
