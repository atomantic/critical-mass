// Map trade event types to toast types
export function tradeEventToToast(event) {
  const typeMap = {
    starting: { type: 'info', title: `[${event.exchange}] Starting` },
    checking_orders: { type: 'info', title: `[${event.exchange}] Checking Orders` },
    order_filled: { type: 'success', title: `[${event.exchange}] Order Filled` },
    price_check: { type: 'info', title: `[${event.exchange}] Price Check` },
    balance_check: { type: 'info', title: `[${event.exchange}] Balance` },
    buy_placing: { type: 'trade', title: `[${event.exchange}] Placing Buy` },
    buy_placed: { type: 'trade', title: `[${event.exchange}] Buy Placed` },
    buy_filled: { type: 'success', title: `[${event.exchange}] Buy Filled` },
    sell_placed: { type: 'trade', title: `[${event.exchange}] Sell Placed` },
    complete: { type: 'success', title: `[${event.exchange}] Cycle Complete` },
    error: { type: 'error', title: `[${event.exchange}] Error` },
    skipped: { type: 'warning', title: `[${event.exchange}] Skipped` },
    disabled: { type: 'warning', title: `[${event.exchange}] Disabled` },
  }

  const config = typeMap[event.type] || { type: 'info', title: `[${event.exchange}]` }
  return {
    ...config,
    message: event.message,
  }
}
