## CRITICAL: Read Before Modifying Kalshi Strategy Config

**Before changing ANY values in `config.json`** related to Kalshi strategies, read `STRATEGY-GUIDE.md` in this repo root. It documents what has been tried, what failed, and WHY current settings exist. Reverting settings without understanding the context causes the bot to either stop trading entirely or repeat known failure modes.

## Bug Fixing
When fixing bugs, always verify you're editing the correct code path (e.g., derivatives vs trading funds, server vs client) before making changes. Ask for clarification if the affected module is ambiguous.

## Runtime State
**ALWAYS stop the associated engine (PM2) BEFORE modifying any state or data files** (e.g., `regime-state.json`, `fill-ledger.json`). Running engines periodically save state and will silently overwrite your changes. Sequence: stop engine → edit state → place any exchange orders → restart engine. For Gemini specifically, the API key requires heartbeat — orders placed without a running engine or heartbeat process will be auto-cancelled by Gemini within ~5 minutes.

## Financial Calculations
For P&L and APY calculations, always trace the full data flow from raw fills → aggregation → server calculation → client display. Verify denominator values (day counts, cost basis) are correct before fixing numerator/formatting issues.