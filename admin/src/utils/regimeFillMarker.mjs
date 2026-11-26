export function deriveFillMarker(status) {
  if (!status) return ''
  const pos = status.position
  return [
    pos?.cyclesCompleted ?? '',
    pos?.cycleBuys ?? '',
    pos?.realizedPnL ?? '',
    pos?.realizedAssetPnL ?? '',
    pos?.lastFillId ?? status.lastFillId ?? '',
    pos?.lastFillTime ?? status.lastFillTime ?? '',
    pos?.fillCount ?? status.fillCount ?? '',
  ].join(':')
}
