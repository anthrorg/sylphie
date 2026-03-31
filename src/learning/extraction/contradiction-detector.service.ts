/**
 * ContradictionDetectorService — pre-write conflict detection for the WKG.
 *
 * Implements IContradictionDetector. Compares an incoming ExtractedEntity
 * against an existing WKG node to detect contradictions before any write
 * occurs. Returns a discriminated union rather than throwing — per CANON §Knowledge,
 * contradictions are developmental catalysts (Piagetian disequilibrium), not errors.
 *
 * Detection covers four contradiction types:
 *  1. DIRECT: opposite truth values (e.g., "is-red" vs "is-blue")
 *  2. CONFIDENCE: same knowledge, high confidence variance (abs diff > 0.25)
 *  3. SCHEMA: type/structural mismatch
 *  4. TEMPORAL: causality violations
 *
 * Resolution priority (CANON Standard 5: Guardian Asymmetry):
 *  - GUARDIAN edges never overwritten → always FLAG_AMBIGUOUS when conflicting
 *  - GUARDIAN incoming → PREFER_GUARDIAN (guardian wins)
 *  - Other provenances evaluated by confidence gap and plausibility
 *
 * This service detects and categorizes only; it does not write to the WKG or
 * emit events. The caller (ConsolidationService) is responsible for event emission.
 */

import { Injectable, Logger, Inject } from '@nestjs/common';

import type { KnowledgeNode } from '../../shared/types/knowledge.types';
import type {
  IContradictionDetector,
  ExtractedEntity,
  ContradictionCheckResult,
  ContradictionType,
} from '../interfaces/learning.interfaces';
import { WKG_SERVICE } from '../../knowledge';
import type { IWkgService } from '../../knowledge/interfaces/knowledge.interfaces';
import { PROVENANCE_BASE_CONFIDENCE } from '../../shared/types/provenance.types';
import type { ProvenanceSource } from '../../shared/types/provenance.types';

/**
 * Provenance hierarchy: higher rank = more authoritative.
 * Used to resolve contradictions by checking which provenance source wins.
 */
const PROVENANCE_RANK: Readonly<Record<ProvenanceSource, number>> = {
  GUARDIAN: 4,
  GUARDIAN_APPROVED_INFERENCE: 3.5,
  TAUGHT_PROCEDURE: 3.5,
  SENSOR: 3,
  BEHAVIORAL_INFERENCE: 2,
  INFERENCE: 2,
  LLM_GENERATED: 1,
  SYSTEM_BOOTSTRAP: 0.5,
} as const;

@Injectable()
export class ContradictionDetectorService implements IContradictionDetector {
  private readonly logger = new Logger(ContradictionDetectorService.name);

  constructor(@Inject(WKG_SERVICE) private readonly wkg: IWkgService) {}

  /**
   * Compare an incoming extracted entity against an existing WKG node to
   * determine whether a contradiction exists.
   *
   * If existing is null, returns { type: 'no_conflict' } immediately.
   *
   * @param incoming - The entity just extracted from a LearnableEvent.
   * @param existing - The WKG node with the same label/type, or null if none exists.
   * @returns Discriminated union: no_conflict or contradiction with resolution guidance.
   */
  async check(
    incoming: ExtractedEntity,
    existing: KnowledgeNode | null,
  ): Promise<ContradictionCheckResult> {
    // No existing node → no conflict possible
    if (!existing) {
      return { type: 'no_conflict' };
    }

    // Check for contradictions across four dimensions
    const directConflict = this.detectDirectConflict(incoming, existing);
    if (directConflict) {
      return this.resolveContradiction(
        incoming,
        existing,
        'DIRECT',
        directConflict,
      );
    }

    const confidenceConflict = this.detectConfidenceConflict(incoming, existing);
    if (confidenceConflict) {
      return this.resolveContradiction(
        incoming,
        existing,
        'CONFIDENCE',
        confidenceConflict,
      );
    }

    const schemaConflict = this.detectSchemaConflict(incoming, existing);
    if (schemaConflict) {
      return this.resolveContradiction(
        incoming,
        existing,
        'SCHEMA',
        schemaConflict,
      );
    }

    const temporalConflict = this.detectTemporalConflict(incoming, existing);
    if (temporalConflict) {
      return this.resolveContradiction(
        incoming,
        existing,
        'TEMPORAL',
        temporalConflict,
      );
    }

    return { type: 'no_conflict' };
  }

  /**
   * DIRECT contradiction: entity properties have opposite truth values.
   *
   * Example: incoming has color='red', existing has color='blue'
   * The property value conflicts directly — not just different confidence.
   */
  private detectDirectConflict(
    incoming: ExtractedEntity,
    existing: KnowledgeNode,
  ): string | null {
    // Compare property values
    for (const [key, incomingValue] of Object.entries(
      incoming.properties || {},
    )) {
      const existingValue = existing.properties[key];

      // Skip if property doesn't exist in existing
      if (existingValue === undefined) {
        continue;
      }

      // Check for direct opposition (string case-insensitive comparison for colors/states)
      if (this.isDirectlyOpposed(incomingValue, existingValue)) {
        return `Property '${key}' conflicts: incoming '${incomingValue}' vs existing '${existingValue}'`;
      }
    }

    return null;
  }

  /**
   * CONFIDENCE contradiction: same semantic knowledge but high confidence variance.
   *
   * When both incoming and existing describe the same fact but confidence values
   * differ significantly (>0.25), it suggests conflicting evidence sources.
   */
  private detectConfidenceConflict(
    incoming: ExtractedEntity,
    existing: KnowledgeNode,
  ): string | null {
    // Check if entities describe the same semantic content
    // Heuristic: same name and similar property overlap suggests same concept
    if (incoming.name.toLowerCase() !== existing.properties['name']?.toString().toLowerCase()) {
      return null;
    }

    const confidenceGap = Math.abs(
      incoming.confidence - existing.actrParams.base,
    );

    // Threshold: 0.25 confidence gap suggests conflicting evidence
    if (confidenceGap > 0.25) {
      return `Confidence gap of ${confidenceGap.toFixed(2)}: incoming ${incoming.confidence.toFixed(2)} vs existing ${existing.actrParams.base.toFixed(2)}`;
    }

    return null;
  }

  /**
   * SCHEMA contradiction: entity type mismatches or label violations.
   *
   * Example: incoming type='Person', existing labels=['Technology']
   * Or: incoming property invalid for its declared type
   */
  private detectSchemaConflict(
    incoming: ExtractedEntity,
    existing: KnowledgeNode,
  ): string | null {
    // Type mismatch: incoming.type doesn't align with existing labels
    // If incoming type is explicitly specified and differs from existing labels
    if (incoming.type && !existing.labels.includes(incoming.type)) {
      // Allow some flexibility for label expansion, but flag categorical mismatches
      const existingCategorical = existing.labels[0]; // Primary label
      if (existingCategorical && existingCategorical !== incoming.type) {
        // Only flag if they're fundamentally different categories (heuristic)
        if (!this.areRelatedTypes(incoming.type, existingCategorical)) {
          return `Type mismatch: incoming '${incoming.type}' vs existing labels '${existing.labels.join(', ')}'`;
        }
      }
    }

    return null;
  }

  /**
   * TEMPORAL contradiction: causality violations or impossible time sequences.
   *
   * Example: edge with relationship FOLLOWS_PATTERN where effect timestamp
   * precedes cause timestamp.
   */
  private detectTemporalConflict(
    incoming: ExtractedEntity,
    existing: KnowledgeNode,
  ): string | null {
    // Extract temporal properties if present
    const incomingTime = this.extractTimestamp(incoming);
    const existingTime = this.extractTimestamp(existing);

    if (incomingTime && existingTime) {
      // Check for impossible causality (effect before cause)
      // This is speculative without explicit relationship semantics,
      // but we flag large backwards time jumps as suspicious
      const timeDiff = incomingTime.getTime() - existingTime.getTime();
      const daysDiff = timeDiff / (1000 * 60 * 60 * 24);

      // Flag if the incoming timestamp is more than 30 days in the past
      // relative to existing (suggests correcting old, stale data)
      if (daysDiff < -30) {
        return `Temporal inconsistency: incoming timestamp ${incomingTime.toISOString()} is significantly earlier than existing ${existingTime.toISOString()}`;
      }
    }

    return null;
  }

  /**
   * Resolve the detected contradiction based on provenance and confidence.
   *
   * CANON Standard 5 (Guardian Asymmetry):
   *  - GUARDIAN edges are write-protected → always GUARDIAN_REVIEW
   *  - Incoming GUARDIAN → SUPERSEDED (incoming wins)
   *  - Otherwise: compare provenance rank and confidence gap
   *
   * Resolution types:
   *  GUARDIAN_REVIEW: Default for most conflicts. Guardian decides.
   *  SUPERSEDED:      Use when incoming provenance is higher-authority.
   *  COEXIST:         Use when conflict is ambiguous or context-dependent.
   */
  private resolveContradiction(
    incoming: ExtractedEntity,
    existing: KnowledgeNode,
    contradictionType: ContradictionType,
    details: string,
  ): ContradictionCheckResult {
    // Guardian write-protection: if existing is GUARDIAN, defer to guardian review
    if (existing.provenance === 'GUARDIAN') {
      return {
        type: 'contradiction',
        existing,
        incoming,
        conflictType: contradictionType,
        resolution: 'GUARDIAN_REVIEW',
      };
    }

    // Incoming GUARDIAN provenance: incoming should supersede
    if (incoming.provenance === 'GUARDIAN') {
      return {
        type: 'contradiction',
        existing,
        incoming,
        conflictType: contradictionType,
        resolution: 'SUPERSEDED',
      };
    }

    // Compare provenance ranks
    const incomingRank = PROVENANCE_RANK[incoming.provenance] ?? 0;
    const existingRank = PROVENANCE_RANK[existing.provenance] ?? 0;

    // If incoming is substantially higher provenance, supersede
    if (incomingRank > existingRank + 0.5) {
      return {
        type: 'contradiction',
        existing,
        incoming,
        conflictType: contradictionType,
        resolution: 'SUPERSEDED',
      };
    }

    // If incoming confidence is much higher, consider coexisting (merge with adjustment)
    const confidenceGap =
      incoming.confidence - existing.actrParams.base;
    if (confidenceGap > 0.15) {
      return {
        type: 'contradiction',
        existing,
        incoming,
        conflictType: contradictionType,
        resolution: 'COEXIST',
      };
    }

    // Default: defer to guardian review
    return {
      type: 'contradiction',
      existing,
      incoming,
      conflictType: contradictionType,
      resolution: 'GUARDIAN_REVIEW',
    };
  }

  /**
   * Determine if two values are directly opposed (e.g., 'red' vs 'blue').
   *
   * Uses string comparison for property values; boolean comparison for flags.
   */
  private isDirectlyOpposed(val1: unknown, val2: unknown): boolean {
    // Boolean opposition
    if (typeof val1 === 'boolean' && typeof val2 === 'boolean') {
      return val1 !== val2;
    }

    // String opposition (case-insensitive)
    if (typeof val1 === 'string' && typeof val2 === 'string') {
      const s1 = val1.toLowerCase();
      const s2 = val2.toLowerCase();
      return (
        s1 !== s2 &&
        !this.areRelatedTerms(s1, s2)
      );
    }

    // Numeric opposition (e.g., 0 vs 1 for boolean-like numerics)
    if (typeof val1 === 'number' && typeof val2 === 'number') {
      // Only flag if they're explicitly contradictory (0 vs 1, etc.)
      return (val1 === 0 && val2 === 1) || (val1 === 1 && val2 === 0);
    }

    return false;
  }

  /**
   * Determine if two type/label names are semantically related
   * (e.g., 'Person' and 'Agent' are related; 'Person' and 'Technology' are not).
   */
  private areRelatedTypes(type1: string, type2: string): boolean {
    const relatedGroups: ReadonlyArray<readonly string[]> = [
      ['Person', 'Agent', 'Entity'],
      ['Technology', 'Tool', 'System'],
      ['Object', 'Thing', 'Item'],
      ['Place', 'Location', 'Space'],
    ];

    const t1 = type1.toLowerCase();
    const t2 = type2.toLowerCase();

    for (const group of relatedGroups) {
      const inGroup1 = group.some(t => t.toLowerCase() === t1);
      const inGroup2 = group.some(t => t.toLowerCase() === t2);
      if (inGroup1 && inGroup2) {
        return true;
      }
    }

    return false;
  }

  /**
   * Determine if two terms are semantically related synonyms
   * (e.g., 'red' and 'crimson', 'happy' and 'joyful').
   *
   * Returns true if terms are close enough to not be direct oppositions.
   */
  private areRelatedTerms(term1: string, term2: string): boolean {
    // Synonym groups for common properties
    const synonymGroups: ReadonlyArray<readonly string[]> = [
      ['red', 'crimson', 'scarlet', 'rouge'],
      ['blue', 'azure', 'navy', 'cyan'],
      ['happy', 'joyful', 'glad', 'pleased'],
      ['sad', 'unhappy', 'gloomy', 'sorrowful'],
      ['big', 'large', 'huge', 'enormous'],
      ['small', 'tiny', 'little', 'diminutive'],
    ];

    for (const group of synonymGroups) {
      const in1 = group.includes(term1);
      const in2 = group.includes(term2);
      if (in1 && in2) {
        return true;
      }
    }

    return false;
  }

  /**
   * Extract a timestamp from an entity's properties if present.
   *
   * Looks for common temporal property names: createdAt, updatedAt, timestamp, date.
   */
  private extractTimestamp(entity: ExtractedEntity | KnowledgeNode): Date | null {
    if ('properties' in entity) {
      const props = entity.properties;
      const candidates = [
        'createdAt',
        'updatedAt',
        'timestamp',
        'date',
        'when',
      ] as const;

      for (const key of candidates) {
        const value = props[key];
        if (value instanceof Date) {
          return value;
        }
        if (typeof value === 'string') {
          try {
            return new Date(value);
          } catch {
            // Not a valid date string, continue
          }
        }
      }
    } else {
      // KnowledgeNode: check createdAt directly
      return (entity as KnowledgeNode).createdAt || null;
    }

    return null;
  }
}
