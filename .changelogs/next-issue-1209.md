# Issue #1209: Surface Charts tab read failures

The regime Charts tab now reports required status, config, and fills read failures with a retry action instead of presenting default stopped status and empty fill counts. It keeps the last complete snapshot visible after a later refresh failure, marks that snapshot stale, and reports unavailable optional price history while allowing the rest of the dashboard to render.
