/**
 * ProcedureCreationService -- Writes validated plans to the WKG as ActionProcedure nodes.
 *
 * CANON SS Subsystem 5 (Planning): "Create Plan Procedure" adds an action node
 * to the World Knowledge Graph. The procedure has INFERENCE provenance with
 * base confidence 0.30 (PROVENANCE_BASE_CONFIDENCE.INFERENCE).
 *
 * The created node starts with:
 *   - confidence = 0.30 (below retrieval threshold 0.50, so it requires use
 *     to build confidence before being retrieved by default)
 *   - actr_count = 0 (no uses yet)
 *   - actr_decay_rate = 0.06 (DEFAULT_DECAY_RATES.INFERENCE)
 *   - Subject to confidence ceiling of 0.60 until guardian confirmation
 */

import { Injectable, Logger, Optional } from '@nestjs/common';
import { randomUUID } from 'crypto';
import {
  Neo4jService,
  Neo4jInstanceName,
  verboseFor,
  resolveBaseConfidence,
  type ProvenanceSource,
} from '@sylphie/shared';
import { TextEncoder } from '@sylphie/decision-making';
import type {
  IProcedureCreationService,
  PlanProposal,
  QueuedOpportunity,
} from '../interfaces/planning.interfaces';

const vlog = verboseFor('Planning');

// ---------------------------------------------------------------------------
// Constants (from CANON via @sylphie/shared provenance + confidence types)
// ---------------------------------------------------------------------------

// Base confidence is no longer a local constant: it is resolved per-provenance
// via resolveBaseConfidence() so the stored value always tracks the canonical
// CANON §Confidence Dynamics table (INFERENCE → 0.30, TAUGHT_PROCEDURE → 0.60).

/** DEFAULT_DECAY_RATES.INFERENCE */
const DECAY_RATE = 0.06;

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

@Injectable()
export class ProcedureCreationService implements IProcedureCreationService {
  private readonly logger = new Logger(ProcedureCreationService.name);

  constructor(
    private readonly neo4j: Neo4jService,
    // TextEncoder is exported by DecisionMakingModule (imported by PlanningModule).
    // Injected @Optional so procedure creation still works (with a null
    // triggerEmbedding → fail-closed cosine=0 at retrieval) if the encoder is
    // unavailable, mirroring the rest of the embed pipeline's graceful degradation.
    @Optional() private readonly textEncoder: TextEncoder | null,
  ) {}

  async createProcedure(
    proposal: PlanProposal,
    opportunity: QueuedOpportunity,
  ): Promise<string> {
    const nodeId = randomUUID();
    const session = this.neo4j.getSession(Neo4jInstanceName.WORLD, 'WRITE');

    // Guardian-taught procedures get TAUGHT_PROCEDURE provenance; all others are
    // INFERENCE. Base confidence is resolved from the canonical provenance
    // resolver (CANON §Confidence Dynamics) rather than hardcoded, so the stored
    // value never disagrees with resolveBaseConfidence (TAUGHT_PROCEDURE → 0.60).
    const isGuardianTeaching = opportunity.payload.classification === 'GUARDIAN_TEACHING';
    const provenanceType: ProvenanceSource = isGuardianTeaching
      ? 'TAUGHT_PROCEDURE'
      : 'INFERENCE';
    const confidence = resolveBaseConfidence(provenanceType);

    // ---- Semantic trigger -------------------------------------------------
    // Derive a natural-language triggerPhrase (never a sha256 hash) and embed it
    // as a nomic DOCUMENT so retrieval can cosine-match a live query embedding
    // against it. Replaces the broken sha256→Jaccard context match.
    const triggerPhrase = this.deriveTriggerPhrase(proposal, opportunity);
    const triggerEmbedding = await this.embedTriggerPhrase(triggerPhrase);

    try {
      await session.run(
        `CREATE (p:ActionProcedure {
           node_id: $nodeId,
           name: $name,
           category: $category,
           trigger_context: $triggerContext,
           trigger_description: $triggerDescription,
           trigger_phrase: $triggerPhrase,
           trigger_embedding: $triggerEmbedding,
           action_sequence: $actionSequence,
           provenance_type: $provenanceType,
           confidence: $confidence,
           actr_base: $confidence,
           actr_count: 0,
           actr_decay_rate: $decayRate,
           actr_last_retrieval_at: null,
           created_at: datetime(),
           source_opportunity_id: $opportunityId,
           source_classification: $classification,
           rationale: $rationale,
           predicted_drive_effects: $predictedDriveEffects,
           guardian_instruction: $guardianInstruction
         })
         RETURN p.node_id AS nodeId`,
        {
          nodeId,
          name: proposal.name,
          category: proposal.category,
          triggerContext: proposal.triggerContext,
          triggerDescription: proposal.triggerDescription ?? null,
          triggerPhrase,
          triggerEmbedding,
          actionSequence: JSON.stringify(proposal.actionSequence),
          provenanceType,
          confidence,
          decayRate: DECAY_RATE,
          opportunityId: opportunity.payload.id,
          classification: opportunity.payload.classification,
          rationale: proposal.rationale,
          predictedDriveEffects: JSON.stringify(proposal.predictedDriveEffects),
          guardianInstruction: opportunity.payload.guardianInstruction ?? null,
        },
      );

      vlog('procedure created', {
        nodeId,
        name: proposal.name,
        category: proposal.category,
        provenanceType,
        confidence,
        isGuardianTeaching,
        opportunityId: opportunity.payload.id,
        actionStepCount: proposal.actionSequence.length,
        steps: proposal.actionSequence.map((s) => s.stepType),
        triggerContext: proposal.triggerContext,
        triggerPhrase,
        triggerEmbedded: triggerEmbedding !== null,
      });

      this.logger.log(
        `Created ActionProcedure node: ${nodeId} (${proposal.name}, ` +
          `confidence=${confidence}, provenance=${provenanceType})`,
      );

      return nodeId;
    } finally {
      await session.close();
    }
  }

  // ---------------------------------------------------------------------------
  // Private: semantic trigger derivation
  // ---------------------------------------------------------------------------

  /**
   * Derive a natural-language trigger phrase describing when this procedure
   * activates. Source priority:
   *   1. LLM-authored triggerDescription, if present and NOT a sha256 hash.
   *   2. The originating guardian instruction (the only natural-language input
   *      text the opportunity payload carries).
   *   3. A humanized form of the procedure name (e.g. "guardian-teaching-response"
   *      → "guardian teaching response").
   *
   * NEVER returns a sha256 fingerprint — that was the root cause of the broken
   * Jaccard context match (a single 64-char hex token matches nothing).
   */
  private deriveTriggerPhrase(
    proposal: PlanProposal,
    opportunity: QueuedOpportunity,
  ): string {
    const authored = proposal.triggerDescription?.trim();
    if (authored && authored.length > 0 && !isSha256Hash(authored)) {
      return authored;
    }

    const instruction = opportunity.payload.guardianInstruction?.trim();
    if (instruction && instruction.length > 0) {
      return instruction;
    }

    return humanizeName(proposal.name);
  }

  /**
   * Embed the trigger phrase as a nomic DOCUMENT (`search_document:`) so a
   * later per-turn QUERY embedding retrieves it correctly. Returns null when the
   * encoder is unavailable, the phrase is empty, or the embed fails/returns a
   * zero vector — null triggers the fail-closed cosine=0.0 path at retrieval.
   */
  private async embedTriggerPhrase(phrase: string): Promise<number[] | null> {
    if (!this.textEncoder || phrase.trim().length === 0) {
      return null;
    }
    try {
      const embedding = await this.textEncoder.encodeDocument(phrase);
      // A zero vector is the encoder's failure sentinel (Ollama unreachable).
      // Persist null instead so retrieval fail-closes rather than scoring 0/0.
      if (!embedding.some((v) => v !== 0)) {
        this.logger.warn(
          'Trigger phrase embed returned a zero vector (Ollama likely unavailable); ' +
            'storing triggerEmbedding=null (fail-closed at retrieval).',
        );
        return null;
      }
      return embedding;
    } catch (err) {
      this.logger.warn(
        `Trigger phrase embed failed; storing triggerEmbedding=null: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return null;
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** True if the string looks like a bare sha256 hex digest (64 hex chars, no spaces). */
function isSha256Hash(value: string): boolean {
  return /^[0-9a-f]{64}$/i.test(value.trim());
}

/** Humanize a kebab/snake procedure name into a space-separated phrase. */
function humanizeName(name: string): string {
  return name.replace(/[-_]+/g, ' ').trim();
}
