/**
 * OpportunityResearchService — implementation of IOpportunityResearchService.
 *
 * Queries TimescaleDB for prior failure history and the WKG for contextual
 * knowledge nodes relevant to an Opportunity's contextFingerprint. Assembles
 * both into a ResearchResult for the simulation phase.
 *
 * CANON §Subsystem 5 (Planning): Research gathers evidence from two sources:
 * 1. TimescaleDB: Prior prediction failures for the same context fingerprint
 * 2. WKG: Contextual knowledge nodes related to the opportunity
 *
 * The evidence strength is a weighted combination of failure frequency, unique
 * discrepancies discovered, freshness (new opportunities get a bonus), and
 * prior planning attempts on the same context.
 *
 * Provided under the OPPORTUNITY_RESEARCH_SERVICE token by PlanningModule.
 * Internal — not exported from the module barrel.
 */

import { Injectable, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type {
  IOpportunityResearchService,
  ResearchResult,
} from '../interfaces/planning.interfaces';
import type { Opportunity } from '../../drive-engine/interfaces/drive-engine.interfaces';
import { EVENTS_SERVICE, type IEventService, createPlanningEvent } from '../../events';
import { WKG_SERVICE, type IWkgService } from '../../knowledge';
import { DRIVE_STATE_READER, type IDriveStateReader } from '../../drive-engine';
import type { AppConfig } from '../../shared/config/app.config';
import { PlanningException } from '../exceptions/planning.exceptions';

@Injectable()
export class OpportunityResearchService implements IOpportunityResearchService {
  constructor(
    private readonly configService: ConfigService<AppConfig>,
    @Inject(EVENTS_SERVICE) private readonly eventsService: IEventService,
    @Inject(WKG_SERVICE) private readonly wkgService: IWkgService,
    @Inject(DRIVE_STATE_READER) private readonly driveStateReader: IDriveStateReader,
  ) {}

  /**
   * Gather evidence for an Opportunity from TimescaleDB and the WKG.
   *
   * Process:
   * 1. Retrieve config parameters (research window, minimum failures)
   * 2. Query TimescaleDB for prediction failure events matching the context
   * 3. Count failures and extract discrepancy descriptions
   * 4. Query WKG for relevant contextual knowledge nodes
   * 5. Check for prior planning attempts on the same context
   * 6. Compute evidence strength from multiple signals
   * 7. Emit research event and return result
   *
   * @param opportunity - The opportunity to research
   * @returns ResearchResult with evidence assessment
   * @throws PlanningException if queries fail
   */
  async research(opportunity: Opportunity): Promise<ResearchResult> {
    const appConfig = this.configService.get<AppConfig>('app');
    const config = appConfig?.planning;
    if (!config) {
      throw new PlanningException('Planning configuration not available');
    }

    const { researchTimeWindowDays, minFailuresForEvidence } = config;
    const driveSnapshot = this.driveStateReader.getCurrentState();

    try {
      // 1. Query TimescaleDB for prediction failure events
      const failureEvents = await this.eventsService.queryPattern({
        contextFingerprint: opportunity.contextFingerprint,
        eventTypes: ['PREDICTION_EVALUATED'],
        windowDays: researchTimeWindowDays,
        minOccurrences: 1,
      });

      // 2. Filter for failures (absoluteError > 0.15)
      // Cast to PredictionEvaluatedEvent to access absoluteError
      const failures = failureEvents.filter((event) => {
        const predEvent = event as any; // Cast to access absoluteError
        return predEvent.absoluteError !== undefined && predEvent.absoluteError > 0.15;
      });
      const failureCount = failures.length;

      // 3. Extract discrepancy descriptions from failures
      const discrepancies: string[] = [];
      for (const failure of failures) {
        const predEvent = failure as any; // Cast to access absoluteError
        if (predEvent.absoluteError !== undefined) {
          discrepancies.push(
            `Prediction error of ${(predEvent.absoluteError * 100).toFixed(1)}% in context`,
          );
        }
      }
      // Deduplicate while preserving unique patterns
      const uniqueDiscrepancies = Array.from(new Set(discrepancies));

      // 4. Query WKG for relevant context knowledge
      const contextKnowledge: string[] = [];
      try {
        // Try to find nodes that might relate to the context fingerprint
        // by querying for nodes with relevant labels/properties
        const subgraph = await this.wkgService.querySubgraph(
          {
            // Use lenient filtering to capture relevant context
            minConfidence: 0.30, // Lower threshold to get more context
            limit: 20,
          },
          20,
        );

        for (const node of subgraph.nodes) {
          if (node.properties.name) {
            contextKnowledge.push(String(node.properties.name));
          } else if (node.labels && node.labels.length > 0) {
            contextKnowledge.push(node.labels[0]);
          }
        }
      } catch {
        // If WKG query fails, continue with empty context knowledge
        // (not a hard error — research can proceed with just failure history)
      }

      // 5. Query TimescaleDB for prior planning attempts on this context
      const priorPlanEvents = await this.eventsService.queryPattern({
        contextFingerprint: opportunity.contextFingerprint,
        eventTypes: ['PLAN_CREATED'],
        windowDays: researchTimeWindowDays,
        minOccurrences: 1,
      });
      const priorAttempts = priorPlanEvents.length;

      // 6. Compute evidence strength from weighted signals
      const failureContribution = Math.min(0.40, failureCount * 0.10);
      const discrepancyContribution = Math.min(
        0.30,
        uniqueDiscrepancies.length > 0
          ? 0.30 * (uniqueDiscrepancies.length / (failures.length || 1))
          : 0,
      );
      const freshOpportunityBonus = priorAttempts === 0 ? 0.20 : 0;
      const priorFailureContribution = Math.min(0.30, priorAttempts * 0.10);

      const evidenceStrength = Math.min(
        1.0,
        failureContribution + discrepancyContribution + freshOpportunityBonus + priorFailureContribution,
      );

      const hasSufficientEvidence = failureCount >= minFailuresForEvidence;

      // 7. Emit event
      if (hasSufficientEvidence) {
        const researchEvent = (createPlanningEvent as any)('RESEARCH_COMPLETED', {
          sessionId: appConfig?.app.sessionId || 'default',
          driveSnapshot,
        });
        await this.eventsService.record(researchEvent);
      } else {
        const researchEvent = (createPlanningEvent as any)('RESEARCH_INSUFFICIENT', {
          sessionId: appConfig?.app.sessionId || 'default',
          driveSnapshot,
        });
        await this.eventsService.record(researchEvent);
      }

      return {
        hasSufficientEvidence,
        failureCount,
        discrepancies: uniqueDiscrepancies,
        priorAttempts,
        evidenceStrength,
        contextKnowledge,
      };
    } catch (error) {
      if (error instanceof PlanningException) {
        throw error;
      }
      throw new PlanningException(
        `Research phase failed for opportunity ${opportunity.id}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
