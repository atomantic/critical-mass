#!/usr/bin/env node
/**
 * Print the long-term depression score across all running engines.
 *
 * Usage:
 *   node scripts/check-long-term-bias.js
 *   node scripts/check-long-term-bias.js --json    # machine-readable output
 *   GATEWAY_URL=http://localhost:5563 node scripts/check-long-term-bias.js
 */

const GATEWAY_URL = process.env.GATEWAY_URL || 'http://localhost:5563';
const EXCHANGES = ['coinbase', 'gemini', 'cryptocom'];
const JSON_MODE = process.argv.includes('--json');

// ANSI colors (skipped in JSON mode)
const c = {
  reset:  '\x1b[0m',
  bold:   '\x1b[1m',
  dim:    '\x1b[2m',
  red:    '\x1b[31m',
  green:  '\x1b[32m',
  yellow: '\x1b[33m',
  blue:   '\x1b[34m',
  cyan:   '\x1b[36m',
  gray:   '\x1b[90m',
};

const colorForLevel = (level) => {
  switch (level) {
    case 'maximum':     return c.red;
    case 'aggressive':  return c.yellow;
    case 'moderate':    return c.blue;
    case 'conservative': return c.green;
    default:            return c.gray;
  }
};

const colorForHealth = (health) => {
  switch (health) {
    case 'full':    return c.green;
    case 'partial': return c.yellow;
    case 'sparse':  return c.red;
    case 'empty':   return c.gray;
    default:        return c.gray;
  }
};

const fetchExchange = async (exchange) => {
  try {
    // /regime/status carries the live macro + bias state.
    // /regime/config carries productId + aggressiveness, which the status
    // endpoint intentionally omits to keep the payload small.
    const [statusRes, configRes] = await Promise.all([
      fetch(`${GATEWAY_URL}/api/${exchange}/regime/status`),
      fetch(`${GATEWAY_URL}/api/${exchange}/regime/config`),
    ]);
    if (!statusRes.ok) return { exchange, error: `status HTTP ${statusRes.status}` };
    const statusJson = await statusRes.json();
    if (!statusJson.success) return { exchange, error: statusJson.error || 'status error' };
    const configJson = configRes.ok ? await configRes.json().catch(() => ({})) : {};
    const cfg = configJson.config || configJson;
    const macro = statusJson.status?.macro;
    if (!macro) return { exchange, error: 'no macro state' };
    return {
      exchange,
      status: statusJson.status,
      macro,
      productId: cfg.productId || '?',
      aggressiveness: cfg.aggressiveness || null,
    };
  } catch (err) {
    return { exchange, error: err.message };
  }
};

const main = async () => {
  const results = await Promise.all(EXCHANGES.map(fetchExchange));

  if (JSON_MODE) {
    console.log(JSON.stringify(results, null, 2));
    return;
  }

  console.log();
  console.log(`${c.bold}Long-Term Bias (Phase 1: observe-only)${c.reset}`);
  console.log(c.dim + '─'.repeat(110) + c.reset);

  // Header
  console.log(
    'Exchange'.padEnd(11) +
    'Asset'.padEnd(13) +
    'Score'.padEnd(10) +
    'Suggested'.padEnd(15) +
    'Drawdown'.padEnd(11) +
    'Pct'.padEnd(7) +
    'Z'.padEnd(8) +
    'Cache'.padEnd(15) +
    'Sample'
  );
  console.log(c.dim + '─'.repeat(110) + c.reset);

  for (const r of results) {
    if (r.error) {
      console.log(`${c.red}${r.exchange.padEnd(11)}error: ${r.error}${c.reset}`);
      continue;
    }

    const bias = r.macro.longTermBias;
    if (!bias) {
      console.log(`${c.gray}${r.exchange.padEnd(11)}(no longTermBias data — engine may be on old code)${c.reset}`);
      continue;
    }

    const productId = r.productId || '?';
    const cacheHealth = bias.cache?.health || 'unknown';
    const cacheCount = bias.cache?.count || 0;
    const cacheLookback = bias.cache?.lookbackDays || 0;
    const coverage = bias.cache?.coveragePct || 0;
    const levelColor = colorForLevel(bias.suggestedLevel);
    const healthColor = colorForHealth(cacheHealth);

    if (!bias.ready) {
      console.log(
        r.exchange.padEnd(11) +
        productId.padEnd(13) +
        c.gray + 'WARMING'.padEnd(10) + c.reset +
        c.gray + '(need ≥30 candles)'.padEnd(15) + c.reset +
        ''.padEnd(11) +
        ''.padEnd(7) +
        ''.padEnd(8) +
        healthColor + cacheHealth.padEnd(15) + c.reset +
        `${bias.sampleSize}/${cacheLookback}d`
      );
      continue;
    }

    const score = (bias.score * 100).toFixed(0);
    const dd = bias.components.drawdown.drawdownPct.toFixed(1) + '%';
    const pct = (bias.components.percentile.score * 100).toFixed(0);
    const z = bias.components.zscore.zscore.toFixed(2);

    console.log(
      r.exchange.padEnd(11) +
      productId.padEnd(13) +
      `${levelColor}${score.padStart(3)}/100`.padEnd(19) + c.reset +
      `${levelColor}${bias.suggestedLevel.toUpperCase()}`.padEnd(24) + c.reset +
      dd.padEnd(11) +
      pct.padEnd(7) +
      z.padEnd(8) +
      `${healthColor}${cacheHealth}${c.reset} ${c.dim}(${coverage.toFixed(0)}%)${c.reset}`.padEnd(30) +
      `${cacheCount}/${cacheLookback}d`
    );
  }

  console.log(c.dim + '─'.repeat(110) + c.reset);

  // Show divergence between current and suggested
  console.log();
  console.log(`${c.bold}Aggressiveness alignment:${c.reset}`);
  for (const r of results) {
    if (r.error || !r.macro?.longTermBias?.ready) continue;
    const bias = r.macro.longTermBias;
    const current = r.aggressiveness;
    if (!current) continue;
    const match = current === bias.suggestedLevel;
    const icon = match ? `${c.green}✓${c.reset}` : `${c.yellow}⚠${c.reset}`;
    console.log(
      `  ${icon} ${r.exchange.padEnd(11)} current=${current.padEnd(13)} suggested=${colorForLevel(bias.suggestedLevel)}${bias.suggestedLevel}${c.reset}`
    );
  }
  console.log();
};

main().catch(err => {
  console.error('Failed:', err.message);
  process.exit(1);
});
