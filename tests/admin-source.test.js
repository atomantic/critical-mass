const { describe } = require('node:test');

describe('admin no window confirm', () => require('./cases/admin-source/admin-no-window-confirm'));
describe('admin route code splitting', () => require('./cases/admin-source/admin-route-code-splitting'));
describe('admin shared esm', () => require('./cases/admin-source/admin-shared-esm'));
describe('admin shared ui helpers', () => require('./cases/admin-source/admin-shared-ui-helpers'));
describe('admin unaccounted fills scan', () => require('./cases/admin-source/admin-unaccounted-fills-scan'));
describe('celestial reduced motion', () => require('./cases/admin-source/celestial-reduced-motion'));
