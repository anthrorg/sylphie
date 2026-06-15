/**
 * ConsolidationService — Episodic memory consolidation.
 *
 * CANON §Subsystem 1 (Decision Making): Episodic memory consolidation is the
 * bridge between in-memory episode storage and durable WKG knowledge. This
 * service identifies mature episodes (age > 2h, estimatedConfidence > 0.65),
 * extracts semantic content from them, and prepares SemanticConversion records
 * for the Learning subsystem to persist to the WKG.
 *
 * This service does NOT write to the WKG directly. It returns data structures
 * that the Learning subsystem owns and persists. The boundary is explicit:
 * ConsolidationService is internal to DecisionMakingModule.
 *
 * Confidence estimation by encoding depth:
 *   DEEP:    min(1.0, ageWeight * 1.2)
 *   NORMAL:  ageWeight
 *   SHALLOW: max(0.4, ageWeight * 0.8)
 *
 * Entity extraction: simple whitespace tokenisation of inputSummary, selecting
 * proper-noun candidates (title-cased tokens or multi-word capitalised phrases)
 * that are >= 2 characters.
 *
 * Relationship extraction: subject-predicate-object triples derived from the
 * episode's action context: (inputSummary -> actionTaken) and
 * (actionTaken -> predicted_effect) where available.
 *
 * Adapted from sylphie-old:
 * - Type imports from @sylphie/shared instead of local definitions.
 * - Event logging via DECISION_EVENT_LOGGER.
 *
 * Provenance (Wave 3 / C5, §2.12, CANON Std-2): semantic provenance is derived
 * from `episode.source` (+ `visualContext` sub-field provenance for perception
 * episodes), NOT a hardcoded INFERENCE blanket. `visualContext` is carried
 * through onto the SemanticConversion so visual grounding survives. NOTE: this
 * service produces SemanticConversion *records only* and does NOT itself mint
 * groundable WKG nodes (see runConsolidationCycle — the result is consumed for
 * event logging/counts), so no `:Candidate` routing is required here; see the
 * C5 report for the no-op evidence.
 */

import { Injectable, Inject, Logger, Optional } from '@nestjs/common';
import type {
  Episode,
  ConsolidationCandidate,
  SemanticConversion,
  SemanticRelationship,
  ConsolidationResult,
  EncodingDepth,
  DriveSnapshot,
  ProvenanceSource,
  VisualContext,
} from '@sylphie/shared';
import type {
  IConsolidationService,
  IEpisodicMemoryService,
  IDecisionEventLogger,
} from '../interfaces/decision-making.interfaces';
import {
  EPISODIC_MEMORY_SERVICE,
  DECISION_EVENT_LOGGER,
} from '../decision-making.tokens';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Minimum episode age in hours before it qualifies for consolidation. */
const MIN_AGE_HOURS = 2;

/** Minimum estimated confidence required for a consolidation candidate. */
const MIN_CONFIDENCE_THRESHOLD = 0.65;

/**
 * Derive the honest provenance of consolidated semantic content from the
 * episode's modality (`episode.source`) and, for perception episodes, the
 * per-sub-field provenance carried on `episode.visualContext` (WS5 T1.2).
 *
 * CANON Std-2 (provenance-required): a perception-derived memory (scene labels,
 * a VLM caption) must NOT be laundered into a blanket `INFERENCE` tag. The old
 * `EXTRACTION_PROVENANCE = 'INFERENCE'` constant did exactly that — this fix
 * replaces it with the real source.
 *
 * Mapping (deliberately never `GUARDIAN` — consolidation extractions are
 * machine-derived, never guardian-taught):
 *   - `'perception'` with directly-observed `sceneLabels` (YOLO/tracker)
 *       → `SENSOR` (the strongest, directly-observed signal on the frame).
 *   - `'perception'` with only a VLM `caption` and no scene labels
 *       → `LLM_GENERATED` (the caption's own per-sub-field provenance).
 *   - `'perception'` with neither (e.g. a bare face frame)
 *       → `SENSOR` (it was *seen*, not inferred — never the INFERENCE blanket).
 *   - `'conversation'` → `LLM_GENERATED` (extracted from a text/voice turn;
 *       matches the WS5 T2 recall surface, which derives provenance from
 *       `episode.source` rather than the old hardcoded medium-trust default).
 *   - `'legacy'` / unknown → `INFERENCE` (honest "we cannot positively
 *       attribute the modality" floor — the only case the old blanket was right).
 */
function deriveConsolidationProvenance(episode: Episode): ProvenanceSource {
  if (episode.source === 'perception') {
    const vc: VisualContext | undefined = episode.visualContext;
    if (vc?.sceneLabels && vc.sceneLabels.length > 0) return 'SENSOR';
    if (vc?.caption) return vc.caption.provenanceSource; // 'LLM_GENERATED'
    return 'SENSOR';
  }
  if (episode.source === 'conversation') return 'LLM_GENERATED';
  // 'legacy' / any future unknown source: honest inference floor.
  return 'INFERENCE';
}

// ---------------------------------------------------------------------------
// ConsolidationService
// ---------------------------------------------------------------------------

@Injectable()
export class ConsolidationService implements IConsolidationService {
  private readonly logger = new Logger(ConsolidationService.name);

  constructor(
    @Inject(EPISODIC_MEMORY_SERVICE)
    private readonly episodicMemory: IEpisodicMemoryService,

    @Optional()
    @Inject(DECISION_EVENT_LOGGER)
    private readonly eventLogger: IDecisionEventLogger | null,
  ) {}

  // ---------------------------------------------------------------------------
  // IConsolidationService — findConsolidationCandidates
  // ---------------------------------------------------------------------------

  /**
   * Identify all episodes in episodic memory that are ready for consolidation.
   *
   * Qualification criteria:
   *   - Age > 2 hours since encoding timestamp.
   *   - Estimated confidence > 0.65 (computed from ageWeight and encodingDepth).
   *
   * Candidates are returned in descending order of estimatedConfidence.
   *
   * @returns Array of consolidation candidates. Empty if no episodes qualify.
   */
  findConsolidationCandidates(): readonly ConsolidationCandidate[] {
    const now = Date.now();
    const allEpisodes = this.episodicMemory.getRecentEpisodes(50);
    const candidates: ConsolidationCandidate[] = [];

    for (const episode of allEpisodes) {
      const ageMs = now - episode.timestamp.getTime();
      const ageHours = ageMs / (1000 * 60 * 60);

      if (ageHours <= MIN_AGE_HOURS) continue;

      const estimatedConfidence = estimateConfidence(episode.ageWeight, episode.encodingDepth);

      if (estimatedConfidence <= MIN_CONFIDENCE_THRESHOLD) continue;

      candidates.push({ episode, ageHours, estimatedConfidence });
    }

    // Sort descending by estimatedConfidence.
    candidates.sort((a, b) => b.estimatedConfidence - a.estimatedConfidence);

    return candidates;
  }

  // ---------------------------------------------------------------------------
  // IConsolidationService — convertToSemantic
  // ---------------------------------------------------------------------------

  /**
   * Convert an episode into semantic WKG content.
   *
   * Entity extraction: tokenises inputSummary and actionTaken, selecting
   * title-cased tokens (potential proper nouns) with length >= 2.
   *
   * Relationship extraction: produces two subject-predicate-object triples:
   *   1. inputSummary (truncated) -> "triggered" -> actionTaken
   *   2. actionTaken -> "produced" -> "observed_outcome"
   *
   * Provenance: derived from `episode.source` via deriveConsolidationProvenance
   * (CANON Std-2, §2.12) — perception scene-labels → SENSOR, a VLM caption →
   * LLM_GENERATED, conversation → LLM_GENERATED, legacy/unknown → INFERENCE.
   * Never GUARDIAN (machine-derived, not guardian-taught).
   *
   * Confidence: derived from the episode's estimatedConfidence (computed
   * from ageWeight and encodingDepth).
   *
   * @param episode - The episode to convert.
   * @returns A SemanticConversion with extracted entities and relationships.
   */
  convertToSemantic(episode: Episode): SemanticConversion {
    const confidence = estimateConfidence(episode.ageWeight, episode.encodingDepth);
    // CANON Std-2: derive honest provenance from the episode's modality, not a
    // hardcoded INFERENCE blanket (§2.12 fix).
    const provenance = deriveConsolidationProvenance(episode);
    const entities = extractEntities(episode.inputSummary, episode.actionTaken);
    const relationships = extractRelationships(episode, confidence, provenance);

    return {
      sourceEpisodeId: episode.id,
      entities,
      relationships,
      provenance,
      confidence,
      // Attach visual grounding context so it survives consolidation (§2.12).
      // Only perception episodes carry it; absent otherwise.
      ...(episode.visualContext ? { visualContext: episode.visualContext } : {}),
    };
  }

  // ---------------------------------------------------------------------------
  // IConsolidationService — consolidate
  // ---------------------------------------------------------------------------

  /**
   * Consolidate a single candidate episode.
   *
   * Converts the candidate to a SemanticConversion, logs the intent to the
   * event backbone (so the Learning subsystem can observe it), and returns
   * a ConsolidationResult. Does not write to the WKG — that is the Learning
   * subsystem's responsibility.
   *
   * @param candidate - The consolidation candidate to process.
   * @returns ConsolidationResult with success flag and conversion count.
   */
  async consolidate(candidate: ConsolidationCandidate): Promise<ConsolidationResult> {
    try {
      const conversion = this.convertToSemantic(candidate.episode);

      this.emitConsolidationAttempted(candidate, conversion);

      this.logger.debug(
        `Consolidated episode ${candidate.episode.id}: ` +
          `${conversion.entities.length} entities, ` +
          `${conversion.relationships.length} relationships ` +
          `(confidence=${conversion.confidence.toFixed(3)})`,
      );

      return {
        episodeId: candidate.episode.id,
        success: true,
        conversionsCreated: conversion.relationships.length,
      };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `Consolidation failed for episode ${candidate.episode.id}: ${errorMsg}`,
      );
      return {
        episodeId: candidate.episode.id,
        success: false,
        conversionsCreated: 0,
        error: errorMsg,
      };
    }
  }

  // ---------------------------------------------------------------------------
  // IConsolidationService — runConsolidationCycle
  // ---------------------------------------------------------------------------

  /**
   * Run a full consolidation cycle.
   *
   * Finds all candidates in episodic memory, consolidates each sequentially,
   * and returns aggregated results. Failures on individual episodes do not
   * abort the remaining candidates.
   *
   * @returns Array of ConsolidationResult, one per consolidated episode.
   */
  async runConsolidationCycle(): Promise<readonly ConsolidationResult[]> {
    const candidates = this.findConsolidationCandidates();

    if (candidates.length === 0) {
      this.logger.debug('Consolidation cycle: no candidates found');
      return [];
    }

    this.logger.log(`Consolidation cycle: processing ${candidates.length} candidate(s)`);

    const results: ConsolidationResult[] = [];
    for (const candidate of candidates) {
      const result = await this.consolidate(candidate);
      results.push(result);
    }

    const successCount = results.filter((r) => r.success).length;
    this.logger.log(
      `Consolidation cycle complete: ${successCount}/${candidates.length} succeeded`,
    );

    return results;
  }

  // ---------------------------------------------------------------------------
  // Private — event emission
  // ---------------------------------------------------------------------------

  /**
   * Emit a CONSOLIDATION_ATTEMPTED event via the optional event logger.
   * Safe when eventLogger is null.
   */
  private emitConsolidationAttempted(
    candidate: ConsolidationCandidate,
    conversion: SemanticConversion,
  ): void {
    if (!this.eventLogger) return;

    // Consolidation events log against the episode's own drive snapshot.
    const driveSnapshot: DriveSnapshot = candidate.episode.driveSnapshot;

    try {
      this.eventLogger.log(
        'CONSOLIDATION_ATTEMPTED',
        {
          episodeId: candidate.episode.id,
          ageHours: candidate.ageHours,
          estimatedConfidence: candidate.estimatedConfidence,
          entitiesExtracted: conversion.entities.length,
          relationshipsExtracted: conversion.relationships.length,
          provenance: conversion.provenance,
        },
        driveSnapshot,
        driveSnapshot.sessionId,
      );
    } catch (err) {
      this.logger.warn(`Failed to emit CONSOLIDATION_ATTEMPTED event: ${err}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Pure utility functions
// ---------------------------------------------------------------------------

/**
 * Estimate the semantic confidence of an episode based on its ageWeight and
 * encoding depth.
 *
 * DEEP:    min(1.0, ageWeight * 1.2)  — deeply encoded episodes get a bonus
 * NORMAL:  ageWeight                  — straight weight
 * SHALLOW: max(0.4, ageWeight * 0.8)  — floored at 0.4 to avoid zero-confidence
 * SKIP:    0.0                         — never consolidated (gate should prevent this)
 */
function estimateConfidence(ageWeight: number, depth: EncodingDepth): number {
  switch (depth) {
    case 'DEEP':
      return Math.min(1.0, ageWeight * 1.2);
    case 'NORMAL':
      return ageWeight;
    case 'SHALLOW':
      return Math.max(0.4, ageWeight * 0.8);
    case 'SKIP':
      return 0.0;
  }
}

/**
 * Extract candidate entity strings from episode text fields.
 *
 * Tokenises inputSummary and actionTaken. Title-cased tokens (first character
 * uppercase, not all-uppercase acronyms) with length >= 2 are treated as
 * potential proper nouns / named entities. Duplicates are removed.
 */
function extractEntities(inputSummary: string, actionTaken: string): readonly string[] {
  const combined = `${inputSummary} ${actionTaken}`;
  const tokens = combined.split(/\s+/).filter(Boolean);
  const seen = new Set<string>();
  const entities: string[] = [];

  for (const token of tokens) {
    // Strip leading/trailing punctuation.
    const clean = token.replace(/^[^a-zA-Z0-9]+|[^a-zA-Z0-9]+$/g, '');
    if (clean.length < 2) continue;

    // Title-cased: first char uppercase, not all-caps.
    const firstChar = clean[0];
    if (firstChar === firstChar.toUpperCase() && clean !== clean.toUpperCase()) {
      const normalised = clean.toLowerCase();
      if (!seen.has(normalised)) {
        seen.add(normalised);
        entities.push(clean);
      }
    }
  }

  return entities;
}

/**
 * Extract subject-predicate-object relationship triples from an episode.
 *
 * Two triples are produced:
 *   1. inputSummary (truncated to 80 chars) -> "triggered" -> actionTaken
 *   2. actionTaken -> "produced" -> "observed_outcome"
 *
 * Confidence is the episode's estimated confidence (passed in).
 */
function extractRelationships(
  episode: Episode,
  confidence: number,
  provenance: ProvenanceSource,
): readonly SemanticRelationship[] {
  const subject = episode.inputSummary.slice(0, 80);
  const predicate = 'triggered';
  const object = episode.actionTaken;

  const primary: SemanticRelationship = {
    subject,
    predicate,
    object,
    confidence,
    provenance,
  };

  const secondary: SemanticRelationship = {
    subject: episode.actionTaken,
    predicate: 'produced',
    object: 'observed_outcome',
    confidence: confidence * 0.8,
    provenance,
  };

  return [primary, secondary];
}
