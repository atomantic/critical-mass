# Issue #1619: Remove unused exchangeName dependency from registerRegimeIpcHandlers

The regime IPC handler registration no longer accepts or receives the unused `exchangeName` dependency; handlers continue to take `exchange` from each request.
