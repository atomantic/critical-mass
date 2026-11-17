const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { foldChangelog, listFragments } = require('../scripts/fold-changelog');

function fixture(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fold-changelog-'));
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), content);
  return dir;
}

test('folds issue and slug fragments into the version file and removes them', () => {
  const dir = fixture({
    'next-issue-10.md': '- **[issue-10] Ten**\n',
    'next-issue-9.md': '- **[issue-9] Nine**\n',
    'next-docs-audit.md': '- Docs audit\n',
    'v2.0.0.md': '# Release v2.0.0\n',
    'README.md': 'readme',
  });
  try {
    const { target, folded } = foldChangelog('2.1.0', dir);
    assert.equal(path.basename(target), 'v2.1.0.md');
    assert.deepEqual(folded, ['next-docs-audit.md', 'next-issue-9.md', 'next-issue-10.md']);
    const out = fs.readFileSync(target, 'utf8');
    assert.match(out, /^# Release v2\.1\.0\n/);
    assert.match(out, /## Upgrade requirements/);
    assert.ok(out.indexOf('Nine') < out.indexOf('Ten'), 'numeric-aware ordering');
    assert.deepEqual(fs.readdirSync(dir).sort(), ['README.md', 'v2.0.0.md', 'v2.1.0.md']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('rejects bad versions, existing targets and an empty fragment set without touching files', () => {
  const dir = fixture({ 'next-issue-1.md': '- one\n', 'v1.0.0.md': 'x' });
  try {
    assert.throws(() => foldChangelog('1.0', dir), /X\.Y\.Z/);
    assert.throws(() => foldChangelog('1.0.0', dir), /already exists/);
    assert.deepEqual(listFragments(dir), ['next-issue-1.md']);
    fs.unlinkSync(path.join(dir, 'next-issue-1.md'));
    assert.throws(() => foldChangelog('1.1.0', dir), /No next-\*\.md fragments/);
    assert.equal(fs.existsSync(path.join(dir, 'v1.1.0.md')), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
