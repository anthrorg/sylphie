/**
 * RecallRetrievalHelper — Stateless pure transform for pre-arbitration
 * grounded recall retrieval.
 *
 * Extracted from DecisionMakingService (EP7-C, TK-33). Owns the two helpers
 * that were formerly private on DecisionMakingService:
 *   - computeRecallRetrieval(frame): resolve the WKG/OKG recall fact node for
 *     a sensory frame ONCE, before the procedure-vs-deliberate arbitration.
 *   - recallKeyEncoder(): adapt the registered text encoder to the pure
 *     resolver's RecallKeyEncoder seam, honoring nomic's query/document
 *     asymmetry.
 *
 * Behavior is byte-identical to the original inline code (WS3 T1, C8).
 *
 * Logger name is deliberately set to DecisionMakingService so that log lines
 * remain byte-identical to the pre-extraction golden.
 */

import { Injectable, Logger } from '@nestjs/common';
import type { SensoryFrame } from '@sylphie/shared';
import { WkgContextService } from '../wkg/wkg-context.service';
import { ModalityRegistryService } from '../inputs/registry/modality-registry.service';
import { isDocumentEncoder } from '../inputs/encoders/text.encoder';
import {
  retrieveRecallGrounding,
  resolveRecallKey,
  type RecallRetrieval,
  type RecallKeyEncoder,
} from '../deliberation/recall-retrieval';

// Must match the source module so that emitted log lines are byte-identical.
const LOGGER_CONTEXT = 'DecisionMakingService';

@Injectable()
export class RecallRetrievalHelper {
  // Logger context matches the original so log lines are byte-identical.
  private readonly logger = new Logger(LOGGER_CONTEXT);

  constructor(
    private readonly wkgContext: WkgContextService,
    private readonly modalityRegistry: ModalityRegistryService,
  ) {}

  /**
   * Resolve the grounding fact node id for a recall question ONCE, before
   * arbitration. Single-hop, provenance-carrying. Returns null for non-recall
   * input (cheap exit, no DB hit) and for recall input with no taught OKG fact
   * and no topical WKG entity (honest NOT_GROUNDED by construction).
   *
   * OKG self-fact recall is resolved purely from the frame's knownFacts (no DB
   * round-trip). The WKG single-hop fallback is only consulted when the OKG
   * misses AND the question is a recall — and it reuses getContextForFrame's
   * one fulltext hop, not a second traversal.
   *
   * CANON Std 4: the node id is real (deterministic attr-id for OKG; matched
   * node_id for WKG); never fabricated. Std 3: confidence is surfaced, not lifted.
   */
  async computeRecallRetrieval(frame: SensoryFrame): Promise<RecallRetrieval | null> {
    const inputText = (frame.raw['text'] as string | undefined) ?? '';
    if (!inputText.trim()) return null;

    const personModel = frame.raw['person_model'] as
      { personId?: string; knownFacts?: string[] } | null | undefined;
    const personId = personModel?.personId ?? null;
    const knownFacts = personModel?.knownFacts;

    // ── WS3 C8 — semantic recall-key resolution (regex FIRST, embed fallback) ──
    // resolveRecallKey tries recallKeyForQuestion first (preserving C1 exactly,
    // and short-circuiting before any embed on a regex hit), and only on a regex
    // MISS embeds the question and cosine-matches it against the canonical forms
    // of the keys THIS person taught. Fail-closed: a null/zero-vector encoder
    // skips the semantic pass entirely → behavior == regex-only (never regresses
    // C1). A non-recall, non-paraphrase turn resolves to null → cheap exit below.
    const encoder = this.recallKeyEncoder();
    const resolvedKey = await resolveRecallKey(inputText, knownFacts, encoder);
    // Not a recall question (regex miss + no semantic match) → no provenance, no DB.
    if (!resolvedKey) return null;

    // Try OKG first (pure, no DB). If it grounds, we never touch Neo4j.
    const okgFirst = retrieveRecallGrounding(personId, inputText, knownFacts, {
      entities: [], facts: [], relationships: [], procedures: [], summary: '',
    }, resolvedKey);
    if (okgFirst) return okgFirst;

    // OKG missed on a recall question — consult the single-hop WKG context.
    try {
      const wkg = await this.wkgContext.getContextForFrame(frame);
      return retrieveRecallGrounding(personId, inputText, knownFacts, wkg, resolvedKey);
    } catch (err) {
      this.logger.warn(`computeRecallRetrieval WKG lookup failed: ${err}`);
      return null;
    }
  }

  /**
   * WS3 C8 — adapt the registered text encoder to the pure resolver's seam.
   *
   * Returns a RecallKeyEncoder bound to the registered 'text' modality encoder,
   * honoring nomic's MANDATORY query/document asymmetry: the live QUESTION is a
   * `search_query:` (encoder.encode) and each canonical key form is a
   * `search_document:` (encoder.encodeDocument). Returns null when no text
   * encoder is registered or it cannot produce documents — the resolver then
   * fail-closes to regex-only (no semantic pass, C1 preserved).
   */
  recallKeyEncoder(): RecallKeyEncoder | null {
    const enc = this.modalityRegistry.get('text');
    if (!enc || !isDocumentEncoder(enc)) return null;
    return {
      encodeQuery: (t: string) => enc.encode(t),
      encodeDocument: (t: string) => enc.encodeDocument(t),
    };
  }
}
