// @ts-check
// issue #1973 — fund data-directory resolution lives in src/fund-paths.js.
//
// About 124 test sites redirect the data directory by patching
// `fundPaths.getExchangeDataDir`. That only works because the resolvers call it
// through `module.exports`; a direct call, or a test still patching the old
// module, silently stops redirecting and the test reads or writes the real
// data/ tree. These tests pin the seam itself and fail loudly if either half
// drifts.

const { describe, it, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const fundPaths = require('../src/fund-paths');
const migration = require('../src/migration');

const PATH_HELPERS = [
  'getExchangeDataDir',
  'resolveFundDataDir',
  'getFundDataDir',
  'resolveFundPath',
  'withFundDataDirOverride',
  'PER_FUND_FILES',
  'getExchangeKeysPath',
];

const makeRoot = (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fund-paths-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
};

describe('fund-paths getExchangeDataDir seam (issue #1973)', () => {
  it('patching fundPaths.getExchangeDataDir redirects resolveFundDataDir', (t) => {
    const root = makeRoot(t);
    const patched = mock.method(fundPaths, 'getExchangeDataDir', (exchange) => path.join(root, exchange));
    t.after(() => patched.mock.restore());

    // Both an explicit pair and a captured (destructured) reference must honour
    // the patch: production modules destructure the helpers at load time.
    const { resolveFundDataDir } = fundPaths;
    assert.equal(resolveFundDataDir('coinbase', 'BTC-USDC'), path.join(root, 'coinbase', 'BTC-USDC'));
    assert.equal(fundPaths.resolveFundDataDir('gemini', 'ETH-USD'), path.join(root, 'gemini', 'ETH-USD'));
    assert.equal(patched.mock.callCount(), 2);
    // Read-side resolution must not create the per-fund directory.
    assert.equal(fs.existsSync(path.join(root, 'coinbase', 'BTC-USDC')), false);
  });

  it('patching fundPaths.getExchangeDataDir redirects getFundDataDir (which creates the fund dir)', (t) => {
    const root = makeRoot(t);
    const patched = mock.method(fundPaths, 'getExchangeDataDir', (exchange) => path.join(root, exchange));
    t.after(() => patched.mock.restore());

    const { getFundDataDir } = fundPaths;
    const dir = getFundDataDir('coinbase', 'BTC-USDC');
    assert.equal(dir, path.join(root, 'coinbase', 'BTC-USDC'));
    assert.equal(fs.existsSync(dir), true);
    assert.equal(patched.mock.callCount(), 1);
  });

  it('routes a patched resolveFundPath through the same indirection', (t) => {
    const root = makeRoot(t);
    const exchangePatch = mock.method(fundPaths, 'getExchangeDataDir', (exchange) => path.join(root, exchange));
    const pathPatch = mock.method(fundPaths, 'resolveFundPath', (dir, pair) => path.join(dir, `patched-${pair}`));
    t.after(() => { pathPatch.mock.restore(); exchangePatch.mock.restore(); });

    assert.equal(fundPaths.resolveFundDataDir('coinbase', 'BTC-USDC'), path.join(root, 'coinbase', 'patched-BTC-USDC'));
  });

  it('withFundDataDirOverride wins over the exchange directory and is released afterwards', (t) => {
    const root = makeRoot(t);
    const patched = mock.method(fundPaths, 'getExchangeDataDir', (exchange) => path.join(root, exchange));
    t.after(() => patched.mock.restore());
    const staging = path.join(root, 'staging');

    const inside = fundPaths.withFundDataDirOverride('coinbase', 'BTC-USDC', staging, () => (
      fundPaths.resolveFundDataDir('coinbase', 'BTC-USDC')
    ));
    assert.equal(inside, staging);
    assert.equal(fundPaths.resolveFundDataDir('coinbase', 'BTC-USDC'), path.join(root, 'coinbase', 'BTC-USDC'));
  });

  it('getExchangeKeysPath is the exchange keys file under the data root', () => {
    const keysPath = fundPaths.getExchangeKeysPath('coinbase');
    assert.equal(path.basename(keysPath), 'coinbase-keys.json');
  });
});

describe('fund-paths ownership (issue #1973)', () => {
  it('migration.js no longer exports any fund path helper', () => {
    for (const name of PATH_HELPERS) {
      assert.equal(name in migration, false, `migration must not re-export ${name}; import it from src/fund-paths`);
    }
  });

  it('fund-paths exports every documented helper', () => {
    for (const name of PATH_HELPERS) assert.ok(name in fundPaths, `fund-paths is missing ${name}`);
  });

  it('no test patches or aliases a fund path helper on the migration module', () => {
    const testsDir = __dirname;
    const files = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.js')) files.push(full);
      }
    };
    walk(testsDir);

    const helpers = PATH_HELPERS.join('|');
    // `migration.<helper>`, `mock.method(migration, '<helper>'` and
    // `require('…/migration').<helper>` all stop redirecting silently.
    const offending = new RegExp(
      `(?:\\bmigration\\w*\\s*\\.\\s*(?:${helpers})\\b)` +
      `|(?:method\\(\\s*migration\\w*\\s*,\\s*['"](?:${helpers})['"])` +
      `|(?:src/migration['"]\\s*\\)\\s*\\.\\s*(?:${helpers})\\b)` +
      `|(?:\\{[^}]*\\b(?:${helpers})\\b[^}]*\\}\\s*=\\s*require\\([^)]*src/migration['"]\\))`,
    );
    const offenders = [];
    for (const file of files) {
      if (file === __filename) continue;
      fs.readFileSync(file, 'utf8').split('\n').forEach((line, index) => {
        if (offending.test(line)) offenders.push(`${path.relative(testsDir, file)}:${index + 1}: ${line.trim()}`);
      });
    }
    assert.deepEqual(offenders, [], 'patch/import fund path helpers on src/fund-paths, not src/migration');
  });
});
