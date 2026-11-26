'use strict';

const { posix: path } = require('node:path');

const SOURCE_FILE = /\.[cm]?[jt]sx?$/;
const RESOLUTION_SUFFIXES = ['.js', '.json', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.mts', '.cts'];
const BACKEND_PATH = /^(?:(?:src|shared|engines|scripts|tests)\/|[^/]+$)/;
const GLOBAL_INPUTS = new Set([
  'package.json', 'package-lock.json', 'config.example.json', 'ecosystem.config.cjs',
  'scripts/test.js', 'scripts/lib/test-dependencies.js',
  'tests/quiet-console.js', 'tests/isolated-data-root.js', 'tests/skip-fsync.js',
]);

function localImports(file, text) {
  // TypeScript 7 ships the CLI separately from the stable JavaScript AST API.
  const ts = require('@typescript/typescript6');
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, false);
  const imports = [];
  const paths = [];
  // Some integration tests pass their entry point to a child process or read
  // it as a fixture. Record exact paths here, without module resolution.
  /** @param {readonly import('@typescript/typescript6').Expression[]} args */
  function addFilePath([root, ...parts]) {
    if (!root || !ts.isIdentifier(root) || root.text !== '__dirname' ||
        !parts.length || !parts.every(ts.isStringLiteralLike) || parts.some(part => path.isAbsolute(part.text))) return;
    paths.push(path.join(path.dirname(file), ...parts.map(part => part.text)));
  }
  function addImport(node) {
    if (node && ts.isStringLiteralLike(node) && /^\.\.?\//.test(node.text)) imports.push(node.text);
  }
  function visit(node) {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) addImport(node.moduleSpecifier);
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (callee.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(callee) && callee.text === 'require')) {
        addImport(node.arguments[0]);
      } else if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression)) {
        const receiver = callee.expression.text;
        const method = callee.name.text;
        if (receiver === 'require' && method === 'resolve') addImport(node.arguments[0]);
        if (receiver === 'path' && (method === 'join' || method === 'resolve')) addFilePath(node.arguments);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return { imports, paths };
}

function resolveLocal(from, specifier, files) {
  const target = path.normalize(path.join(path.dirname(from), specifier));
  return [target, ...RESOLUTION_SUFFIXES.map(ext => target + ext),
    ...RESOLUTION_SUFFIXES.map(ext => path.join(target, 'index' + ext))].find(file => files.has(file));
}

/**
 * Follow the reverse graph of static relative imports. Return no selection
 * when a backend input has unknown impact, even if another change has matches.
 * Inventory paths include deleted files so stale literal imports still resolve.
 */
function selectChangedTests(changed, testFiles, inventory, readText) {
  const tests = new Set(testFiles);
  const files = new Set(inventory);
  const reverse = new Map();
  const inputs = changed.filter(file => BACKEND_PATH.test(file) && (SOURCE_FILE.test(file) ||
    GLOBAL_INPUTS.has(file) || /^(?:scripts|tests|src|shared|engines)\//.test(file)));
  if (!inputs.length || inputs.some(file => GLOBAL_INPUTS.has(file))) return [];

  for (const file of files) {
    if (!SOURCE_FILE.test(file) || !BACKEND_PATH.test(file)) continue;
    const text = readText(file);
    if (text == null) continue;
    const { imports, paths } = localImports(file, text);
    const resolved = imports.map(specifier => resolveLocal(file, specifier, files));
    for (const dependency of [...resolved, ...paths]) {
      if (!files.has(dependency)) continue;
      if (!reverse.has(dependency)) reverse.set(dependency, new Set());
      reverse.get(dependency).add(file);
    }
  }

  const selected = new Set();
  for (const input of inputs) {
    const reachable = new Set([input]);
    let matched = false;
    for (const file of reachable) {
      if (tests.has(file)) {
        selected.add(file);
        matched = true;
      }
      for (const importer of reverse.get(file) || []) reachable.add(importer);
    }
    if (!matched) return [];
  }
  return [...selected].sort();
}

module.exports = { selectChangedTests };
