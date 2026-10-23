// @ts-check
const LEVELS = ['conservative', 'moderate', 'aggressive', 'maximum'];

// Match the dashboard's effective-preset detection; a customized fund has no
// discrete current step and must never receive a misleading preset suggestion.
const detectCurrentLevel = (config, presets) => {
  const keys = Object.keys(presets.conservative || {});
  if (!keys.length || !keys.every(key => config[key] !== undefined)) {
    return LEVELS.includes(config.aggressiveness) ? config.aggressiveness : null;
  }
  return LEVELS.find(level => Object.entries(presets[level] || {}).every(
    ([key, value]) => Math.abs(config[key] - value) < 0.01 || (key.endsWith('Ms') && config[key] === value)
  )) || null;
};

// State belongs to one exchange/pair. Require the SAME current/suggested pair
// continuously: flapping, missing data and long observation gaps restart dwell.
const createAggressivenessAdvisory = () => {
  let candidate = null;
  return {
    reset() { candidate = null; },
    observe({ current, suggested, ready, hours = 6, now = Date.now(), maxGapMs = 900000 }) {
      if (!ready || !LEVELS.includes(current) || !LEVELS.includes(suggested) || current === suggested) {
        candidate = null;
        return null;
      }
      const key = `${current}:${suggested}:${hours}`;
      if (!candidate || candidate.key !== key || now - candidate.lastSeen > maxGapMs || now < candidate.lastSeen) {
        candidate = { key, since: now, lastSeen: now, notified: false };
      }
      candidate.lastSeen = now;
      if (now - candidate.since < hours * 3600000) return null;
      const first = !candidate.notified;
      candidate.notified = true;
      return { id: `${key}:${candidate.since}`, currentLevel: current, suggestedLevel: suggested,
        since: candidate.since, hours, first };
    },
  };
};

module.exports = { detectCurrentLevel, createAggressivenessAdvisory };
