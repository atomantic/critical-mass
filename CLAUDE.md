## Bug Fixing
When fixing bugs, always verify you're editing the correct code path (e.g., derivatives vs trading funds, server vs client) before making changes. Ask for clarification if the affected module is ambiguous.

## Runtime State section in CLAUDE.md
After editing state/data files, check if any running processes (PM2, bot engines) might overwrite the changes. Stop relevant processes before modifying runtime state files.

## Financial Calculations
For P&L and APY calculations, always trace the full data flow from raw fills → aggregation → server calculation → client display. Verify denominator values (day counts, cost basis) are correct before fixing numerator/formatting issues.