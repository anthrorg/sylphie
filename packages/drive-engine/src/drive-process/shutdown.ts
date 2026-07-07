/**
 * Graceful shutdown helper for the Drive Engine child process — TK-137.
 *
 * Extracted from main.ts so the ordering (await the checkpoint save, THEN
 * exit) is unit-testable without importing main.ts, which has import-time
 * side effects (spawns the engine and starts the tick loop immediately).
 *
 * Previously main.ts's onShutdown() called `engine.stop()` (async — awaits
 * a checkpoint save to TimescaleDB) WITHOUT awaiting it, then immediately
 * called `process.exit(0)` synchronously — a race between the in-flight
 * checkpoint save and the process actually exiting. On a fast exit, the
 * save could be aborted mid-write, corrupting or losing the last snapshot.
 */

export interface StoppableEngine {
  stop(): Promise<void>;
}

/**
 * Stop the engine (awaiting its checkpoint save) and only then exit.
 *
 * @param engine - The engine to stop.
 * @param signal - The signal that triggered shutdown (for logging).
 * @param exit - Exit callback (defaults to process.exit); injectable for tests.
 * @param log - Logger (defaults to console); injectable for tests.
 */
export async function gracefulShutdown(
  engine: StoppableEngine,
  signal: string,
  exit: (code: number) => void = (code) => process.exit(code),
  log: (msg: string) => void = (msg) => console.log(msg),
): Promise<void> {
  log(`[DriveEngine] Received ${signal}, shutting down gracefully`);
  try {
    await engine.stop();
  } catch (err) {
    console.error(`[DriveEngine] Error during shutdown: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    exit(0);
  }
}
