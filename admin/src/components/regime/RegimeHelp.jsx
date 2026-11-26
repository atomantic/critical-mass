import InfoTooltip from '../InfoTooltip'

// Info icon + help popup for config labels
export function ConfigTooltip({ tip, align = 'center', width = 'w-52' }) {
  return <InfoTooltip tip={tip} align={align} width={width} label="Show help" />
}
