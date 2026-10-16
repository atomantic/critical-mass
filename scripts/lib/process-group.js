// Stop residual members of an owned POSIX process group after its direct child
// closes. Closed stdio does not prove that unref'ed descendants have stopped.
const { setTimeout: delay } = require('node:timers/promises');

async function stopProcessGroup(pid) {
  if (!pid) return;
  try {
    process.kill(-pid, 'SIGKILL');
  } catch (error) {
    if (error.code === 'ESRCH') return;
    // Darwin can report EPERM while a killed orphan is being reaped. This is
    // not success: probe until the group disappears, or report cleanup failure.
    if (error.code !== 'EPERM') throw error;
  }
  const deadline = Date.now() + 1000;
  for (;;) {
    try {
      process.kill(-pid, 0);
    } catch (error) {
      if (error.code === 'ESRCH') return;
      if (error.code !== 'EPERM') throw error;
    }
    if (Date.now() >= deadline) throw new Error('owned process group did not stop');
    await delay(10);
  }
}

module.exports = { stopProcessGroup };
