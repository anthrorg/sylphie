/**
 * Episodic Memory Consolidation Service Implementation (E5-T004)
 *
 * Identifies mature episodes (age > 2h, confidence > 0.65) and converts them
 * into semantic content for promotion to the World Knowledge Graph. Preserves
 * provenance throughout for the Lesion Test.
 *
 * CANON §Subsystem 1 (Decision Making): Episodic memory consolidation is the
 * bridge between in-memory episode storage and durable WKG knowledge. The
 * conversion is prepared here; the Learning subsystem owns the WKG write.
 *
 * CANON §Provenance: Every semantic conversion preserves the provenance trail:
 * SENSOR (default), GUARDIAN (if guardian feedback), or INFERENCE (if inferred).
 * This distinction is never erased — it enables the Lesion Test.
 */

import { Injectable, Inject, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import type {
  Episode,
  IEpisodicMemoryService,
} from '../interfaces/decision-making.interfaces';
import {
  ConsolidationCandidate,
  SemanticConversion,
  SemanticRelationship,
  ConsolidationResult,
  IConsolidationService,
} from './consolidation.interfaces';
import { EPISODIC_MEMORY_SERVICE, EXECUTOR_ENGINE } from '../decision-making.tokens';
import { EVENTS_SERVICE } from '../../events';
import type { IEventService } from '../../events';
import type { IExecutorEngine } from '../interfaces/decision-making.interfaces';
import type { ProvenanceSource } from '../../shared/types/provenance.types';

// ---------------------------------------------------------------------------
// Consolidation Thresholds
// ---------------------------------------------------------------------------

/** Minimum age (in hours) for an episode to be considered mature. */
const CONSOLIDATION_AGE_THRESHOLD_HOURS = 2;

/** Minimum estimated confidence for consolidation. */
const CONSOLIDATION_CONFIDENCE_THRESHOLD = 0.65;

// ---------------------------------------------------------------------------
// Confidence Estimation (based on ageWeight and encodingDepth)
// ---------------------------------------------------------------------------

/**
 * Estimate the semantic reliability of an episode based on its encoding depth
 * and current ageWeight.
 *
 * The formula rewards deeper encoding (DEEP gets 1.2x boost) and penalizes
 * shallow encoding (SHALLOW gets 0.8x penalty). NORMAL uses ageWeight as-is.
 *
 *   DEEP:   min(1.0, ageWeight * 1.2)
 *   NORMAL: ageWeight
 *   SHALLOW: max(0.4, ageWeight * 0.8)
 *
 * @param episode - The episode to estimate confidence for.
 * @returns Estimated confidence [0.0, 1.0].
 */
function estimateConfidence(episode: Episode): number {
  switch (episode.encodingDepth) {
    case 'DEEP':
      return Math.min(1.0, episode.ageWeight * 1.2);
    case 'NORMAL':
      return episode.ageWeight;
    case 'SHALLOW':
      return Math.max(0.4, episode.ageWeight * 0.8);
    case 'SKIP':
      // SKIP episodes should never reach consolidation (they're null).
      // Return 0 as a safety guard.
      return 0.0;
  }
}

/**
 * Compute the age of an episode in hours since its timestamp.
 *
 * @param episode - The episode to measure.
 * @returns Age in hours as a floating-point number.
 */
function computeAgeHours(episode: Episode): number {
  const nowMs = new Date().getTime();
  const episodeMs = episode.timestamp.getTime();
  const deltaMs = nowMs - episodeMs;
  return deltaMs / (1000 * 60 * 60); // Convert milliseconds to hours
}

// ---------------------------------------------------------------------------
// Entity Extraction
// ---------------------------------------------------------------------------

/**
 * Extract entities (noun phrases, named concepts) from the input summary.
 *
 * Simple tokenization: splits on whitespace, filters short tokens, and
 * capitalizes proper nouns (tokens that start with uppercase). Also includes
 * multi-word noun phrases heuristically (sequences of capitalized tokens or
 * common noun patterns).
 *
 * @param inputSummary - The summary text to extract from.
 * @returns Array of extracted entity strings.
 */
function extractEntities(inputSummary: string): string[] {
  if (!inputSummary || inputSummary.trim().length === 0) {
    return [];
  }

  const tokens = inputSummary.split(/[\s,\.!?;:—–-]+/).filter((t) => t.length > 0);
  const entities: Set<string> = new Set();

  // Single-token entities: proper nouns (capitalized tokens).
  for (const token of tokens) {
    if (token.length > 1 && token[0] === token[0].toUpperCase() && token[0] !== token[0].toLowerCase()) {
      entities.add(token);
    }
  }

  // Multi-token noun phrases: sequences of capitalized tokens.
  // Heuristic: if we have 2+ consecutive capitalized tokens, combine them.
  let currentPhrase: string[] = [];
  for (const token of tokens) {
    const isCapitalized = token.length > 1 && token[0] === token[0].toUpperCase() && token[0] !== token[0].toLowerCase();
    if (isCapitalized) {
      currentPhrase.push(token);
    } else {
      if (currentPhrase.length >= 2) {
        entities.add(currentPhrase.join(' '));
      }
      currentPhrase = [];
    }
  }
  if (currentPhrase.length >= 2) {
    entities.add(currentPhrase.join(' '));
  }

  // Fallback: if no entities extracted, return significant tokens (length > 2).
  if (entities.size === 0) {
    for (const token of tokens) {
      if (token.length > 2) {
        entities.add(token.toLowerCase());
      }
    }
  }

  return Array.from(entities);
}

// ---------------------------------------------------------------------------
// Relationship Extraction
// ---------------------------------------------------------------------------

/**
 * Extract semantic relationships from an episode's context.
 *
 * Creates subject-predicate-object triples representing causal and
 * associative links:
 *   - input → triggered-by action (from actionTaken)
 *   - action → resulted-from input
 *   - drive state → influenced outcome (inferred from driveSnapshot)
 *
 * @param episode - The episode to extract relationships from.
 * @param entities - The entities already extracted from the episode.
 * @returns Array of SemanticRelationship triples.
 */
function extractRelationships(episode: Episode, entities: readonly string[]): SemanticRelationship[] {
  const relationships: SemanticRelationship[] = [];

  // Create a relationship from action to input.
  // Subject: the action that was taken
  // Predicate: the triggering relationship
  // Object: the input that caused it
  if (episode.actionTaken && episode.inputSummary) {
    relationships.push({
      subject: episode.actionTaken,
      predicate: 'responded-to',
      object: episode.inputSummary,
      confidence: estimateConfidence(episode),
    });
  }

  // Create relationships from high-pressure drives to the action.
  // This captures "under high [drive], executed [action]" links.
  const pressureVector = episode.driveSnapshot.pressureVector;
  const highPressureDrives = Object.entries(pressureVector)
    .filter(([_, pressure]) => (pressure as number) > 0.5)
    .map(([driveName]) => driveName);

  for (const driveName of highPressureDrives) {
    relationships.push({
      subject: driveName,
      predicate: 'motivated',
      object: episode.actionTaken,
      confidence: Math.max(0.4, estimateConfidence(episode) - 0.1),
    });
  }

  // Create relationships between extracted entities if we have multiple.
  // This is a heuristic: if we extracted multiple entities, assume they're
  // related within the same episode context.
  if (entities.length >= 2) {
    for (let i = 0; i < Math.min(entities.length - 1, 2); i++) {
      relationships.push({
        subject: entities[i],
        predicate: 'co-occurs-with',
        object: entities[i + 1],
        confidence: estimateConfidence(episode) * 0.9, // Slightly lower for inferred links
      });
    }
  }

  return relationships;
}

// ---------------------------------------------------------------------------
// Provenance Resolution
// ---------------------------------------------------------------------------

/**
 * Determine the provenance of a semantic conversion based on the episode's
 * guardian feedback type.
 *
 * CANON Standard 5 (Guardian Asymmetry): Episodes with guardian feedback
 * elevate to GUARDIAN provenance. Episodes without feedback are INFERENCE.
 *
 * @param episode - The episode being consolidated.
 * @returns The ProvenanceSource for this conversion.
 */
function resolveConversionProvenance(episode: Episode): ProvenanceSource {
  // Check if the episode's drive snapshot has guardian feedback.
  // Guardian feedback presence indicates the action was confirmed/corrected.
  // Default to INFERENCE for unseen episodes.

  // CANON Design: The episode itself doesn't carry guardianFeedback,
  // but the driveSnapshot may have context. For now, we default to INFERENCE
  // unless we have explicit guardian signal (which would come through
  // episode context or a separate guardian feedback flag).
  //
  // TODO: In a full implementation, consolidation might query a guardian
  // feedback store to see if this episode was later confirmed/corrected.
  // For E5-T004, we default to INFERENCE to be conservative.

  return 'INFERENCE';
}

// ---------------------------------------------------------------------------
// ConsolidationService Implementation
// ---------------------------------------------------------------------------

@Injectable()
export class ConsolidationService implements IConsolidationService {
  private readonly logger = new Logger(ConsolidationService.name);

  constructor(
    @Inject(EPISODIC_MEMORY_SERVICE)
    private readonly episodicMemoryService: IEpisodicMemoryService,
    @Inject(EVENTS_SERVICE) private readonly eventsService: IEventService,
    @Inject(EXECUTOR_ENGINE) private readonly executorEngine: IExecutorEngine,
  ) {}

  /**
   * Identify all episodes ready for consolidation.
   *
   * Consolidation criteria:
   *   - Age > 2 hours
   *   - Estimated confidence > 0.65
   *
   * Returns candidates sorted by confidence descending (process highest-confidence first).
   */
  findConsolidationCandidates(): readonly ConsolidationCandidate[] {
    const allEpisodes = this.episodicMemoryService.getRecentEpisodes(
      this.episodicMemoryService.getEpisodeCount(),
    );

    const candidates: ConsolidationCandidate[] = [];

    for (const episode of allEpisodes) {
      const ageHours = computeAgeHours(episode);
      const estimatedConf = estimateConfidence(episode);

      if (ageHours > CONSOLIDATION_AGE_THRESHOLD_HOURS && estimatedConf > CONSOLIDATION_CONFIDENCE_THRESHOLD) {
        candidates.push({
          episode,
          ageHours,
          estimatedConfidence: estimatedConf,
        });
      }
    }

    // Sort by estimated confidence descending.
    candidates.sort((a, b) => b.estimatedConfidence - a.estimatedConfidence);

    return candidates;
  }

  /**
   * Convert an episode into semantic WKG content.
   *
   * Extracts entities and relationships from the episode's inputSummary,
   * actionTaken, and drive state. Returns a SemanticConversion ready for
   * Learning subsystem handoff.
   *
   * Provenance is set to INFERENCE (default for episodic consolidation).
   * Confidence is the estimated confidence of the episode.
   */
  convertToSemantic(episode: Episode): SemanticConversion {
    const entities = extractEntities(episode.inputSummary);
    const relationships = extractRelationships(episode, entities);
    const provenance = resolveConversionProvenance(episode);
    const confidence = estimateConfidence(episode);

    return {
      sourceEpisodeId: episode.id,
      entities,
      relationships,
      provenance,
      confidence,
    };
  }

  /**
   * Consolidate a single candidate episode.
   *
   * 1. Convert the episode to semantic content
   * 2. Log the consolidation intent
   * 3. Return result (WKG write deferred to Learning subsystem)
   *
   * Failures are logged but do not drop the episode; it remains in episodic
   * memory for later retry.
   *
   * Note: Event emission (CONSOLIDATION_CYCLE_STARTED/COMPLETED) is deferred
   * to the Learning subsystem, which owns those events. This service prepares
   * the conversion; Learning handles persistence and event reporting.
   */
  async consolidate(candidate: ConsolidationCandidate): Promise<ConsolidationResult> {
    const { episode } = candidate;

    try {
      // Step 1: Convert to semantic content.
      const conversion = this.convertToSemantic(episode);

      // Step 2: Log the consolidation intent.
      // (In a full system, this would hand off to Learning for WKG write.
      // For E5-T004, we log the intent and defer persistence.)
      this.logger.debug(
        `Consolidating episode ${episode.id}: ` +
        `${conversion.entities.length} entities, ` +
        `${conversion.relationships.length} relationships, ` +
        `provenance=${conversion.provenance}, ` +
        `confidence=${conversion.confidence.toFixed(2)}`,
      );

      return {
        episodeId: episode.id,
        success: true,
        conversionsCreated: 1,
      };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);

      this.logger.error(`Consolidation failed for episode ${episode.id}: ${errorMsg}`, err);

      return {
        episodeId: episode.id,
        success: false,
        conversionsCreated: 0,
        error: errorMsg,
      };
    }
  }

  /**
   * Run a full consolidation cycle.
   *
   * Finds all candidates, consolidates each (in order of confidence),
   * and returns aggregated results.
   */
  async runConsolidationCycle(): Promise<readonly ConsolidationResult[]> {
    const candidates = this.findConsolidationCandidates();

    if (candidates.length === 0) {
      this.logger.debug('No consolidation candidates found.');
      return [];
    }

    this.logger.log(`Starting consolidation cycle with ${candidates.length} candidates.`);

    const results: ConsolidationResult[] = [];

    for (const candidate of candidates) {
      const result = await this.consolidate(candidate);
      results.push(result);
    }

    const successCount = results.filter((r) => r.success).length;
    this.logger.log(`Consolidation cycle complete: ${successCount}/${results.length} succeeded.`);

    return results;
  }
}
