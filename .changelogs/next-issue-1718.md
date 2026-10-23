# Issue #1718: Regime engine status assembly

Moved dashboard payload construction and pending-order enrichment into a focused engine status module. Status reads still refresh accounting first and use the latest executor, market, position and configuration values; trading and stopped-process status behavior are unchanged.
