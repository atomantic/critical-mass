import React from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import OpenOrdersTable from '../src/components/regime/OpenOrdersTable'
import Systems from '../src/components/Systems'
import { CelestialHierarchyCard } from '../src/components/config/RegimeConfigCards'
import { TIERS, formatTierCapitalRange, formatTierPctRange, formatTierTooltip } from '../../shared/celestial-tiers.mjs'

// Issue #869: every admin surface that describes a celestial tier derives its
// wording from the shared tier table rather than a local copy.
vi.mock('@react-three/fiber', () => ({
  Canvas: () => null,
  useThree: () => ({ camera: {} }),
  useFrame: () => {},
}))
vi.mock('../src/components/celestial/CelestialScene', () => ({ default: () => null }))
afterEach(cleanup)

it('Open Orders tier badge tooltip comes from the shared tier table', () => {
  const nebula = TIERS.find(t => t.name === 'nebula')
  const order = { orderId: 'tp-1', type: 'body_tp', status: 'open', size: 0.01, price: 52000, placedAt: Date.now() - 1000 }
  render(<OpenOrdersTable
    pendingOrdersList={[order]} liveFills={[]} openFillsTruncated={false} dryRunFilled={[]} isDryRun={false}
    celestialBodies={[{ id: 'body-1', tpOrderId: 'tp-1', tier: 'nebula', tpPrice: 52000, costBasis: 450, avgPrice: 50000 }]}
    avgCostBasis={50000} config={{ holdbackRatio: 0.5, feeRate: 0.001 }} priceDecimals={2} asset="BTC"
    isRunning openSearchId="" setTpEditModal={() => {}} setRollUpConfirm={() => {}}
  />)
  // The badge is found by the shared tooltip text; a locally hard-coded copy would not match.
  expect(screen.getByTitle(formatTierTooltip(nebula))).toBeTruthy()
  expect(formatTierTooltip(nebula)).toMatch(/Nebula.*40-50%/)
})

it('Systems tier cards show the shared percentage range for each tier', () => {
  render(<Systems />)
  for (const tier of TIERS) {
    if (!['black_hole', 'galaxy', 'nebula', 'hypergiant', 'sun', 'planet', 'moon', 'asteroid', 'satellite'].includes(tier.name)) continue
    expect(screen.getAllByText(formatTierPctRange(tier)).length).toBeGreaterThan(0)
  }
})

it('the config hierarchy card lists each tier with its shared capital range for the deployment cap', () => {
  render(<CelestialHierarchyCard
    regimeConfig={{ celestialEnabled: true, maxUsdcDeployed: 1000 }} baseCurrency="BTC" defaults={{}}
    handleRegimeChange={() => {}}
  />)
  for (const tier of TIERS) {
    const label = screen.getByText(tier.label)
    expect(within(label.parentElement).getByText(formatTierCapitalRange(tier, 1000))).toBeTruthy()
  }
  // 40-50% of a 1000 cap, stated as dollars rather than a multiple of base size.
  expect(screen.getByText('$400-$500')).toBeTruthy()
  expect(document.body.textContent).not.toContain('× base')
})
