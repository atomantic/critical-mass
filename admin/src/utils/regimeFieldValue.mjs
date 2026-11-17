// Single read path for regime config fields shown in the Config form.
//
// The server is the only source of defaults: the fund summary carries
// `regimeDefaults` (a copy of REGIME_DEFAULTS). A field the fund never saved is
// absent from its stored regime block, so it shows the server default. `??`
// (never `||`) so a saved 0 or false is shown as saved, not replaced.
export function fieldValue(config, defaults, key) {
  return config?.[key] ?? defaults?.[key]
}
