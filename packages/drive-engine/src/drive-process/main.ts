/**
 * Drive Engine child process entry point.
 *
 * This is the standalone executable that gets forked by child_process.fork()
 * from the main NestJS process. It runs its own event loop and communicates
 * with the parent process via IPC.
 *
 * Responsibilities:
 *   - Listen for inbound IPC messages (ACTION_OUTCOME, SOFTWARE_METRICS, etc.)
 *   - Respond to HEALTH_STATUS pings with process status
 *   - Emit DRIVE_SNAPSHOT after each tick
 *   - Graceful shutdown handler
 *
 * CANON §Drive Isolation: This process is completely isolated from the main
 * NestJS application. It is NOT a NestJS module. It is a standalone Node.js
 * process with its own message loop.
 *
 * Phase 1 Note: This stub handles health checks and message routing. The
 * actual drive computation (tick loop, rule evaluation) will be added in T005.
 */

import {
  DriveIPCMessage,
  DriveIPCMessageType,
  INITIAL_DRIVE_STATE,
  computeTotalPressure,
} from '@sylphie/shared';

// ---------------------------------------------------------------------------
// Child Process State
// ---------------------------------------------------------------------------

let tickCount = 0;
let currentSessionId = 'default';
let isRunning = true;

/**
 * Process incoming messages from the parent process.
 *
 * @param message - The IPC message from parent
 */
function onParentMessage(message: any): void {
  if (!message || typeof message !== 'object') {
    console.error(
      `[DriveEngine] Invalid message from parent: ${JSON.stringify(message)}`,
    );
    return;
  }

  const msg = message as DriveIPCMessage<any>;

  switch (msg.type) {
    case DriveIPCMessageType.SESSION_START:
      handleSessionStart(msg);
      break;

    case DriveIPCMessageType.SESSION_END:
      handleSessionEnd(msg);
      break;

    case DriveIPCMessageType.ACTION_OUTCOME:
      handleActionOutcome(msg);
      break;

    case DriveIPCMessageType.SOFTWARE_METRICS:
      handleSoftwareMetrics(msg);
      break;

    default:
      console.warn(`[DriveEngine] Unknown message type: ${(msg as any).type}`);
  }
}

/**
 * Handle SESSION_START message from parent.
 *
 * Initializes a new session and prepares to emit drive snapshots.
 */
function handleSessionStart(msg: DriveIPCMessage<any>): void {
  const payload = msg.payload;
  currentSessionId = payload.sessionId;
  console.log(`[DriveEngine] Session started: ${currentSessionId}`);

  // Send an immediate HEALTH_STATUS to confirm startup
  sendHealthStatus();
}

/**
 * Handle SESSION_END message from parent.
 *
 * Gracefully ends the current session and sends a final snapshot.
 */
function handleSessionEnd(msg: DriveIPCMessage<any>): void {
  const payload = msg.payload;
  console.log(`[DriveEngine] Session ending: ${payload.sessionId}`);

  // Send a final snapshot before session ends
  sendDriveSnapshot();
}

/**
 * Handle ACTION_OUTCOME message from parent.
 *
 * In Phase 1, we acknowledge the outcome. In Phase 2+ (T005),
 * this will trigger drive rule evaluation and state updates.
 *
 * CANON Standard 2 (Contingency Requirement): We validate that actionId
 * is present, but do not yet apply behavioral contingencies.
 */
function handleActionOutcome(msg: DriveIPCMessage<any>): void {
  const payload = msg.payload;

  if (!payload.actionId) {
    console.error(
      '[DriveEngine] ACTION_OUTCOME missing actionId (CANON Standard 2 violation)',
    );
    return;
  }

  console.log(
    `[DriveEngine] Outcome reported for action ${payload.actionId}: ${payload.outcome}`,
  );

  // TODO (T005): Apply drive rule evaluation and update state
  // For now, acknowledge and continue
}

/**
 * Handle SOFTWARE_METRICS message from parent.
 *
 * In Phase 1, we acknowledge the metrics. In Phase 2+ (T005),
 * this will apply cognitive effort pressure to the CognitiveAwareness drive.
 *
 * CANON Gap 4: cognitiveEffortPressure is the critical field that creates
 * evolutionary pressure toward Type 1 graduation.
 */
function handleSoftwareMetrics(msg: DriveIPCMessage<any>): void {
  const payload = msg.payload;
  console.log(
    `[DriveEngine] Metrics: LLM calls=${payload.llmCallCount}, effort pressure=${payload.cognitiveEffortPressure}`,
  );

  // TODO (T005): Apply cognitive effort pressure to drive state
  // For now, acknowledge and continue
}

/**
 * Send a DRIVE_SNAPSHOT message to the parent process.
 *
 * In Phase 1, this is a stub that sends zeros. In Phase 2+ (T005),
 * this will contain the actual computed drive state from the current tick.
 */
function sendDriveSnapshot(): void {
  // Phase 1: emit INITIAL_DRIVE_STATE on every tick.
  // Real drive computation (rule evaluation, accumulation, decay) deferred to T005.
  const pressureVector = { ...INITIAL_DRIVE_STATE };
  const snapshot = {
    pressureVector,
    timestamp: new Date(),
    tickNumber: tickCount,
    driveDeltas: {
      systemHealth: 0,
      moralValence: 0,
      integrity: 0,
      cognitiveAwareness: 0,
      guilt: 0,
      curiosity: 0,
      boredom: 0,
      anxiety: 0,
      satisfaction: 0,
      sadness: 0,
      focus: 0,
      social: 0,
    },
    ruleMatchResult: {
      ruleId: null,
      eventType: 'TICK',
      matched: false,
    },
    totalPressure: computeTotalPressure(pressureVector),
    sessionId: currentSessionId,
  };

  const message: DriveIPCMessage<any> = {
    type: DriveIPCMessageType.DRIVE_SNAPSHOT,
    payload: { snapshot },
    timestamp: new Date(),
  };

  process.send!(message);
  tickCount++;
}

/**
 * Send a HEALTH_STATUS message to the parent process in response to health checks.
 *
 * Reports process health, current tick, and time since last tick.
 */
function sendHealthStatus(): void {
  const message: DriveIPCMessage<any> = {
    type: DriveIPCMessageType.HEALTH_STATUS,
    payload: {
      healthy: true,
      currentTick: tickCount,
      msSinceLastTick: 0,
      diagnosticMessage: null,
    },
    timestamp: new Date(),
  };

  process.send!(message);
}

/**
 * Graceful shutdown handler.
 *
 * Called when the parent process sends SIGTERM. Cleans up and exits.
 */
function onShutdown(signal: string): void {
  console.log(`[DriveEngine] Received ${signal}, shutting down gracefully`);
  isRunning = false;
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Initialization
// ---------------------------------------------------------------------------

console.log(
  `[DriveEngine] Child process started (PID: ${process.pid}, node ${process.version})`,
);

// Attach IPC message handler
process.on('message', onParentMessage);

// Attach graceful shutdown handlers
process.on('SIGTERM', () => onShutdown('SIGTERM'));
process.on('SIGINT', () => onShutdown('SIGINT'));

// Main drive computation tick loop.
// Emits a DRIVE_SNAPSHOT to the parent process on each tick.
// Phase 1: uses INITIAL_DRIVE_STATE values (real computation deferred to T005).
// 10Hz (100ms) — will increase to 100Hz in T005 once rule evaluation is wired.
const tickInterval = setInterval(() => {
  if (isRunning) {
    sendDriveSnapshot();
  }
}, 100);

// Graceful cleanup on exit
process.on('exit', () => {
  clearInterval(tickInterval);
  console.log('[DriveEngine] Child process exiting');
});

// Prevent the process from exiting (it should run until parent kills it)
// This is necessary because we have no other async operations keeping it alive
process.stdin.resume();
