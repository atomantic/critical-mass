'use strict';

const fs = require('fs');
const path = require('path');
const { checkEngineStopped } = require('../../src/engine-liveness');
const { resolveFundDataDir } = require('../../src/migration');

const flagValue = (argv, name) => {
  const eq = argv.find(a => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : undefined;
};

/**
 * Shared CLI contract for fund-repair scripts: explicit --exchange/--pair,
 * per-pair data dir via resolveFundDataDir, and dry-run unless --apply.
 * `--dry-run` is still accepted (it is the default).
 */
const parseFundCli = (argv, { exchange: fixedExchange, pair: fixedPair, usage }) => {
  const exchange = (flagValue(argv, 'exchange') || fixedExchange || '').toLowerCase();
  const pair = flagValue(argv, 'pair')?.toUpperCase();
  if (!exchange || (fixedExchange && exchange !== fixedExchange) || !pair || (fixedPair && pair !== fixedPair)) {
    console.error(`Usage: ${usage} --pair <PAIR> [--exchange ${fixedExchange}] [--apply]`);
    console.error('Dry run is the default; --apply is required to place orders or write state.');
    process.exit(1);
  }
  const fundDir = resolveFundDataDir(exchange, pair);
  const apply = argv.includes('--apply') && !argv.includes('--dry-run');
  return {
    exchange,
    pair,
    apply,
    prepareApply: ({ files }) => apply ? prepareApply({ exchange, pair, files }) : Promise.resolve([]),
    fundDir,
    ledgerPath: path.join(fundDir, 'fill-ledger.json'),
    statePath: path.join(fundDir, 'regime-state.json'),
  };
};

/** Refuse live-engine repairs and preserve every input before the first write.
 * Call before reading the repair snapshot, and keep the engine stopped until done.
 * checkEngineStopped uses the running flag and IPC, never file mtimes.
 */
const prepareApply = async ({ exchange, pair, files }) => {
  const { safe, reason } = await checkEngineStopped(exchange, pair);
  if (!safe) {
    console.error(`\n❌ REFUSING to write ${exchange}/${pair}: ${reason}.`
      + '\n   Stop it first (pm2 stop <process>), then re-run with --apply.');
    process.exit(1);
    throw new Error('Engine must be stopped before applying repairs');
  }
  console.log(`  engine check: ${reason}`);
  const script = path.basename(process.argv[1] || 'repair', '.js');
  const epoch = Date.now();
  return [...new Set(files)].filter(file => fs.existsSync(file)).map(file => {
    const backup = `${file}.backup-${script}-${epoch}`;
    fs.copyFileSync(file, backup, fs.constants.COPYFILE_EXCL);
    console.log(`Backup: ${backup}`);
    return backup;
  });
};

module.exports = { parseFundCli, prepareApply };
