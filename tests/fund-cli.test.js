const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const roots = [];
const fixture = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fund-cli-'));
  roots.push(root);
  fs.writeFileSync(path.join(root, 'fill-ledger.json'), '[{"tradeId":"original"}]');
  fs.writeFileSync(path.join(root, 'regime-state.json'), '{"position":{}}');
  return root;
};
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

// Redirect only the child process's fund resolver. No live fund, key or network
// is touched; an unknown exchange exercises real persisted liveness flags.
const run = (root, args = ['--apply'], script) => {
  const migration = require.resolve('../src/migration');
  const helper = require.resolve('../scripts/lib/fund-cli');
  const code = `
    const fs = require('fs');
    const path = require('path');
    require.cache[${JSON.stringify(migration)}] = { exports: { resolveFundDataDir: () => ${JSON.stringify(root)} } };
    process.argv = ['node', 'fixture-repair.js', ...${JSON.stringify(args)}];
    ${script ? `require(${JSON.stringify(script)});` : `
    const cli = require(${JSON.stringify(helper)}).parseFundCli(process.argv, {
      exchange: '__fixture__', usage: 'fixture-repair'
    });
    cli.prepareApply({ files: [cli.ledgerPath, cli.statePath, path.join(cli.fundDir, 'absent.json'), cli.ledgerPath] })
      .then(backups => { console.log('BACKUPS=' + backups.length); })
      .catch(err => { console.error(err); process.exitCode = 1; });`}
  `;
  return spawnSync(process.execPath, ['-e', code], { encoding: 'utf8' });
};
const backups = root => fs.readdirSync(root).filter(name => name.includes('.backup-'));
const flag = (root, running) => fs.writeFileSync(path.join(root, 'regime-engine-running.json'), JSON.stringify({ running, startedAt: '2000-01-01' }));

describe('fund repair apply preparation', () => {
  it('refuses an old running flag before creating any backups', () => {
    const root = fixture();
    flag(root, true);
    const result = run(root, ['--pair', 'FIXTURE', '--apply']);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /REFUSING to write __fixture__\/FIXTURE.*RUNNING/);
    assert.deepEqual(backups(root), []);
    assert.equal(fs.readFileSync(path.join(root, 'fill-ledger.json'), 'utf8'), '[{"tradeId":"original"}]');
  });

  it('backs up each existing destination once, byte-for-byte, when stopped', () => {
    const root = fixture();
    flag(root, false);
    const result = run(root, ['--pair', 'FIXTURE', '--apply']);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /BACKUPS=2/);
    assert.equal(backups(root).length, 2);
    for (const backup of backups(root)) {
      assert.match(backup, /\.backup-fixture-repair-\d+$/);
      assert.equal(fs.readFileSync(path.join(root, backup), 'utf8'), fs.readFileSync(path.join(root, backup.split('.backup-')[0]), 'utf8'));
    }
  });

  for (const args of [[], ['--apply', '--dry-run']]) {
    it(`skips liveness and backups in dry-run (${args.join(' ') || 'default'})`, () => {
      const root = fixture();
      flag(root, true);
      const result = run(root, ['--pair', 'FIXTURE', ...args]);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /BACKUPS=0/);
      assert.doesNotMatch(result.stdout, /engine check/);
      assert.deepEqual(backups(root), []);
    });
  }

  it('fails closed on unknown liveness', () => {
    const root = fixture();
    const result = run(root, ['--pair', 'FIXTURE', '--apply']);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /no known IPC port/);
    assert.deepEqual(backups(root), []);
  });

  it('refuses an incident repair before reading or writing under a live engine', () => {
    const root = fixture();
    flag(root, true);
    const ledger = path.join(root, 'fill-ledger.json');
    fs.writeFileSync(ledger, 'invalid JSON proves guard precedes snapshot read');
    const result = run(root, ['--pair', 'CRO_USD', '--apply'], require.resolve('../scripts/cryptocom-flag-orphan-sells'));
    assert.equal(result.status, 1);
    assert.match(result.stderr, /REFUSING.*cryptocom\/CRO_USD.*RUNNING/);
    assert.deepEqual(backups(root), []);
    assert.equal(fs.readFileSync(ledger, 'utf8'), 'invalid JSON proves guard precedes snapshot read');
  });

  it('requires incident tools to explicitly select their specific fund', () => {
    const root = fixture();
    const result = run(root, ['--pair', 'OTHER', '--apply'], require.resolve('../scripts/cryptocom-flag-orphan-sells'));
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Usage:/);
    assert.deepEqual(backups(root), []);
  });

  for (const name of ['adopt-untracked-asset', 'backfill-missing-fills']) {
    it(`${name} invokes its entrypoint and guards the positional fund`, () => {
      const root = fixture();
      flag(root, true);
      const result = run(root, ['gemini', 'ETHUSD', '--apply'], require.resolve(`../scripts/${name}`));
      assert.equal(result.status, 1);
      assert.match(result.stderr, /REFUSING.*gemini\/ETHUSD.*RUNNING/);
      assert.deepEqual(backups(root), []);
    });

    it(`${name} reports usage for missing positional arguments`, () => {
      const result = run(fixture(), [], require.resolve(`../scripts/${name}`));
      assert.equal(result.status, 1);
      assert.match(result.stderr, /Usage:/);
      assert.doesNotMatch(result.stderr, /TypeError/);
    });
  }

});
