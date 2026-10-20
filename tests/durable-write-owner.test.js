const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

// Discover write-then-rename publishers, including descriptor writes opened on
// the rename source. Moves/quarantines without a write to that source are fine.
const ownsPublication = (source) => {
  const names = [...source.matchAll(/fs\.renameSync\(\s*([A-Za-z_$][\w$]*)\s*,/g)].map((match) => match[1]);
  return names.some((name) => {
    const escaped = name.replace(/[$]/g, '\\$');
    return new RegExp(`fs\\.(?:writeFileSync|appendFileSync)\\(\\s*${escaped}\\s*,`).test(source)
      || new RegExp(`fs\\.copyFileSync\\([^,]+,\\s*${escaped}\\s*[,)]`).test(source)
      || new RegExp(`fs\\.openSync\\(\\s*${escaped}\\s*,\\s*['"](?:w|a)`).test(source);
  });
};

test('publication discovery detects direct, copied and descriptor writes but excludes moves', () => {
  for (const write of ["fs.writeFileSync(tmp, data)", "fs.copyFileSync(src, tmp)", "const fd = fs.openSync(tmp, 'wx'); fs.writeFileSync(fd, data)"]) {
    assert.equal(ownsPublication(`${write}; fs.renameSync(tmp, target)`), true);
  }
  assert.equal(ownsPublication('fs.writeFileSync(other, bytes); fs.renameSync(source, quarantine)'), false);
});

test('durable publication has one owner, with explicit migration and backup staging exceptions', () => {
  const root = path.join(__dirname, '..', 'src');
  const allowlist = new Set(['durable-write.js', 'migration.js', 'legacy-namespace-migration.js', 'backup-service.js']);
  const offenders = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.name.endsWith('.js') && !allowlist.has(path.relative(root, file)) && ownsPublication(fs.readFileSync(file, 'utf8'))) {
        offenders.push(path.relative(root, file));
      }
    }
  };
  walk(root);
  assert.deepEqual(offenders, [], 'Move new file publishers into durable-write.js');
  const owner = fs.readFileSync(path.join(root, 'durable-write.js'), 'utf8');
  assert.deepEqual([...owner.matchAll(/require\(['"]([^'"]+)['"]\)/g)].map((match) => match[1]).sort(), ['crypto', 'fs', 'path', './fsync-dir'].sort());
  for (const name of ['migration.js', 'logger.js']) {
    assert.doesNotMatch(fs.readFileSync(path.join(root, name), 'utf8'), /require\(['"]\.\/state-tracker['"]\)/);
  }
});
