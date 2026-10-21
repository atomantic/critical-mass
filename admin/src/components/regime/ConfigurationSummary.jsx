import React from 'react'
import AggressivenessControl from './AggressivenessControl'
import { ConfigTooltip, CONFIG_TOOLTIPS } from './RegimeHelp'

export default function ConfigurationSummary({ config, exchange, pairQuery, fetchConfig, presets, presetsError, retryPresets, addToast }) {
  return (
    <>
      {config && (
        <div className="bg-gray-800 rounded-lg p-4">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-medium text-gray-400">Configuration Summary</h3>
            {config.dryRun && (
              <span className="px-2 py-0.5 bg-purple-900/50 text-purple-400 text-xs rounded-sm">
                Dry-Run Enabled
              </span>
            )}
          </div>

          {/* Aggressiveness Control */}
          <AggressivenessControl
            key={`${exchange}${pairQuery}`}
            config={config}
            exchange={exchange}
            pairQuery={pairQuery}
            onConfigUpdate={fetchConfig}
            presets={presets}
            presetsError={presetsError}
            retryPresets={retryPresets}
            addToast={addToast}
          />

          <div className="grid grid-cols-3 gap-4 text-xs">
            <div>
              <span className="text-gray-400">Base Size<ConfigTooltip tip={CONFIG_TOOLTIPS.baseSize} align="left" /></span>
              <div className="flex items-center gap-1">
                <span className="text-white">${config.baseSizeUsdc}</span>
                {config.sizeAutoManaged && (
                  <span className="px-1 py-0.5 bg-purple-900/50 text-purple-400 text-xs rounded-sm">Auto</span>
                )}
              </div>
            </div>
            <div>
              <span className="text-gray-400">k Factor<ConfigTooltip tip={CONFIG_TOOLTIPS.kFactor} /></span>
              <div className="text-white">{config.kFactor}</div>
            </div>
            <div>
              <span className="text-gray-400">Entry Offset<ConfigTooltip tip={CONFIG_TOOLTIPS.entryOffset} align="right" /></span>
              <div className="text-white">{config.entryOffsetBps}bps</div>
            </div>
            <div>
              <span className="text-gray-400">Min Interval<ConfigTooltip tip={CONFIG_TOOLTIPS.minInterval} align="left" /></span>
              <div className="text-white">{config.minIntervalMs / 1000}s</div>
            </div>
            <div>
              <span className="text-gray-400">Max Interval<ConfigTooltip tip={CONFIG_TOOLTIPS.maxInterval} /></span>
              <div className="text-white">{config.maxIntervalMs / 60000}m</div>
            </div>
            <div>
              <span className="text-gray-400">TP Range<ConfigTooltip tip={CONFIG_TOOLTIPS.tpRange} align="right" /></span>
              <div className="flex items-center gap-1">
                <span className="text-white">{config.tpMinPercent?.toFixed(4)}% - {config.tpMaxPercent?.toFixed(4)}%</span>
                {config.tpAutoManaged && (
                  <span className="px-1 py-0.5 bg-cyan-900/50 text-cyan-400 text-xs rounded-sm">Auto</span>
                )}
              </div>
            </div>
            <div>
              <span className="text-gray-400">Caution Scale<ConfigTooltip tip={CONFIG_TOOLTIPS.cautionScale} align="left" /></span>
              <div className="text-white">{config.cautionScale}</div>
            </div>
            <div>
              <span className="text-gray-400">Trend Scale<ConfigTooltip tip={CONFIG_TOOLTIPS.trendScale} /></span>
              <div className="text-white">{config.trendScale}</div>
            </div>
            <div>
              <span className="text-gray-400">Max Cycle Buys<ConfigTooltip tip={CONFIG_TOOLTIPS.maxCycleBuys} align="right" /></span>
              <div className="text-white">{config.maxCycleBuys}</div>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
