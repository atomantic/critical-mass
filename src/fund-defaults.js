'use strict';

// Single source for the default USDC deployment cap used when a fund config
// omits `maxUsdcDeployed`. Leaf module (no requires) so it can be imported by
// config-utils.js and the APY/state/regime code without a circular require.
const DEFAULT_MAX_USDC_DEPLOYED = 10000;

module.exports = { DEFAULT_MAX_USDC_DEPLOYED };
