## Reliability Improvements

- Track accepted background AI runs and backtest optimizer jobs in the gateway shutdown drain, ensuring SIGTERM allows acknowledged jobs to persist output, metadata, and cache before listener closure and process exit.
