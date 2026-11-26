#!/usr/bin/env node
// @ts-check
/**
 * Ratcheted typecheck. Runs `tsc --noEmit -p jsconfig.json`, groups the
 * diagnostics by file and compares per-file error counts with the checked-in
 * baseline (`typecheck-baseline.json`, `{ "<posix path>": <count> }`).
 *
 * Fails when a file has more errors than its baseline, or a file missing from
 * the baseline (a clean file) has any. With --strict-ratchet it also fails
 * when counts improve until the baseline is lowered.
 *
 *   npm run typecheck                 check against the baseline
 *   npm run typecheck -- --strict-ratchet    require exact counts (CI)
 *   npm run typecheck -- --update     lower the baseline (never raises a count,
 *                                     never adds a file; creates it if absent)
 *   npm run typecheck -- --update --force
 *                                     rewrite the baseline to exactly the
 *                                     current counts (initial generation, or an
 *                                     accepted regression after a toolchain bump)
 *   --project <jsconfig> / --baseline <file>   override the defaults (tests)
 *
 * The baseline holds counts only, with paths relative to the project directory
 * and POSIX-style, so it does not depend on the machine that produced it.
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..');
const GLOBAL_KEY = '<global>';
const DIAGNOSTIC = /^(.+?)\(\d+,\d+\): error TS\d+: /;
const GLOBAL_DIAGNOSTIC = /^error TS\d+: /;

/**
 * Count `tsc --pretty false` diagnostics per file. Continuation lines of
 * multi-line messages are indented and ignored; diagnostics inside
 * node_modules are skipped.
 * @param {string} output
 * @param {string} baseDir directory the reported paths are relative to (tsc's cwd)
 * @returns {Record<string, number>}
 */
function parseDiagnostics(output, baseDir) {
  /** @type {Record<string, number>} */
  const counts = {};
  for (const line of output.split(/\r?\n/)) {
    const match = DIAGNOSTIC.exec(line);
    let key;
    if (match) {
      key = path.relative(baseDir, path.resolve(baseDir, match[1])).split(path.sep).join('/');
      // Third-party JS that checkJs pulls in (e.g. express, which ships no
      // types) is not ours to fix and varies with the installed tree.
      if (key.split('/').includes('node_modules')) continue;
    } else if (GLOBAL_DIAGNOSTIC.test(line)) {
      key = GLOBAL_KEY;
    } else {
      continue;
    }
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

/**
 * Every diagnostic tsc reported, including the node_modules ones that
 * parseDiagnostics skips. Tells "tsc crashed" apart from "tsc only complained
 * about third-party files".
 * @param {string} output
 */
function countRawDiagnostics(output) {
  return output.split(/\r?\n/).filter((line) => DIAGNOSTIC.test(line) || GLOBAL_DIAGNOSTIC.test(line)).length;
}

/**
 * @param {Record<string, number>} current
 * @param {Record<string, number>} baseline
 * @returns {{ regressions: {file: string, from: number, to: number}[], improvements: {file: string, from: number, to: number}[] }}
 */
function compare(current, baseline) {
  const regressions = [];
  const improvements = [];
  for (const file of [...new Set([...Object.keys(current), ...Object.keys(baseline)])].sort()) {
    const to = current[file] || 0;
    const from = baseline[file] || 0;
    if (to > from) regressions.push({ file, from, to });
    else if (to < from) improvements.push({ file, from, to });
  }
  return { regressions, improvements };
}

/**
 * Baseline after `--update`: counts only ever go down, files that reach zero
 * are dropped, and files the baseline does not know are not added.
 * @param {Record<string, number>} current
 * @param {Record<string, number>} baseline
 * @param {boolean} force take the current counts verbatim
 * @returns {Record<string, number>}
 */
function nextBaseline(current, baseline, force) {
  /** @type {Record<string, number>} */
  const next = {};
  const files = force ? Object.keys(current) : Object.keys(baseline);
  for (const file of files.sort()) {
    const count = force ? current[file] : Math.min(current[file] || 0, baseline[file]);
    if (count > 0) next[file] = count;
  }
  return next;
}

/** @param {string} baselinePath */
function readBaseline(baselinePath) {
  if (!fs.existsSync(baselinePath)) return null;
  return /** @type {Record<string, number>} */ (JSON.parse(fs.readFileSync(baselinePath, 'utf8')));
}

/** @param {string} baselinePath @param {Record<string, number>} counts */
function writeBaseline(baselinePath, counts) {
  fs.writeFileSync(baselinePath, `${JSON.stringify(counts, null, 2)}\n`);
}

/** @param {string[]} argv @param {string} name */
function optionValue(argv, name) {
  const i = argv.indexOf(name);
  return i === -1 ? null : argv[i + 1] || null;
}

/** @param {string[]} argv */
function main(argv) {
  const update = argv.includes('--update');
  const force = argv.includes('--force');
  const project = path.resolve(optionValue(argv, '--project') || path.join(REPO_ROOT, 'jsconfig.json'));
  const baselinePath = path.resolve(optionValue(argv, '--baseline') || path.join(REPO_ROOT, 'typecheck-baseline.json'));
  const projectDir = path.dirname(project);

  const tsc = spawnSync(
    process.execPath,
    [require.resolve('typescript/bin/tsc'), '--noEmit', '--pretty', 'false', '-p', project],
    { cwd: projectDir, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  if (tsc.error) {
    console.error(`typecheck: could not run tsc: ${tsc.error.message}`);
    return 1;
  }
  const output = `${tsc.stdout}\n${tsc.stderr}`;
  const current = parseDiagnostics(output, projectDir);
  const total = Object.values(current).reduce((a, b) => a + b, 0);
  if (tsc.status !== 0 && countRawDiagnostics(output) === 0) {
    console.error(`typecheck: tsc exited ${tsc.status} without reporting a diagnostic:\n${tsc.stdout}${tsc.stderr}`);
    return 1;
  }

  const baseline = readBaseline(baselinePath);

  if (update) {
    if (baseline === null && !force) {
      console.log('typecheck: no baseline yet; creating it from the current counts.');
    }
    const next = baseline === null ? nextBaseline(current, {}, true) : nextBaseline(current, baseline, force);
    writeBaseline(baselinePath, next);
    const sum = Object.values(next).reduce((a, b) => a + b, 0);
    console.log(`typecheck: baseline written (${sum} errors in ${Object.keys(next).length} files).`);
    return 0;
  }

  if (baseline === null) {
    console.error(`typecheck: ${path.basename(baselinePath)} not found. Create it with: npm run typecheck -- --update`);
    return 1;
  }

  const { regressions, improvements } = compare(current, baseline);
  const files = Object.keys(current).length;
  if (regressions.length > 0) {
    console.error('typecheck: new type errors (run `npx tsc --noEmit -p jsconfig.json` for details):');
    for (const r of regressions) {
      console.error(`  ${r.file}: ${r.to} errors (baseline ${r.from})`);
    }
    console.error('Fix them; do not raise the baseline. If a baselined file was only renamed or split, run `npm run typecheck -- --update --force` and review the baseline diff so no real regression rides along.');
    return 1;
  }
  if (improvements.length > 0) {
    console.log(`typecheck: ${improvements.length} file(s) improved. Lower the baseline with: npm run typecheck -- --update`);
    for (const i of improvements) console.log(`  ${i.file}: ${i.from} -> ${i.to}`);
    if (argv.includes('--strict-ratchet')) return 1;
  }
  console.log(`typecheck: ok (${total} errors in ${files} files, none worse than baseline).`);
  return 0;
}

module.exports = { parseDiagnostics, countRawDiagnostics, compare, nextBaseline };

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}
