# Unreleased — Bound outbound DNS validation

## Bug Fixes

- Include endpoint DNS validation and redirect validation in outbound request cancellation, with a 15-second DNS budget for standalone validation.
- Start screenshot and Sentinel classifier deadlines before preliminary validation, releasing timers and listeners and ignoring late resolver completions.
- Keep healthy Sentinel feed results and subsequent polls moving when another feed's resolver stalls, while preserving SSRF, redirect credential and response-size protections.
