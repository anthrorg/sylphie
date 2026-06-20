/**
 * Pre-arbitration grounded recall retrieval (WS3 Ticket T1).
 *
 * THE DURABLE REPLACEMENT FOR THE POST-HOC OKG GROUNDING REGEX.
 *
 * Background (the C1 tactical post-hoc regex — DELETED in TK-84):
 *   Recall turns ("what is my name?") were grounded POST-HOC — after the LLM
 *   produced a response, `applyOkgRecallGrounding` re-ran `recallKeyForQuestion`
 *   and only upgraded the label to GROUNDED if the fact VALUE appeared verbatim
 *   in the free-generated text. Two structural problems:
 *     1. The retrieval was reconstructed at four separate grounding sites
 *        (Type-1 latent, procedure path, deliberate() short-circuit + novel),
 *        each re-deriving the same key→value→provenance mapping.
 *     2. The node id was only captured if the value happened to survive into the
 *        response prose. A correctly-retrieved fact whose value the LLM
 *        paraphrased away lost its provenance entirely.
 *   TK-84 confirmed subsumption and collapsed all four sites to this path.
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
import { cosineSimilarity } from '../latent-space/vector-math';

// ---------------------------------------------------------------------------
// WS3 C8 — semantic recall-key resolver (regex-FIRST, embedding fallback)
// ---------------------------------------------------------------------------

/**
 * Minimal encoder seam for the semantic recall-key resolver.
 *
 * Deliberately NOT the concrete TextEncoder: the pure retrieval module must not
 * depend on the NestJS encoder class. The cycle boundary
 * (DecisionMakingService.computeRecallRetrieval) discovers the registered text
 * encoder and passes it in. The asymmetric nomic prefixing is MANDATORY and is
 * honored by reusing the encoder's own methods:
 *   - encodeQuery  → the per-turn QUESTION is a `search_query:` (TextEncoder.encode)
 *   - encodeDocument → each canonical key form is a `search_document:`
 * Prefixing both sides the same way collapses the retrieval asymmetry nomic was
 * trained on (see text.encoder.ts), so the seam pins which side is which.
 */
export interface RecallKeyEncoder {
  /** Embed the live QUESTION as a nomic `search_query:`. */
  encodeQuery(text: string): Promise<number[]>;
  /** Embed a canonical key form as a nomic `search_document:`. */
  encodeDocument(text: string): Promise<number[]>;
}

/**
 * Canonical question form for each taught recall key, embedded `search_document:`-
 * side and cached. Multiple phrasings are joined so the document embedding sits
 * near the centroid of how people actually ask. FIXED IN CODE (not learned) —
 * the keys mirror the corpus teach dimensions recallKeyForQuestion already owns.
 *
 * The semantic pass only ever resolves to one of THESE keys, and only after
 * intersecting with the keys the speaker actually taught — so an unknowable
 * (e.g. "breakfast") that is not a taught key can never be produced here.
 */
const CANONICAL_KEY_FORMS: Readonly<Record<string, string>> = {
  name: 'what is my name',
  location: 'where do I live, where am I based, what city am I in',
  dog: "what is my pet's name, what is my dog called",
  favorite_color: 'what is my favorite color',
  occupation: 'what do I do for work, what is my job, my profession',
};

/**
 * C8.1 — known-UNKNOWABLE canonical forms, embedded `search_document:`-side and
 * cached alongside the taught keys. These are the embedding-space analogue of the
 * careful regex exclusions recallKeyForQuestion already encodes
 * (deliberation.service.ts:1276-1284): questions that are recall-SHAPED but that
 * Sylphie has no taught fact for and could not honestly answer.
 *
 * WHY they exist — the [31]/[39] bind (mythos-measured live cosines):
 *   - [39] "What is my phone number?"  cosine vs the `name` form  = 0.6365
 *   - [31] "Remind me which town I'm based in"  cosine vs `location` = 0.6174
 * The false positive [39] scores HIGHER against `name` than the true positive
 * [31] scores against `location`, so NO flat threshold can separate them. The
 * negative exemplars break the tie by SUBJECT, not by score: "phone number"
 * matches the phone unknowable far more strongly than it matches `name`, so the
 * reject rule (best-unknowable ≥ best-taught − margin) drops it; "which town
 * based in" has no strong unknowable competitor, so `location` survives.
 *
 * FIXED IN CODE (not learned). Adding an exemplar here only ever tightens
 * precision (more asks can be rejected as unknowable); it can never invent a
 * GROUNDED label, so the set is safe to extend conservatively.
 */
const UNKNOWABLE_KEY_FORMS: Readonly<Record<string, string>> = {
  phone: 'what is my phone number, what is my number',
  breakfast: 'what did I have for breakfast, what did I eat',
  favorite_food: 'what is my favorite food, what is my favorite meal or dish',
  weekend_plans: 'what are my weekend plans, what am I doing this weekend',
  middle_name: 'what is my middle name, what is my last name or surname',
};

/**
 * Acceptance threshold for the semantic (embedding) recall-key pass. argmax
 * cosine over the taught-key canonical forms must clear this for the resolver to
 * accept a paraphrase the regex missed.
 *
 * C8.1: LOWERED 0.62 → 0.58. With the unknowable-exemplar guard (below) now
 * doing the false-positive separation, the flat threshold no longer has to carry
 * precision by itself — its only job is to reject genuinely off-key asks. 0.58
 * lets the true-positive [31] location paraphrase (live cosine 0.6174) clear,
 * while the unknowable guard independently rejects the false-positive [39] phone
 * ask (which would also clear 0.58 against `name`, but loses to the phone
 * unknowable exemplar). Do NOT hand-fit this to a single example; the unknowable
 * guard — not this number — is what makes the [31]/[39] pair separable.
 */
export const RECALL_SEMANTIC_THRESHOLD = 0.58;

/**
 * C8.1 — margin by which the best taught-key cosine must EXCEED the best
 * unknowable-exemplar cosine for the resolver to accept. A recall-shaped ask is
 * rejected (→ null) when its closest unknowable exemplar matches at least as well
 * as its closest taught key (within this margin). 0 means a strict tie also
 * rejects, which is the honest default: if the ask is "as much" an unknowable as
 * a taught key, we do NOT ground it.
 */
export const RECALL_UNKNOWABLE_MARGIN = 0;

/** A vector is the Ollama-down zero sentinel iff every component is 0. */
function isZeroVector(v: readonly number[]): boolean {
  return v.length === 0 || v.every((x) => x === 0);
}

/** Escape a string for safe literal use inside a RegExp. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * C8.1 (Std-1 honesty) — does `value` surface in `text` as WHOLE WORD(S), not as
 * an incidental substring? Bare `text.includes(value)` falsely matched "Max"
 * inside "Maxford" (and was what let the live PRIV.3 probe ground off the
 * guardian's legacy `dog=Max` fact). We require a word boundary on each side so a
 * GROUNDED-by-recall label means the fact value genuinely appears in the prose.
 *
 * Boundary semantics: `\b` is anchored to the start/end of the (regex-escaped)
 * value, so a multi-word value ("New York") still matches as a phrase. Empty /
 * sub-2-char values never match (the callers also pre-screen length).
 */
export function valueSurfacesAsWord(value: string, text: string): boolean {
  const v = value.trim();
  if (v.length < 2) return false;
  const re = new RegExp(`\\b${escapeRegExp(v)}\\b`, 'i');
  return re.test(text);
}

/**
 * Parse the set of fact KEYS the speaker actually taught, from the frame's
 * "key: value" knownFacts strings. This is the intersection gate that makes
 * unknowables impossible to ground semantically: only taught keys are candidates.
 */
function taughtKeys(knownFacts: readonly string[] | undefined): Set<string> {
  const keys = new Set<string>();
  if (!knownFacts) return keys;
  for (const kf of knownFacts) {
    const idx = kf.indexOf(':');
    if (idx <= 0) continue;
    const k = kf.substring(0, idx).trim();
    if (k) keys.add(k);
  }
  return keys;
}

/**
 * Per-encoder document-embedding cache for the canonical key forms. Keyed by the
 * encoder instance so a swapped/restarted encoder re-embeds. Lazily built on
 * first semantic miss; never re-embeds a canonical form twice for one encoder.
 */
const CANONICAL_EMBED_CACHE = new WeakMap<RecallKeyEncoder, Map<string, number[]>>();

/**
 * Embed a canonical FORM string (taught-key OR unknowable exemplar) once per
 * encoder and cache it. Keyed by the form string itself so the taught-key and
 * unknowable maps share one cache without colliding (the forms are distinct).
 * Returns null on the Ollama-down zero sentinel without caching it.
 */
async function formEmbedding(
  encoder: RecallKeyEncoder,
  form: string,
): Promise<number[] | null> {
  let perEncoder = CANONICAL_EMBED_CACHE.get(encoder);
  if (!perEncoder) {
    perEncoder = new Map<string, number[]>();
    CANONICAL_EMBED_CACHE.set(encoder, perEncoder);
  }
  const cached = perEncoder.get(form);
  if (cached) return isZeroVector(cached) ? null : cached;
  const emb = await encoder.encodeDocument(form);
  if (isZeroVector(emb)) return null; // Ollama down — do NOT cache the sentinel.
  perEncoder.set(form, emb);
  return emb;
}

/** Best cosine of `queryEmb` against any form in `forms` (−Infinity if none). */
async function bestCosine(
  encoder: RecallKeyEncoder,
  queryEmb: number[],
  forms: Iterable<string>,
): Promise<number> {
  let best = -Infinity;
  for (const form of forms) {
    const docEmb = await formEmbedding(encoder, form);
    if (!docEmb) continue; // sentinel/missing → skip (degrade for that form)
    const score = cosineSimilarity(queryEmb, docEmb);
    if (score > best) best = score;
  }
  return best;
}

/**
 * WS3 C8 — resolve a recall question to a taught fact KEY, regex-FIRST with an
 * embedding fallback. This is the ONLY async, encoder-touching step; the rest of
 * the retrieval (retrieveRecallGrounding) stays a pure function over the resolved
 * key.
 *
 * Order (each step a strict gate):
 *   1. regex FIRST — recallKeyForQuestion(text). If it returns a key, USE IT.
 *      This preserves C1's current behavior EXACTLY and keeps its hard-won
 *      unknowable exclusions as the first gate. The embedding pass never runs on
 *      a regex hit, so it can never DOWNGRADE a regex match.
 *   2. On regex MISS, the embedding pass:
 *      a. degrade-closed: no encoder → null (caller falls back to regex-only).
 *      b. intersect: candidate keys = CANONICAL_KEY_FORMS ∩ taughtKeys(knownFacts).
 *         An unknowable is not a taught key → no candidate → null → never grounds.
 *      c. embed the QUESTION `search_query:`; if it's the zero sentinel
 *         (Ollama down), degrade → null.
 *      d. cosine-match the query against each candidate's cached
 *         `search_document:` canonical form; take the argmax (bestKey/bestScore).
 *      e. C8.1 UNKNOWABLE GUARD: ALSO cosine-match the query against the known-
 *         unknowable exemplar forms (UNKNOWABLE_KEY_FORMS). REJECT (→ null) when
 *         the best unknowable cosine ≥ bestScore − RECALL_UNKNOWABLE_MARGIN. This
 *         is what separates the false positive [39] (closest to `name` among
 *         keys, but closer still to the phone unknowable) from the true positive
 *         [31] (closest to `location`, with no strong unknowable competitor) — a
 *         separation no flat threshold can make because [39] outscores [31].
 *      f. accept bestKey iff bestScore ≥ threshold AND the unknowable guard passed.
 *
 * Returns the resolved key or null. Null on a recall-shaped-but-unresolvable turn
 * is honest: the caller produces no node → NOT_GROUNDED by construction (C2).
 */
export async function resolveRecallKey(
  text: string,
  knownFacts: readonly string[] | undefined,
  encoder?: RecallKeyEncoder | null,
): Promise<string | null> {
  // 1. Regex FIRST — preserves C1 exactly; embedding never downgrades a hit.
  const regexKey = recallKeyForQuestion(text);
  if (regexKey) return regexKey;

  // 2. Embedding fallback. Degrade-closed when there is no usable encoder.
  if (!encoder) return null;
  if (!text.trim()) return null;

  // 2b. Intersect canonical keys with the keys THIS person actually taught.
  const taught = taughtKeys(knownFacts);
  const candidates = Object.keys(CANONICAL_KEY_FORMS).filter((k) => taught.has(k));
  if (candidates.length === 0) return null; // nothing taught to match → honest miss

  // 2c. Embed the question as a query; degrade on the Ollama-down sentinel.
  let queryEmb: number[];
  try {
    queryEmb = await encoder.encodeQuery(text);
  } catch {
    return null; // encoder threw → degrade to regex-only (already missed → null)
  }
  if (isZeroVector(queryEmb)) return null;

  // 2d. Cosine argmax over the taught-key canonical forms.
  let bestKey: string | null = null;
  let bestScore = -Infinity;
  for (const key of candidates) {
    const form = CANONICAL_KEY_FORMS[key];
    if (!form) continue;
    const docEmb = await formEmbedding(encoder, form);
    if (!docEmb) continue; // sentinel/missing form → skip (degrade for that key)
    const score = cosineSimilarity(queryEmb, docEmb);
    if (score > bestScore) {
      bestScore = score;
      bestKey = key;
    }
  }
  if (bestKey === null || bestScore < RECALL_SEMANTIC_THRESHOLD) return null;

  // 2e. C8.1 unknowable guard — reject if a known-unknowable exemplar matches at
  // least as well as the best taught key (within the margin). This breaks the
  // [31]/[39] bind by SUBJECT, not by score: an ask that is "as much" an
  // unknowable as a taught key must not ground (CANON Std-1/Std-4). The unknowable
  // forms are independent of what THIS person taught (an unknowable is unknowable
  // regardless), so the full set is always the competition.
  const bestUnknowable = await bestCosine(
    encoder,
    queryEmb,
    Object.values(UNKNOWABLE_KEY_FORMS),
  );
  if (bestUnknowable >= bestScore - RECALL_UNKNOWABLE_MARGIN) return null;

  return bestKey;
}

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
  key: string,
  knownFacts: readonly string[] | undefined,
): RecallRetrieval | null {
  if (!personId) return null;
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
  key: string,
  wkg: WkgContext,
): RecallRetrieval | null {
  // Single-hop: best topical entity from the already-assembled 1-hop context.
  // Base-context nodes (Drive/CoBeing/Word) are never provenance for a recall
  // answer; :Candidate-provenance nodes (C0) are EXCLUDED here too — a recall
  // must never ground off an unconfirmed conversation candidate (CANON Std-3).
  const topical = wkg.entities.find(
    (e) =>
      e.nodeType !== 'Drive' &&
      e.nodeType !== 'CoBeing' &&
      e.nodeType !== 'Word' &&
      e.provenance !== 'CANDIDATE',
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
 * WS3 C8: this pure core now operates over a RESOLVED key. By default the key is
 * derived from the regex (recallKeyForQuestion) so existing callers are
 * unchanged. The cycle boundary may instead pass a key resolved by the async
 * `resolveRecallKey` (regex-first → embedding) via `resolvedKey`, which lets a
 * paraphrase the regex missed still resolve — WITHOUT making this function async
 * or touching the encoder. A null/omitted resolvedKey falls back to the regex.
 *
 * @param personId     current speaker id (from frame.raw.person_model.personId).
 * @param inputText    the raw recall question text (used for the regex default).
 * @param knownFacts   the speaker's OKG facts as "key: value" strings (from frame).
 * @param wkg          the already-assembled single-hop WKG context for this frame.
 * @param resolvedKey  (C8) a key pre-resolved by resolveRecallKey; overrides the
 *                     regex when provided. Pass null/undefined to use the regex.
 */
export function retrieveRecallGrounding(
  personId: string | null,
  inputText: string,
  knownFacts: readonly string[] | undefined,
  wkg: WkgContext,
  resolvedKey?: string | null,
): RecallRetrieval | null {
  // C8: prefer the pre-resolved key (regex-first → embedding) when supplied;
  // otherwise derive it from the regex so legacy callers are byte-for-byte the
  // same. Either way, a null key → not a recall → no provenance (cheap exit).
  const key = resolvedKey ?? recallKeyForQuestion(inputText);
  if (!key) return null;
  // OKG self-fact wins over topical WKG (more specific provenance).
  return (
    retrieveOkgRecall(personId, key, knownFacts) ??
    retrieveWkgRecall(personId, key, wkg)
  );
}

/**
 * Apply a pre-resolved RecallRetrieval to a path's base grounding.
 *
 * This IS the single path at all four grounding sites (TK-84 collapse). The
 * per-site `applyOkgRecallGrounding` post-hoc reconstruction is deleted.
 * The honesty guard is preserved: the GROUNDED label is only applied when the
 * retrieved fact VALUE actually surfaced in the response text (C2 — unknowables /
 * paraphrased-away facts never falsely read GROUNDED). A null retrieval is a
 * passthrough (provenance=null, grounding unchanged) — safe for non-recall turns.
 *
 * CRUCIAL T1 DISTINCTION: the node id (`provenance`) is returned WHENEVER the
 * value surfaced — but it is the node id resolved AT RETRIEVAL TIME, identical
 * across all four paths, never reconstructed from the prose.
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
  // Honesty guard (C2 + C8.1 Std-1): the fact VALUE must actually surface in the
  // response, as a WHOLE WORD, for the label to read GROUNDED. The retrieval node
  // id is real either way, but a fact that was retrieved yet not used in the
  // answer must NOT claim GROUNDED — and a value that only appears as an
  // incidental substring ("Max" inside "Maxford") must NOT count as surfaced.
  const surfaced = valueSurfacesAsWord(retrieval.factValue, responseText);
  if (!surfaced) {
    return { grounding: currentGrounding, provenance: null, groundedBy: null };
  }
  return {
    grounding: 'GROUNDED',
    provenance: retrieval.factNodeId,
    groundedBy: retrieval.source,
  };
}
