/**
 * Pre-arbitration grounded recall retrieval (WS3 Ticket T1).
 *
 * THE DURABLE REPLACEMENT FOR THE POST-HOC OKG GROUNDING REGEX.
 *
 * Background (the C1 tactical version, still partly live as a fallback):
 *   Recall turns ("what is my name?") were grounded POST-HOC — after the LLM
 *   produced a response, `applyOkgRecallGrounding` re-ran `recallKeyForQuestion`
 *   and only upgraded the label to GROUNDED if the fact VALUE appeared verbatim
 *   in the free-generated text. Two structural problems:
 *     1. The retrieval was reconstructed at three separate grounding sites
 *        (Type-1 latent, procedure path, deliberate() short-circuit + novel),
 *        each re-deriving the same key→value→provenance mapping.
 *     2. The node id was only captured if the value happened to survive into the
 *        response prose. A correctly-retrieved fact whose value the LLM
 *        paraphrased away lost its provenance entirely.
 *
 * WS3 T1 closes both: a SINGLE pre-arbitration step resolves the recall fact
 * node id ONCE, BEFORE the procedure-vs-deliberate arbitration, and threads the
 * result into every path. The grounding node id is therefore recorded AT
 * RETRIEVAL TIME, not reconstructed from the response text after the fact.
 *
 * SINGLE-HOP ONLY. This performs at most one OKG fact-key lookup and (when the
 * OKG misses) a single-hop WKG entity match. No multi-hop / BFS traversal — that
 * is deferred to WS3 Phase 3 and gated behind its three co-requisites.
 *
 * CANON Standard 4 (Provenance Required): the OKG node id is the deterministic
 *   `attr-${personId}-${key}` id PersonModelService.writeFact MERGE-writes to
 *   Neo4j; the WKG node id is the real `node_id` returned by the fulltext match.
 *   Neither is fabricated. When no node grounds the answer, we carry null and let
 *   the honest NOT_GROUNDED / deliberate path handle it (no invented provenance).
 *
 * CANON Standard 3 (Confidence Ceiling): this module SURFACES fact confidence; it
 *   never lifts it. Reinforcement (T2) is a separate ticket and is ceiling-capped.
 */

import { recallKeyForQuestion, getRecalledFactForRecall } from './deliberation.service';
import type { WkgContext } from '../wkg/wkg-context.service';

/**
 * Which knowledge source produced the pre-arbitration recall grounding node.
 *
 *   'OKG' → a taught person-model self-fact (the current speaker's private OKG).
 *           Node id is the deterministic `attr-${personId}-${key}`.
 *   'WKG' → a shared world-knowledge entity matched single-hop for this recall
 *           question. Node id is the real Neo4j node_id.
 */
export type RecallSource = 'OKG' | 'WKG';

/**
 * Result of the pre-arbitration recall retrieval.
 *
 * Carries the matched fact node id + its provenance/confidence, resolved BEFORE
 * arbitration so both the procedure path and deliberate() observe the same
 * provenance-carrying fact node. T2 will reinforce `factNodeId`; T3 will decay
 * unused nodes — both depend on this node id being surfaced and recorded here.
 */
export interface RecallRetrieval {
  /** The OKG fact key the recall question targets (e.g. 'name', 'location'). */
  readonly recallKey: string;

  /**
   * The grounding node id, recorded AT RETRIEVAL TIME.
   *   - OKG: `attr-${personId}-${key}` (deterministic, MERGE-written by writeFact).
   *   - WKG: the real Neo4j `node_id` of the single-hop entity match.
   * CANON Std 4: real, never fabricated.
   */
  readonly factNodeId: string;

  /** The retrieved fact value (for the honesty guard on the GROUNDED label). */
  readonly factValue: string;

  /** Which graph the node came from. */
  readonly source: RecallSource;

  /**
   * The node's current confidence as stored in the graph at retrieval time.
   *   - OKG: not separately surfaced here (the value comes from the frame's
   *     knownFacts strings, which carry no per-fact confidence), so it is
   *     undefined for OKG hits. T2 will read/write it on the Neo4j node directly.
   *   - WKG: the matched entity's `confidence`.
   * SURFACED, never modified (Std 3 — T2 owns reinforcement).
   */
  readonly confidence?: number;

  /** The current speaker's person id (null when no person model on the frame). */
  readonly personId: string | null;
}

/**
 * Resolve the OKG self-fact node for a recall question, at retrieval time.
 *
 * Pure over the frame's `knownFacts` strings + the deterministic id scheme. This
 * is the SAME retrieval the post-hoc helper did, lifted before arbitration and
 * made the single source of the node id. Returns null when the question is not a
 * recall (`recallKeyForQuestion` → null) or the fact is not taught — unknowables
 * therefore carry no node id by construction (C2 honesty preserved).
 *
 * NOTE: this does NOT check whether the value appears in any response — there is
 * no response yet. The node id is captured purely from retrieval success. The
 * verbatim-value guard that protects the GROUNDED *label* still runs later, at
 * label-application time (applyRecallGroundingFromRetrieval), so C2 stays honest:
 * a retrieved-but-not-surfaced fact records its node id but does NOT flip the
 * label to GROUNDED.
 */
function retrieveOkgRecall(
  personId: string | null,
  inputText: string,
  knownFacts: readonly string[] | undefined,
): RecallRetrieval | null {
  if (!personId) return null;
  const key = recallKeyForQuestion(inputText);
  if (!key) return null;
  const fact = getRecalledFactForRecall(personId, key, knownFacts);
  if (!fact) return null;
  if (fact.value.trim().length < 2) return null;
  return {
    recallKey: key,
    factNodeId: fact.attrId,
    factValue: fact.value,
    source: 'OKG',
    personId,
  };
}

/**
 * Resolve a single-hop WKG entity node for a recall question, at retrieval time.
 *
 * Used only when the OKG has no taught fact for this recall key — e.g. a "where
 * is X" / "who is Y" recall about a world entity Sylphie has in the WKG rather
 * than a person self-fact. Single-hop: we take the best topical (non-base-context)
 * entity already matched in the supplied `wkg` context (which getContextForFrame
 * produced via one fulltext `matchEntities` hop). No further traversal.
 *
 * Returns null when the question is not a recall, or there is no topical WKG
 * entity to point at. CANON Std 4: the node id is the real matched `node_id`.
 */
function retrieveWkgRecall(
  personId: string | null,
  inputText: string,
  wkg: WkgContext,
): RecallRetrieval | null {
  const key = recallKeyForQuestion(inputText);
  if (!key) return null;
  // Single-hop: best topical entity from the already-assembled 1-hop context.
  // Base-context nodes (Drive/CoBeing) are never provenance for a recall answer.
  const topical = wkg.entities.find(
    (e) => e.nodeType !== 'Drive' && e.nodeType !== 'CoBeing' && e.nodeType !== 'Word',
  );
  if (!topical) return null;
  return {
    recallKey: key,
    factNodeId: topical.nodeId,
    factValue: topical.label,
    source: 'WKG',
    confidence: topical.confidence,
    personId,
  };
}

/**
 * THE pre-arbitration recall retrieval entrypoint (WS3 T1).
 *
 * Resolves the grounding fact node id for a recall question ONCE, before the
 * procedure-vs-deliberate arbitration, so both paths see the same node. OKG
 * self-fact recall WINS over topical WKG (same precedence as the grounding
 * cascade — a taught self-fact is the more specific provenance). When neither
 * graph grounds the question, returns null and the cycle proceeds honestly
 * un-grounded (the deliberate path may still answer; it just carries no recall
 * provenance — NOT_GROUNDED by construction).
 *
 * @param personId    current speaker id (from frame.raw.person_model.personId).
 * @param inputText   the raw recall question text.
 * @param knownFacts  the speaker's OKG facts as "key: value" strings (from frame).
 * @param wkg         the already-assembled single-hop WKG context for this frame.
 */
export function retrieveRecallGrounding(
  personId: string | null,
  inputText: string,
  knownFacts: readonly string[] | undefined,
  wkg: WkgContext,
): RecallRetrieval | null {
  // Not a recall question → no provenance to resolve. Cheap exit.
  if (!recallKeyForQuestion(inputText)) return null;
  // OKG self-fact wins over topical WKG (more specific provenance).
  return (
    retrieveOkgRecall(personId, inputText, knownFacts) ??
    retrieveWkgRecall(personId, inputText, wkg)
  );
}

/**
 * Apply a pre-resolved RecallRetrieval to a path's base grounding.
 *
 * This REPLACES the per-site `applyOkgRecallGrounding` reconstruction with the
 * once-resolved node id. The honesty guard is preserved: the GROUNDED label is
 * only applied when the retrieved fact VALUE actually surfaced in the response
 * text (C2 — unknowables / paraphrased-away facts never falsely read GROUNDED).
 *
 * CRUCIAL T1 DISTINCTION: the node id (`provenance`) is returned WHENEVER the
 * value surfaced — but it is the node id resolved AT RETRIEVAL TIME, identical
 * across the procedure path and the deliberate path, never reconstructed from
 * the prose. The post-hoc regex re-derivation is gone from the call sites.
 *
 * @returns the (possibly upgraded) grounding + the real node id when GROUNDED,
 *   plus the source discriminator for write-time person-scoping (WS4 T5 §3.1).
 */
export function applyRecallGroundingFromRetrieval(
  retrieval: RecallRetrieval | null,
  responseText: string,
  currentGrounding: import('@sylphie/shared').KnowledgeGrounding,
): {
  grounding: import('@sylphie/shared').KnowledgeGrounding;
  provenance: string | null;
  groundedBy: RecallSource | null;
} {
  if (!retrieval) {
    return { grounding: currentGrounding, provenance: null, groundedBy: null };
  }
  // Already GROUNDED by a stronger/earlier signal — keep it, do not double-label.
  if (currentGrounding === 'GROUNDED') {
    return { grounding: currentGrounding, provenance: null, groundedBy: null };
  }
  // Honesty guard (C2): the fact VALUE must actually surface in the response for
  // the label to read GROUNDED. The retrieval node id is real either way, but a
  // fact that was retrieved yet not used in the answer must NOT claim GROUNDED.
  const valueLower = retrieval.factValue.toLowerCase();
  const surfaced = valueLower.length >= 2 && responseText.toLowerCase().includes(valueLower);
  if (!surfaced) {
    return { grounding: currentGrounding, provenance: null, groundedBy: null };
  }
  return {
    grounding: 'GROUNDED',
    provenance: retrieval.factNodeId,
    groundedBy: retrieval.source,
  };
}
