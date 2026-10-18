'use strict';

const path = require('path');
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
const parseFundCli = (argv, { exchange: fixedExchange, usage }) => {
  const exchange = (flagValue(argv, 'exchange') || fixedExchange).toLowerCase();
  const pair = flagValue(argv, 'pair')?.toUpperCase();
  if (exchange !== fixedExchange || !pair) {
    console.error(`Usage: ${usage} --pair <PAIR> [--exchange ${fixedExchange}] [--apply]`);
    console.error('Dry run is the default; --apply is required to place orders or write state.');
    process.exit(1);
  }
  const fundDir = resolveFundDataDir(exchange, pair);
  return {
    exchange,
    pair,
    apply: argv.includes('--apply') && !argv.includes('--dry-run'),
    fundDir,
    ledgerPath: path.join(fundDir, 'fill-ledger.json'),
    statePath: path.join(fundDir, 'regime-state.json'),
  };
};

module.exports = { parseFundCli };
