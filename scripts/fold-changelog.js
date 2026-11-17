#!/usr/bin/env node
/**
 * Fold the per-PR changelog fragments (`.changelogs/next-*.md`) into a draft
 * release note `.changelogs/v<version>.md`, then delete the fragments.
 *
 *   node scripts/fold-changelog.js 2.31.0
 *
 * The draft is a flat list for the releaser to group and edit; it also gets an
 * "Upgrade requirements" stub to fill in by hand. Refuses to overwrite an
 * existing release note and writes nothing when there are no fragments.
 */
const fs = require('node:fs');
const path = require('node:path');

const FRAGMENT = /^next-.+\.md$/;
const SEMVER = /^\d+\.\d+\.\d+$/;

function listFragments(dir) {
  return fs.readdirSync(dir)
    .filter((name) => FRAGMENT.test(name))
    .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
}

function foldChangelog(version, dir) {
  if (!SEMVER.test(version || '')) {
    throw new Error(`Version must be X.Y.Z (got: ${version || 'none'})`);
  }
  const target = path.join(dir, `v${version}.md`);
  if (fs.existsSync(target)) throw new Error(`${path.basename(target)} already exists; refusing to overwrite it`);
  const fragments = listFragments(dir);
  if (fragments.length === 0) throw new Error(`No next-*.md fragments in ${dir}`);

  const entries = fragments
    .map((name) => fs.readFileSync(path.join(dir, name), 'utf8').trim())
    .filter(Boolean);
  const body = [
    `# Release v${version}`,
    '## Upgrade requirements\n\nNone. (Replace with the real requirements, or delete this section.)',
    `## Changes\n\n${entries.join('\n\n')}`,
  ].join('\n\n') + '\n';
  fs.writeFileSync(target, body);
  for (const name of fragments) fs.unlinkSync(path.join(dir, name));
  return { target, folded: fragments };
}

if (require.main === module) {
  try {
    const dir = path.join(__dirname, '..', '.changelogs');
    const { target, folded } = foldChangelog(process.argv[2], dir);
    console.log(`Wrote ${path.relative(process.cwd(), target)} from ${folded.length} fragment(s); fragments removed.`);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}

module.exports = { foldChangelog, listFragments };
