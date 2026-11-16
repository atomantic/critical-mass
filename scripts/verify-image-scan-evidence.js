#!/usr/bin/env node
// @ts-check
/**
 * Gate for dependency audits: decides whether downloaded image-scan evidence
 * (the `image-security-evidence` artifact of the Image Security workflow) may be
 * cited as current for THIS checkout. It rejects evidence that is older than 14
 * days, was produced from different recipe files (Dockerfile, lockfiles, Umbrel
 * manifest), names a different Umbrel image digest, is missing a target, has an
 * empty inventory, or records unavailable coverage. Output is JSON on stdout.
 *
 *   node scripts/verify-image-scan-evidence.js <evidence-dir> [--max-age-days N] [--now ISO-8601]
 *
 * Exit status: 0 current, 1 not current or unreadable.
 */
const path = require('node:path');
const { MAX_EVIDENCE_AGE_DAYS, verifyEvidenceDir } = require('./lib/image-scan-evidence');

function main() {
  const args = process.argv.slice(2);
  const dir = args[0];
  if (!dir || dir.startsWith('--')) throw new Error('usage: verify-image-scan-evidence.js <evidence-dir> [--max-age-days N] [--now ISO-8601]');
  const opt = (/** @type {string} */ name) => {
    const i = args.indexOf(name);
    return i === -1 ? undefined : args[i + 1];
  };
  const maxAgeDays = opt('--max-age-days') === undefined ? MAX_EVIDENCE_AGE_DAYS : Number(opt('--max-age-days'));
  if (!Number.isFinite(maxAgeDays) || maxAgeDays <= 0) throw new Error('--max-age-days must be a positive number');
  const nowFlag = opt('--now');
  const now = nowFlag ? new Date(nowFlag) : new Date();
  if (Number.isNaN(now.getTime())) throw new Error('--now must be an ISO-8601 timestamp');

  const verdict = verifyEvidenceDir({ evidenceRoot: path.resolve(dir), root: path.join(__dirname, '..'), now, maxAgeDays });
  process.stdout.write(`${JSON.stringify({ current: verdict.current, checkedTargets: verdict.results.length, maxAgeDays, problems: verdict.problems }, null, 2)}\n`);
  return verdict.current ? 0 : 1;
}

try {
  process.exitCode = main();
} catch (err) {
  console.error(`❌ ${/** @type {Error} */ (err).message}`);
  process.exitCode = 1;
}
