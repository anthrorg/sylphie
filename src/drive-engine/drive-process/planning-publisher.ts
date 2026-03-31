/**
 * Planning publisher: Emits opportunities to Planning subsystem via IPC.
 *
 * CANON §Subsystem 5 (Planning): The Drive Engine publishes OPPORTUNITY_CREATED
 * messages via process.send() to the main process, which relays to Planning.
 *
 * Rate-limited: max 5 opportunities per emission cycle (every 100 ticks ~1 second).
 */

import type { DriveIPCMessage } from '../../shared/types/ipc.types';
import { DriveIPCMessageType, type OpportunityCreatedPayload } from '../../shared/types/ipc.types';
import type { Opportunity } from './opportunity';

/**
 * PlanningPublisher: Emits opportunity signals via IPC.
 */
export class PlanningPublisher {
  constructor() {}

  /**
   * Publish top opportunities to Planning subsystem via IPC.
   *
   * Emits OPPORTUNITY_CREATED messages for each opportunity in the list.
   * Uses process.send() to communicate with parent process (main NestJS).
   *
   * @param opportunities - Array of top opportunities to emit (pre-sorted by priority)
   */
  public publishOpportunities(opportunities: Opportunity[]): void {
    if (typeof process === 'undefined' || !process.send) {
      return; // Not in Node.js child process context
    }

    for (const opp of opportunities) {
      try {
        const message: DriveIPCMessage<OpportunityCreatedPayload> = {
          type: DriveIPCMessageType.OPPORTUNITY_CREATED,
          payload: {
            id: opp.id,
            contextFingerprint: opp.contextFingerprint,
            classification: opp.classification === 'RECURRING'
              ? 'PREDICTION_FAILURE_PATTERN'
              : opp.classification === 'HIGH_IMPACT'
                ? 'HIGH_IMPACT_ONE_OFF'
                : 'PREDICTION_FAILURE_PATTERN', // Fallback for LOW_PRIORITY
            priority:
              opp.classification === 'RECURRING'
                ? 'HIGH'
                : opp.classification === 'HIGH_IMPACT'
                  ? 'MEDIUM'
                  : 'LOW',
            sourceEventId: '', // Will be filled in by Planning if needed
            affectedDrive: 'cognitiveAwareness' as any,
          },
          timestamp: new Date(),
        };

        process.send(message);
      } catch (err) {
        if (process.stderr) {
          process.stderr.write(
            `[PlanningPublisher] Error publishing opportunity ${opp.id}: ${err}\n`,
          );
        }
      }
    }
  }
}

/**
 * Global singleton instance for the Drive Engine process.
 */
let publisher: PlanningPublisher | null = null;

/**
 * Get or create the global publisher instance.
 */
export function getOrCreatePlanningPublisher(): PlanningPublisher {
  if (!publisher) {
    publisher = new PlanningPublisher();
  }
  return publisher;
}
