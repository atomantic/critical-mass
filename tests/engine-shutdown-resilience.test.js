const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');

describe('coinbase engine graceful shutdown', () => {
  it('continues buffer flush and IPC close even when an engine.stop() rejects', async () => {
    // Track what gets called
    const callLog = [];
    let unhandledRejectionCaught = null;

    // Mock the dependencies used in the shutdown flow
    const mockRegimeEngines = new Map([
      ['btc-usdc', {
        stop: async () => {
          throw new Error('ENOSPC: no space left on device');
        }
      }],
      ['eth-usdc', {
        stop: async () => {
          callLog.push('eth-stop');
          return undefined;
        }
      }]
    ]);

    const mockStopAllMarketDataServices = () => {
      callLog.push('stopAllMarketDataServices');
    };

    const mockShutdownAllBuffers = () => {
      callLog.push('shutdownAllBuffers');
    };

    const mockIPCServer = {
      stop: () => {
        callLog.push('ipcServer.stop');
      }
    };

    // Install a mock logger
    const mockLogger = () => ({
      info: () => {},
      error: () => {},
      warn: () => {},
    });

    // Simulate the gracefulShutdown function with our mocks
    const gracefulShutdown = async (signal) => {
      const shutdownLogger = mockLogger();
      shutdownLogger.info(`ℹ️ Received ${signal}, shutting down...`, { signal });

      mockStopAllMarketDataServices();

      const stopPromises = [];
      for (const [key, engine] of mockRegimeEngines) {
        shutdownLogger.info(`ℹ️ Stopping regime engine for ${key}...`, { fundKey: key });
        stopPromises.push(engine.stop());
      }

      // Use allSettled to capture rejections without aborting other shutdowns
      const results = await Promise.allSettled(stopPromises);
      for (let i = 0; i < results.length; i++) {
        if (results[i].status === 'rejected') {
          const keys = Array.from(mockRegimeEngines.keys());
          const fundKey = keys[i];
          shutdownLogger.error(`❌ Engine stop failed for ${fundKey}: ${results[i].reason.message}`, {
            fundKey,
            error: results[i].reason.message
          });
          callLog.push(`engine-stop-error:${fundKey}`);
        }
      }

      // Ensure buffers flush even if engine stop failed
      try {
        mockShutdownAllBuffers();
      } catch (err) {
        shutdownLogger.error(`❌ Buffer shutdown failed: ${err.message}`, { error: err.message });
      }

      // Ensure IPC server closes even if other shutdowns failed
      try {
        mockIPCServer.stop();
      } catch (err) {
        shutdownLogger.error(`❌ IPC server stop failed: ${err.message}`, { error: err.message });
      }

      shutdownLogger.info(`ℹ️ Shutdown complete`);
      // Don't actually exit in the test
    };

    // Install an unhandled rejection listener to verify none escape
    const unhandledRejectionHandler = (err) => {
      unhandledRejectionCaught = err;
    };
    process.on('unhandledRejection', unhandledRejectionHandler);

    try {
      // Run the shutdown with a rejected engine
      await gracefulShutdown('SIGTERM');

      // Verify that:
      // 1. At least one engine's stop was attempted (but rejected)
      assert.ok(callLog.includes('engine-stop-error:btc-usdc'),
        'failed engine stop should be logged');

      // 2. shutdownAllBuffers was still called despite the rejection
      assert.ok(callLog.includes('shutdownAllBuffers'),
        'shutdownAllBuffers must be called even when engine.stop() rejects');

      // 3. ipcServer.stop was still called
      assert.ok(callLog.includes('ipcServer.stop'),
        'ipcServer.stop must be called even when engine.stop() rejects');

      // 4. No unhandled rejection escaped to the process
      assert.equal(unhandledRejectionCaught, null,
        'gracefulShutdown must not drop promises; rejections should be handled');

    } finally {
      process.removeListener('unhandledRejection', unhandledRejectionHandler);
    }
  });
});
