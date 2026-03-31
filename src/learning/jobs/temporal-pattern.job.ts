/**
 * TemporalPatternJob — learns temporal patterns from consolidation cycles.
 *
 * Implements ILearningJob. Detects behavioral contingencies by analyzing
 * temporal phrase patterns in conversation: when Sylphie produces a phrase,
 * and the guardian responds with another phrase within N turns, a RESPONSE_TO
 * edge is created in the WKG recording this behavioral contingency.
 *
 * CANON §Subsystem 3: Each consolidation cycle executes multiple jobs.
 * This job runs post-consolidation and searches for temporal regularities
 * that can inform future learning and behavior.
 *
 * CANON §Type 2 Cost Requirement: Every call to the Events service counts
 * toward cognitive load. This job reports latency and artifact counts
 * enabling drive pressure tracking.
 *
 * CANON §Guardian Asymmetry (Standard 5): RESPONSE_TO edges created from
 * guardian feedback carry LLM_GENERATED provenance at 0.35 base confidence.
 * Confidence increases with repeated co-occurrence patterns.
 */

import { Inject, Injectable, Logger } from '@nestjs/common';

import type { ILearningJob, JobResult } from '../interfaces/learning.interfaces';
import type { IEventService } from '../../events/interfaces/events.interfaces';
import type { IWkgService } from '../../knowledge/interfaces/knowledge.interfaces';
import { EVENTS_SERVICE } from '../../events/events.tokens';
import { WKG_SERVICE } from '../../knowledge/knowledge.tokens';
import type { EventType, SylphieEvent } from '../../shared/types/event.types';

/**
 * Configuration for temporal pattern detection.
 */
interface TemporalPatternConfig {
  /** Number of turns to look ahead for guardian responses (default 3). */
  readonly windowTurns: number;

  /** Minimum number of occurrences to establish confidence. */
  readonly minOccurrences: number;

  /** Event types to consider as Sylphie utterances. */
  readonly sylphieEventTypes: readonly EventType[];

  /** Event types to consider as guardian responses. */
  readonly guardianEventTypes: readonly EventType[];
}

/**
 * A detected temporal pattern: Sylphie phrase → guardian response.
 */
interface DetectedPattern {
  /** The phrase Sylphie produced. */
  readonly sylphiePhrase: string;

  /** The phrase the guardian responded with. */
  readonly guardianPhrase: string;

  /** How many times this pattern was observed. */
  readonly count: number;

  /** IDs of the events that contributed to this pattern. */
  readonly eventIds: readonly string[];
}

@Injectable()
export class TemporalPatternJob implements ILearningJob {
  private readonly logger = new Logger(TemporalPatternJob.name);

  /** Default configuration for temporal pattern detection. */
  private readonly config: TemporalPatternConfig = {
    windowTurns: 3,
    minOccurrences: 1,
    sylphieEventTypes: ['RESPONSE_DELIVERED', 'SOCIAL_COMMENT_INITIATED'],
    guardianEventTypes: ['INPUT_RECEIVED'],
  };

  constructor(
    @Inject(EVENTS_SERVICE)
    private readonly eventsService: IEventService,
    @Inject(WKG_SERVICE)
    private readonly wkgService: IWkgService,
  ) {}

  /**
   * The human-readable name of this job.
   *
   * @returns Job name
   */
  get name(): string {
    return 'temporal-pattern';
  }

  /**
   * Determine whether this job should run in the current consolidation cycle.
   *
   * Check if there are sufficient conversation events available in recent
   * history to justify pattern detection analysis.
   *
   * @returns True if the job should execute; false to skip.
   */
  shouldRun(): boolean {
    // For now, always run. In a more sophisticated implementation,
    // we would check if there are recent conversation events available.
    return true;
  }

  /**
   * Execute the job and detect temporal patterns.
   *
   * 1. Query recent conversation events (INPUT_RECEIVED, RESPONSE_DELIVERED, etc.)
   * 2. Scan for phrases that co-occur within the window (3 turns)
   * 3. For each detected pattern, create a RESPONSE_TO edge in the WKG
   * 4. Track confidence based on pattern frequency
   *
   * @returns Result of job execution with artifact count, issues, and latency.
   */
  async run(): Promise<JobResult> {
    const startTime = Date.now();
    const issues: string[] = [];
    let artifactCount = 0;

    try {
      this.logger.log(`Starting temporal pattern detection job`);

      // Query recent events for pattern analysis
      // Look back 24 hours for conversation events
      const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

      const allEventTypes: EventType[] = [
        ...this.config.sylphieEventTypes,
        ...this.config.guardianEventTypes,
      ];

      const events = await this.eventsService.query({
        types: allEventTypes,
        startTime: twentyFourHoursAgo,
        limit: 500, // Reasonable upper bound for a single job run
      });

      if (events.length === 0) {
        this.logger.log(`No conversation events found for pattern analysis`);
        return {
          jobName: this.name,
          success: true,
          artifactCount: 0,
          issues: [],
          latencyMs: Date.now() - startTime,
        };
      }

      this.logger.log(
        `Analyzing ${events.length} events for temporal patterns`,
      );

      // Detect patterns in the event sequence
      const patterns = this.detectPatterns(events);

      this.logger.log(
        `Detected ${patterns.length} temporal patterns from events`,
      );

      // Create RESPONSE_TO edges for each detected pattern
      for (const pattern of patterns) {
        try {
          // Sanitize phrases for use as node names/identifiers
          const sylphieNodeName = this.sanitizeNodeName(pattern.sylphiePhrase);
          const guardianNodeName = this.sanitizeNodeName(
            pattern.guardianPhrase,
          );

          // Create or find nodes for the phrases
          // For now, we use the phrase content as the node identifier
          // In production, we might extract entities and link to them instead
          const sylphieResult = await this.wkgService.upsertNode({
            labels: ['Phrase', 'Utterance'],
            nodeLevel: 'INSTANCE',
            provenance: 'LLM_GENERATED',
            initialConfidence: 0.35,
            properties: {
              text: pattern.sylphiePhrase,
              type: 'sylphie_utterance',
            },
          });

          if (sylphieResult.type !== 'success') {
            issues.push(
              `Contradiction creating Sylphie phrase node: ${pattern.sylphiePhrase}`,
            );
            continue;
          }

          const guardianResult = await this.wkgService.upsertNode({
            labels: ['Phrase', 'Utterance'],
            nodeLevel: 'INSTANCE',
            provenance: 'LLM_GENERATED',
            initialConfidence: 0.35,
            properties: {
              text: pattern.guardianPhrase,
              type: 'guardian_utterance',
            },
          });

          if (guardianResult.type !== 'success') {
            issues.push(
              `Contradiction creating guardian phrase node: ${pattern.guardianPhrase}`,
            );
            continue;
          }

          // Create RESPONSE_TO edge: Sylphie phrase → Guardian response
          // Confidence increases with occurrence count
          const baseConfidence = 0.35;
          const frequencyBoost = Math.min(
            0.25,
            pattern.count * 0.05, // +0.05 per occurrence, capped at 0.25
          );
          const edgeConfidence = Math.min(0.60, baseConfidence + frequencyBoost);

          const edgeResult = await this.wkgService.upsertEdge({
            sourceId: sylphieResult.node.id,
            targetId: guardianResult.node.id,
            relationship: 'RESPONSE_TO',
            provenance: 'LLM_GENERATED',
            initialConfidence: edgeConfidence,
            properties: {
              occurrences: pattern.count,
              eventIds: pattern.eventIds,
              detectedAt: new Date().toISOString(),
            },
          });

          if (edgeResult.type === 'success') {
            artifactCount++;
            this.logger.debug(
              `Created RESPONSE_TO edge: "${pattern.sylphiePhrase}" → "${pattern.guardianPhrase}" ` +
                `(occurrences: ${pattern.count}, confidence: ${edgeConfidence.toFixed(2)})`,
            );
          } else {
            issues.push(
              `Contradiction creating RESPONSE_TO edge: "${pattern.sylphiePhrase}" → "${pattern.guardianPhrase}"`,
            );
          }
        } catch (error) {
          const errorMsg =
            error instanceof Error ? error.message : String(error);
          issues.push(
            `Error processing pattern "${pattern.sylphiePhrase}" → "${pattern.guardianPhrase}": ${errorMsg}`,
          );
        }
      }

      this.logger.log(
        `Temporal pattern job completed: ${artifactCount} edges created`,
      );

      return {
        jobName: this.name,
        success: true,
        artifactCount,
        issues,
        latencyMs: Date.now() - startTime,
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.logger.error(`Temporal pattern job failed: ${errorMsg}`, error);

      return {
        jobName: this.name,
        success: false,
        artifactCount,
        issues: [
          ...issues,
          `Job execution failed: ${errorMsg}`,
        ],
        latencyMs: Date.now() - startTime,
        error: errorMsg,
      };
    }
  }

  /**
   * Detect temporal patterns in a sequence of events.
   *
   * Looks for Sylphie utterances followed by guardian responses within
   * the configured window (default 3 turns).
   *
   * @param events - Chronologically ordered events
   * @returns Array of detected patterns with occurrence counts
   */
  private detectPatterns(events: readonly SylphieEvent[]): DetectedPattern[] {
    // Map event type to category for easier checking
    const isSylphieEvent = (evt: SylphieEvent): boolean =>
      this.config.sylphieEventTypes.includes(evt.type);

    const isGuardianEvent = (evt: SylphieEvent): boolean =>
      this.config.guardianEventTypes.includes(evt.type);

    // Pattern accumulation: map of "sylphiePhrase|guardianPhrase" → count & eventIds
    const patternMap = new Map<
      string,
      { count: number; eventIds: string[] }
    >();

    // Scan events in order
    for (let i = 0; i < events.length; i++) {
      const evt = events[i];

      // Is this a Sylphie utterance?
      if (isSylphieEvent(evt)) {
        // Extract text from the event payload
        // Different event types may have different payload structures
        const sylphiePhrase = this.extractPhrase(evt);

        if (!sylphiePhrase) {
          continue; // Skip events with no extractable phrase
        }

        // Look ahead up to windowTurns for a guardian response
        for (
          let j = i + 1;
          j < Math.min(i + this.config.windowTurns + 1, events.length);
          j++
        ) {
          const responseEvt = events[j];

          if (isGuardianEvent(responseEvt)) {
            const guardianPhrase = this.extractPhrase(responseEvt);

            if (guardianPhrase) {
              // Found a pattern! Record it
              const patternKey = `${sylphiePhrase}|${guardianPhrase}`;
              const existing = patternMap.get(patternKey) || {
                count: 0,
                eventIds: [],
              };

              patternMap.set(patternKey, {
                count: existing.count + 1,
                eventIds: [...existing.eventIds, evt.id, responseEvt.id],
              });

              // Move past the guardian event to avoid double-counting
              break;
            }
          }
        }
      }
    }

    // Convert map to array of DetectedPattern objects
    const patterns: DetectedPattern[] = Array.from(patternMap.entries())
      .filter(([, data]) => data.count >= this.config.minOccurrences)
      .map(([key, data]) => {
        const [sylphiePhrase, guardianPhrase] = key.split('|');
        return {
          sylphiePhrase,
          guardianPhrase,
          count: data.count,
          eventIds: data.eventIds,
        };
      });

    return patterns;
  }

  /**
   * Extract text/phrase content from an event based on its type.
   *
   * Different event types have different payload structures. This method
   * normalizes them to extract conversational text.
   *
   * @param evt - The event to extract from
   * @returns The extracted phrase, or empty string if none found
   */
  private extractPhrase(evt: SylphieEvent): string {
    // Most communication events have payload.content or payload.text
    const payload = (evt as { payload?: Record<string, unknown> }).payload;

    if (!payload || typeof payload !== 'object') {
      return '';
    }

    // Try common payload field names
    const content =
      (payload as Record<string, unknown>).content ||
      (payload as Record<string, unknown>).text ||
      (payload as Record<string, unknown>).message ||
      (payload as Record<string, unknown>).input;

    if (typeof content === 'string') {
      return content.trim();
    }

    return '';
  }

  /**
   * Sanitize a phrase for use as a Neo4j node name/identifier.
   *
   * Removes special characters and converts to a clean identifier format.
   * Used as a fallback if we don't have explicit node identifiers.
   *
   * @param phrase - The phrase to sanitize
   * @returns A sanitized version suitable for graph identifiers
   */
  private sanitizeNodeName(phrase: string): string {
    // Take first 50 chars, remove special characters, convert to lowercase
    return phrase
      .substring(0, 50)
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, '')
      .replace(/\s+/g, '_')
      .replace(/-+/g, '_')
      .replace(/_+/g, '_')
      .substring(0, 40); // Final length limit
  }
}
