# React 19 admin rendering

The admin app uses React/React DOM/types 19, React Three Fiber 9, Drei 10
and React Three Postprocessing 3. These majors must be upgraded together to
preserve renderer peer compatibility. The existing icon package remains
compatible and does not need a major upgrade for this migration.

Charts have no third-party charting dependency. `admin/src/lib/chart-math.js`
owns the scales, nice ticks, local-time ticks, monotone-x paths, bins and
time formatting (ported from d3 7.9), and `admin/src/components/charts/primitives/`
owns the axis, grid, tooltip, legend, reference-line and responsive pieces
plus `CartesianChart`, the line/area frame the BTC price, backtest and
scorecard charts use. BTC candles, Atomoku clouds and signal markers read
that frame's own scales through `usePriceChartCoordinates`. The main price
chart uses a unique index category and formats ticks/tooltips with the
original time label, so repeated labels across days occupy distinct
coordinates. The backtest portfolio grid explicitly selects its USD axis.

`admin/tests/fixtures/d3-parity.json` is the frozen output of d3 and of the
former d3 charts for flat, monotonic, spiky, two-point, one-point and empty
fixtures (`admin/tests/fixtures/chart-series.js`); `chart-math-parity` and
`chart-parity` hold the owned code to it within 1e-6. d3 is no longer
installed, so the snapshot cannot be regenerated — add new fixture cases
rather than editing the existing ones.

Reference: [Fiber React 19 migration](https://r3f.docs.pmnd.rs/tutorials/v9-migration-guide).

Run the ordinary tests and production build:

```sh
npm test
npm run build
```

For browser rendering, with Chrome/Chromium already installed:

```sh
node tests/admin-react19-browser-smoke.js
node scripts/perf-browser-audit.js --json
```

Set `CM_PERF_CHROME` to an installed Chrome executable if automatic discovery
does not find one. Neither command downloads a browser. The rendering smoke
builds a dedicated synthetic fixture in external temporary storage, binds an
ephemeral loopback HTTP server, and uses a separate disposable browser profile.
It checks StrictMode, repeated-label candle/cloud/signal coordinates, responsive
resize, the actual BTC chart and candle hook, all Celestial tiers with actual
WebGL draw calls, empty data and unmount cleanup. Missing Chrome or WebGL fails
the smoke check. It never contacts an exchange or reads operator credentials/data.

The gateway performance command exercises real protected-shell navigation,
transport cleanup and reconnect against its
own synthetic installation. Its default 60-second idle window is required for
a PASS; see [the audit contract](perf-route-audit.md). Neither fixture establishes
production latency or visual behavior on every GPU/browser.
