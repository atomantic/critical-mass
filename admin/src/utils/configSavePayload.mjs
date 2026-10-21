// Fields whose value differs from the baseline. Values are plain JSON, so a
// serialized comparison covers nested arrays/objects.
const changedFields = (draft = {}, baseline = {}) => Object.fromEntries(
  Object.entries(draft).filter(([key, value]) => JSON.stringify(value) !== JSON.stringify(baseline?.[key]))
)

// A full save sends only what the operator changed since the draft was loaded
// (#1395). The engine writes regime values (maxUsdcDeployed on every take-profit
// credit, optimizer outputs) while a dirty draft stops refreshing; re-sending the
// draft's stale copy would revert them on disk and in the live engine.
export const buildSavePayload = (draft, baseline) => {
  const { regime, ...fund } = draft
  const payload = changedFields(fund, baseline)
  if (regime) {
    // Depth protection has no production market-data input yet. Keep legacy
    // values in the draft/readback, but never send them as active UI edits.
    const { minDepthUsdc, depthPauseMs, ...editableRegime } = changedFields(regime, baseline?.regime)
    if (Object.keys(editableRegime).length) payload.regime = editableRegime
  }
  return payload
}
