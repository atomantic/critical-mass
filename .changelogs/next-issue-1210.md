# Unreleased — Fund navigation state safety

## Bug Fixes

- Keep summary data and configuration editing scoped to the selected fund; show a disabled loading/error state with Retry until its own configuration arrives.
- Clear engine badges, lifecycle actions, and restart comparisons on fund switches or failed status reads, with a separate status Retry action.
