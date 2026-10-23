import React from 'react'
import { cleanup, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import LongTermBiasPanel from '../src/components/regime/LongTermBiasPanel'
vi.mock('../src/components/regime/RegimeHelp', () => ({ ConfigTooltip: () => null, LONG_TERM_BIAS_TOOLTIP: null }))
afterEach(() => { cleanup(); sessionStorage.clear() })
const props = {
  exchange: 'gemini', pairQuery: '?pair=BTC-USD', config: { aggressiveness: 'moderate' },
  presets: { conservative: { size: 1 }, moderate: { size: 2 }, aggressive: { size: 3 }, maximum: { size: 4 } },
  bias: { ready: true, score: 0.8, suggestedLevel: 'aggressive', advisory: {
    id: 'stable-1', currentLevel: 'moderate', suggestedLevel: 'aggressive', hours: 6,
  } },
}
it('shows one advisory per fund and stable suggestion, including across remounts, without saving config', () => {
  const addToast = vi.fn()
  const onConfigUpdate = vi.fn()
  const view = render(<LongTermBiasPanel {...props} addToast={addToast} onConfigUpdate={onConfigUpdate} />)
  expect(addToast).toHaveBeenCalledTimes(1)
  expect(addToast.mock.calls[0][0].message).toContain('BTC-USD')
  view.rerender(<LongTermBiasPanel {...props} bias={{ ...props.bias }} addToast={addToast} />)
  expect(addToast).toHaveBeenCalledTimes(1)
  view.unmount()
  render(<LongTermBiasPanel {...props} addToast={addToast} />)
  expect(addToast).toHaveBeenCalledTimes(1)
  render(<LongTermBiasPanel {...props} pairQuery="?pair=ETH-USD" addToast={addToast} />)
  expect(addToast).toHaveBeenCalledTimes(2)
  expect(onConfigUpdate).not.toHaveBeenCalled()
})
it('suppresses stale or unready advisories and safely transitions from missing bias', () => {
  const addToast = vi.fn()
  const view = render(<LongTermBiasPanel {...props} bias={null} addToast={addToast} />)
  view.rerender(<LongTermBiasPanel {...props} bias={{ ...props.bias, ready: false }} addToast={addToast} />)
  view.rerender(<LongTermBiasPanel {...props} config={{ aggressiveness: 'maximum' }} addToast={addToast} />)
  expect(addToast).not.toHaveBeenCalled()
})
