/**
 * Planning publisher: Emits opportunities to Planning subsystem via IPC.
 *
 * CANON §Subsystem 5 (Planning): The Drive Engine publishes OPPORTUNITY_CREATED
 * messages via process.send() to the main process, which relays to Planning.
 *
 * Rate-limited: max 5 opportunities per emission cycle (every 100 ticks ~1 second).
 */

import type { DriveIPCMessage } from '@sylphie/shared';
import { DriveIPCMessageType, type OpportunityCreatedPayload } from '@sylphie/shared';
import type { Opportunity } from './opportunity';
import type { IMessageTransport } from './message-transport';

/**
 * PlanningPublisher: Emits opportunity signals via transport.
 */
export class PlanningPublisher {
  constructor(private readonly transport: IMessageTransport) {}

  /**
   * Publish top opportunities to Planning subsystem.
   *
   * Emits OPPORTUNITY_CREATED messages for each opportunity in the list.
   *
   * @param opportunities - Array of top opportunities to emit (pre-sorted by priority)
   */
  public publishOpportunities(opportunities: Opportunity[]): void {
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
                : 'PREDICTION_FAILURE_PATTERN',
            priority:
              opp.classification === 'RECURRING'
                ? 'HIGH'
                : opp.classification === 'HIGH_IMPACT'
                  ? 'MEDIUM'
                  : 'LOW',
            sourceEventId: '',
            affectedDrive: 'cognitiveAwareness' as any,
          },
          timestamp: new Date(),
        };

        this.transport.send(message);
      } catch (err) {
        console.error(`[PlanningPublisher] Error publishing opportunity ${opp.id}: ${err}`);
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
export function getOrCreatePlanningPublisher(transport: IMessageTransport): PlanningPublisher {
  if (!publisher) {
    publisher = new PlanningPublisher(transport);
  }
  return publisher;
}
