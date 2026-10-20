const fs = require('fs');
const os = require('os');
const path = require('path');
const { afterEach, mock } = require('node:test');

// Capture real operations before the pathname-based config fixtures install
// their virtual reads/writes. Durable writes still exercise real descriptors,
// file fsync and directory fsync, exclusively in disposable fixture storage.
const real = Object.fromEntries(['mkdtempSync', 'openSync', 'closeSync', 'writeFileSync', 'fstatSync', 'rmSync'].map((name) => [name, fs[name].bind(fs)]));
const roots = new Set();
afterEach(() => {
  for (const root of roots) real.rmSync(root, { recursive: true, force: true });
  roots.clear();
});

const supportConfigDescriptors = (file) => {
  const root = real.mkdtempSync(path.join(os.tmpdir(), 'virtual-config-fds-'));
  roots.add(root);
  const descriptors = new Map();
  const write = fs.writeFileSync;
  mock.method(fs, 'openSync', (target, flags, mode) => {
    if (typeof target === 'string' && (target === file || target.startsWith(`${file}.`))) {
      const fd = real.openSync(path.join(root, path.basename(target)), flags, mode);
      descriptors.set(fd, target);
      return fd;
    }
    if (target === path.dirname(file)) return real.openSync(root, flags, mode);
    return real.openSync(target, flags, mode);
  });
  mock.method(fs, 'writeFileSync', (target, data, options) => {
    if (!descriptors.has(target)) return write(target, data, options);
    // Keep existing payload spies and injected failures before actual writes.
    write(descriptors.get(target), data, { ...options, mode: real.fstatSync(target).mode & 0o777 });
    return real.writeFileSync(target, data, options);
  });
  mock.method(fs, 'closeSync', (fd) => {
    descriptors.delete(fd);
    return real.closeSync(fd);
  });
};

module.exports = { supportConfigDescriptors };
