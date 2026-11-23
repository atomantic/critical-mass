// @ts-check
/**
 * Append-only record of completed 1m index bars, one JSONL file per UTC day.
 * Crypto.com serves no usable index history, so this is the only copy. A first
 * minute joined part-way and a minute still open at shutdown are never written; a
 * failed append costs that minute only.
 */

const fs = require('fs');
const path = require('path');
const { trackPendingWrite } = require('../pending-writes');

const MINUTE_MS = 60_000;
const MAX_QUEUED = 1440;
/** The index ticks about once a second: a first value later than this missed the open. */
const MAX_FIRST_DELAY_MS = 2000;

const defaultAppend = (file, line) => trackPendingWrite('btc-index-history', async () => {
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  await fs.promises.appendFile(file, line, { mode: 0o600 });
});

/**
 * @param {{dir: string, logger: {warn: Function}, append?: (file: string, line: string) => Promise<any>}} deps
 */
const createIndexHistory = ({ dir, logger, append = defaultAppend }) => {
  /** @type {{t: number, open: number, high: number, low: number, close: number, samples: number} | null} */
  let current = null;
  const queue = [];
  let partial = false;
  let paused = false;
  /** @type {Promise<void> | null} */
  let writing = null;

  const write = async (bar) => {
    const file = path.join(dir, `index-${new Date(bar.t).toISOString().slice(0, 10)}.jsonl`);
    try {
      await append(file, `${JSON.stringify(bar)}\n`);
    } catch (err) {
      logger.warn(`⚠️ 📊 BTC index history append failed: ${err.message}`, { action: 'btc-index-append', error: err.message });
    }
  };

  const pump = () => {
    if (paused || writing || !queue.length) return;
    writing = write(queue.shift()).then(() => {
      writing = null;
      pump();
    });
  };

  /** @param {{value: number, timestamp: number}} sample */
  const add = ({ value, timestamp }) => {
    const t = Math.floor(timestamp / MINUTE_MS) * MINUTE_MS;
    if (current && t < current.t) return;
    if (current && t === current.t) {
      current.high = Math.max(current.high, value);
      current.low = Math.min(current.low, value);
      current.close = value;
      current.samples++;
      return;
    }
    if (current && !partial) {
      queue.push(current);
      if (queue.length > MAX_QUEUED) queue.shift();
    }
    partial = !current && timestamp - t > MAX_FIRST_DELAY_MS;
    current = { t, open: value, high: value, low: value, close: value, samples: 1 };
    pump();
  };

  /** Stop appending; resolves once no append is in flight. Completed minutes are held. */
  const pause = async () => {
    paused = true;
    await writing;
  };

  const resume = () => {
    paused = false;
    pump();
  };

  return { add, pause, resume };
};

module.exports = { createIndexHistory };
