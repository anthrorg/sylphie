/**
 * PersonModelService — Other Evaluation (person modeling).
 *
 * Per sylphie2.png architecture: "Person Jim → Other Evaluation" feeds into
 * Communication so responses are calibrated to the person being spoken to.
 *
 * Storage: Grafeo (Other KG) via Neo4j OTHER instance. Anchor nodes are
 * keyed by User.id from PostgreSQL. Facts are stored as typed relationships
 * to Attribute value nodes.
 *
 * OKG Schema:
 *   (p:Person {node_id: <user.id>, username: "jim", is_guardian: true})
 *   (p)-[:HAS_FACT]->(a:Attribute {key: "name", value: "Jim", ...})
 *
 * CANON §Communication: Person modeling enables personalized, authentic
 * expression. Without it, Sylphie treats every conversation partner the same.
 *
 * CANON §KG Separation: Person models are stored in KG(Other) only.
 * No cross-instance queries between WORLD, SELF, and OTHER.
 */

import { Injectable, Logger, Optional, Inject, OnModuleInit } from '@nestjs/common';
import { Neo4jService, Neo4jInstanceName, type PersonModelSummary, verboseFor, deriveOkgFactTier } from '@sylphie/shared';

const vlog = verboseFor('Communication');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A fact about a person, stored in the OKG as an Attribute node. */
export interface PersonFact {
  readonly key: string;
  readonly value: string;
  readonly confidence: number;
  readonly source: 'self_reported' | 'observed' | 'inferred';
  readonly learnedAt: Date;
}

/** Structured fact extracted from text, ready for OKG/SelfKG + WKG write. */
export interface ExtractedFact {
  readonly key: string;
  readonly value: string;
  readonly source: 'self_reported' | 'observed' | 'inferred';
  readonly rawText: string;
  /**
   * Who this fact is about:
   * - 'speaker' → about the person talking (→ OKG + WKG)
   * - 'sylphie' → about Sylphie herself (→ Self KG + WKG CoBeing anchor)
   */
  readonly target: 'speaker' | 'sylphie';
}

// ---------------------------------------------------------------------------
// PersonModelService
// ---------------------------------------------------------------------------

@Injectable()
export class PersonModelService implements OnModuleInit {
  private readonly logger = new Logger(PersonModelService.name);

  /** In-memory cache of person facts. Synced from OKG on read, written through on write. */
  private readonly cache = new Map<string, PersonFact[]>();

  /**
   * Idle/self-tick fallback — the last person Sylphie spoke with.
   *
   * WS4 Ticket 4: this field is NO LONGER used during an active inbound turn.
   * Cycle-bound reads use getPersonModelForTurn(userId) with the explicit userId
   * from the in-flight InboundTurn's originator (set via currentTurnContext in
   * DecisionMakingService). This eliminates the active-person thrash (Part B.4)
   * where two concurrent turns would clobber the global slot.
   *
   * The field is retained for:
   *   1. Self-initiated tick cycles (no InboundTurn) — the context builder in
   *      CommunicationService.intakeTurn() still writes it so the person-model
   *      tickSampler slot reflects a plausible speaker for background Sylphie
   *      utterances.
   *   2. PerceptionGateway.processFaceFrame() — face snapshots associate with
   *      whoever was last "active" when no turn is in flight.
   *   3. clear() / reset paths.
   */
  private activePersonId: string | null = null;

  /** Interaction counts (in-memory, not critical to persist). */
  private readonly interactionCounts = new Map<string, number>();

  constructor(
    @Optional() @Inject(Neo4jService) private readonly neo4j: Neo4jService | null,
  ) {}

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  async onModuleInit(): Promise<void> {
    if (!this.neo4j) {
      this.logger.warn('Neo4jService unavailable — OKG writes disabled.');
      return;
    }

    // Create uniqueness constraint on Person.node_id
    const session = this.neo4j.getSession(Neo4jInstanceName.OTHER, 'WRITE');
    try {
      await session.run(
        `CREATE CONSTRAINT person_node_id_unique IF NOT EXISTS
         FOR (p:Person) REQUIRE p.node_id IS UNIQUE`,
      );
      await session.run(
        `CREATE CONSTRAINT attribute_id_unique IF NOT EXISTS
         FOR (a:Attribute) REQUIRE a.attr_id IS UNIQUE`,
      );
      // Backfill: set label = username for any Person nodes missing a label.
      const migrated = await session.run(
        `MATCH (p:Person) WHERE p.label IS NULL AND p.username IS NOT NULL
         SET p.label = p.username
         RETURN count(p) AS cnt`,
      );
      const cnt = migrated.records[0]?.get('cnt');
      const migratedCount = typeof cnt === 'number' ? cnt
        : (cnt && typeof cnt.toNumber === 'function') ? cnt.toNumber() : 0;
      if (migratedCount > 0) {
        this.logger.log(`OKG: backfilled label on ${migratedCount} Person node(s)`);
      }

      this.logger.log('OKG schema initialized (Person + Attribute constraints).');
    } catch (err) {
      this.logger.warn(`OKG schema init failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      await session.close();
    }
  }

  // ---------------------------------------------------------------------------
  // Anchor Node Management
  // ---------------------------------------------------------------------------

  /**
   * Ensure a Person anchor node exists in the OKG for the given user.
   * Uses the PostgreSQL User.id as the graph node_id.
   *
   * @param userId   - User.id UUID from PostgreSQL.
   * @param username - Display name.
   * @param isGuardian - Whether this user is a guardian.
   */
  async ensurePersonNode(
    userId: string,
    username: string,
    isGuardian: boolean,
  ): Promise<void> {
    if (!this.neo4j) return;

    const session = this.neo4j.getSession(Neo4jInstanceName.OTHER, 'WRITE');
    try {
      await session.run(
        `MERGE (p:Person {node_id: $userId})
         ON CREATE SET
           p.username = $username,
           p.label = $username,
           p.is_guardian = $isGuardian,
           p.created_at = datetime()
         ON MATCH SET
           p.username = $username,
           p.label = COALESCE(p.label, $username),
           p.is_guardian = $isGuardian,
           p.updated_at = datetime()`,
        { userId, username, isGuardian },
      );
      this.logger.log(`OKG Person anchor ensured: ${username} (${userId})`);
      vlog('person node created/updated', { userId, username, isGuardian });
    } catch (err) {
      this.logger.warn(`OKG Person anchor write failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      await session.close();
    }
  }

  // ---------------------------------------------------------------------------
  // Fact Writing (immediate — no 60s delay)
  // ---------------------------------------------------------------------------

  /**
   * Write a fact about a person to the OKG immediately.
   * Creates or updates an Attribute node and links it to the Person anchor.
   *
   * WS4 Ticket 5 (§1) — guardian-aware tiering. Confidence and provenance_type
   * derive from `(fact.source, isGuardian)`, NEVER from identity-string matching
   * (`userId === 'guardian'`). This is the CANON fix for Standards 3 and 5:
   *
   *   (a) Guardian self-fact (self_reported && isGuardian) → 0.90 / GUARDIAN.
   *       A guardian's self-knowledge is guardian-confirmed by definition; 0.90
   *       is the legitimate guardian exception to the 0.60 ceiling.
   *   (b) Non-guardian self-fact (self_reported && !isGuardian) → 0.60 / SELF_REPORTED.
   *       0.60 is exactly the Standard-3 ceiling: an unconfirmed self-report is the
   *       strongest non-guardian evidence; lower would suppress legitimate guest
   *       recall. SELF_REPORTED is a new provenance label (OKG-scoped): GUARDIAN
   *       would re-introduce the Standard-5 violation this ticket fixes, and
   *       INFERENCE would lie about provenance.
   *   (c) Observed / inferred (source !== self_reported) → 0.60 / OBSERVED|INFERENCE.
   *
   * Legacy tokenless-guardian compatibility: callers that omit isGuardian default
   * to true, preserving the pre-Ticket-7 behavior where only Jim can reach a
   * tokenless localhost session. When Ticket 7 flips tokenless→guest, the same code
   * path produces tier (b) with zero change here, because tiering is computed from
   * the turn's isGuardian flag, never re-derived from userId.
   *
   * @param userId     - The PostgreSQL User.id this fact is about.
   * @param fact       - The extracted fact to persist.
   * @param isGuardian - Whether the speaker holds verified-JWT guardian status.
   *                     Defaults to true (legacy tokenless-guardian behavior).
   */
  async writeFact(userId: string, fact: ExtractedFact, isGuardian = true): Promise<void> {
    // Tier (confidence, provenance_type) derived from (source, isGuardian),
    // NEVER from identity-string matching. Pure CANON rule lives in @sylphie/shared
    // (deriveOkgFactTier) and is unit-tested there (WS4-T5 §6 A2/A3).
    const { confidence, provenanceType } = deriveOkgFactTier(fact.source, isGuardian);

    const personFact: PersonFact = {
      key: fact.key,
      value: fact.value,
      confidence,
      source: fact.source,
      learnedAt: new Date(),
    };

    // Update in-memory cache
    const cached = this.cache.get(userId) ?? [];
    const existingIdx = cached.findIndex((f) => f.key === fact.key);
    if (existingIdx >= 0) {
      cached[existingIdx] = personFact;
    } else {
      cached.push(personFact);
    }
    this.cache.set(userId, cached);

    // Write to OKG
    if (!this.neo4j) return;

    const attrId = `attr-${userId}-${fact.key}`;
    const session = this.neo4j.getSession(Neo4jInstanceName.OTHER, 'WRITE');
    try {
      await session.run(
        `MATCH (p:Person {node_id: $userId})
         MERGE (a:Attribute {attr_id: $attrId})
         ON CREATE SET
           a.key = $key,
           a.value = $value,
           a.confidence = $confidence,
           a.provenance_type = $provenance,
           a.source = $source,
           a.learned_at = datetime(),
           a.raw_text = $rawText
         ON MATCH SET
           a.value = $value,
           a.confidence = CASE WHEN $confidence > a.confidence THEN $confidence ELSE a.confidence END,
           a.provenance_type = $provenance,
           a.source = $source,
           a.updated_at = datetime(),
           a.raw_text = $rawText
         MERGE (p)-[:HAS_FACT]->(a)`,
        {
          userId,
          attrId,
          key: fact.key,
          value: fact.value,
          confidence: personFact.confidence,
          provenance: provenanceType,
          source: fact.source,
          rawText: fact.rawText,
        },
      );
      this.logger.log(
        `OKG fact written: ${fact.key}="${fact.value}" for user ${userId} ` +
          `(confidence=${personFact.confidence}, provenance=${provenanceType}, guardian=${isGuardian})`,
      );
      vlog('fact written to OKG', { userId, key: fact.key, value: fact.value, source: fact.source, target: fact.target, provenanceType, isGuardian });
    } catch (err) {
      this.logger.warn(`OKG fact write failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      await session.close();
    }
  }

  // ---------------------------------------------------------------------------
  // Fact Reading
  // ---------------------------------------------------------------------------

  /**
   * Load all facts about a person from the OKG.
   * Results are cached in memory for fast subsequent reads.
   */
  async loadFacts(userId: string): Promise<PersonFact[]> {
    // Check cache first
    const cached = this.cache.get(userId);
    if (cached && cached.length > 0) return cached;

    if (!this.neo4j) return [];

    const session = this.neo4j.getSession(Neo4jInstanceName.OTHER, 'READ');
    try {
      const result = await session.run(
        `MATCH (p:Person {node_id: $userId})-[:HAS_FACT]->(a:Attribute)
         RETURN a.key AS key, a.value AS value, a.confidence AS confidence,
                a.source AS source, a.learned_at AS learnedAt
         ORDER BY a.confidence DESC`,
        { userId },
      );

      const facts: PersonFact[] = result.records.map((r) => ({
        key: r.get('key'),
        value: r.get('value'),
        confidence: r.get('confidence') ?? 0.5,
        source: r.get('source') ?? 'inferred',
        learnedAt: new Date(),
      }));

      this.cache.set(userId, facts);
      vlog('person facts loaded from OKG', { userId, factCount: facts.length });
      return facts;
    } catch (err) {
      this.logger.warn(`OKG fact load failed: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    } finally {
      await session.close();
    }
  }

  /**
   * Delete ALL stored facts for one person — OKG Attribute nodes and the
   * in-memory cache. The Person anchor node itself is preserved.
   *
   * DESTRUCTIVE, but scoped to a single person's HAS_FACT attributes. Exists
   * for the Provability Gate's hermeticity step (P0): person facts leak into
   * LLM prompts, so any fact accumulated between cassette record and replay
   * causes a cassette miss. The gate corpus re-teaches its facts every run,
   * so a pre-run wipe of the gate person makes prompt content deterministic.
   *
   * Also zeroes the in-memory interaction count: the count is embedded in
   * the "who am I?" prompt ("N interactions. ..."), so a monotonically
   * increasing counter makes that one prompt drift across runs — the exact
   * single-cassette-miss failure this reset exists to prevent.
   *
   * @param userId - The person whose facts are wiped (gate uses 'guardian').
   * @returns Number of Attribute nodes deleted (-1 if Neo4j unavailable).
   */
  async clearFactsForPerson(userId: string): Promise<number> {
    this.cache.delete(userId);
    this.interactionCounts.delete(userId);

    if (!this.neo4j) return -1;

    const session = this.neo4j.getSession(Neo4jInstanceName.OTHER, 'WRITE');
    try {
      const result = await session.run(
        `MATCH (p:Person {node_id: $userId})-[:HAS_FACT]->(a:Attribute)
         DETACH DELETE a
         RETURN count(a) AS cleared`,
        { userId },
      );
      const raw = result.records[0]?.get('cleared');
      const cleared = typeof raw === 'number' ? raw
        : (raw && typeof raw.toNumber === 'function') ? raw.toNumber() : 0;
      this.logger.warn(
        `OKG person facts cleared for '${userId}': ${cleared} attribute(s) deleted (gate hermeticity / authorized cleanup).`,
      );
      return cleared;
    } catch (err) {
      this.logger.warn(`OKG fact clear failed: ${err instanceof Error ? err.message : String(err)}`);
      return -1;
    } finally {
      await session.close();
    }
  }

  /**
   * Delete ALL stored facts for EVERY person — OKG Attribute nodes plus the
   * in-memory fact cache and interaction counts. Person anchor nodes themselves
   * are preserved.
   *
   * WS4 Ticket 5 (§4) — P0′ multi-person gate reset. clearFactsForPerson() wipes
   * one named person; once a second person can connect, the gate's hermeticity
   * step must wipe the WHOLE OKG corpus or replay non-determinism returns (any
   * fact accumulated by a non-guardian person between cassette record and replay
   * leaks into LLM prompts and causes a cassette miss). This is corpus-independent
   * — it enumerates no persons, so it cannot miss a person the gate forgot to list.
   *
   * NOT wired into the gate here — Ticket 7 calls it once in the hermeticity step.
   *
   * @returns Number of Attribute nodes deleted (-1 if Neo4j unavailable).
   */
  async clearFactsForAllPersons(): Promise<number> {
    this.cache.clear();
    this.interactionCounts.clear();

    if (!this.neo4j) return -1;

    const session = this.neo4j.getSession(Neo4jInstanceName.OTHER, 'WRITE');
    try {
      const result = await session.run(
        `MATCH (p:Person)-[:HAS_FACT]->(a:Attribute)
         DETACH DELETE a
         RETURN count(a) AS cleared`,
      );
      const raw = result.records[0]?.get('cleared');
      const cleared = typeof raw === 'number' ? raw
        : (raw && typeof raw.toNumber === 'function') ? raw.toNumber() : 0;
      this.logger.warn(
        `OKG facts cleared for ALL persons: ${cleared} attribute(s) deleted ` +
          `(gate hermeticity / authorized multi-person reset). Anchors preserved.`,
      );
      return cleared;
    } catch (err) {
      this.logger.warn(`OKG all-persons fact clear failed: ${err instanceof Error ? err.message : String(err)}`);
      return -1;
    } finally {
      await session.close();
    }
  }

  // ---------------------------------------------------------------------------
  // Public API (used by CommunicationService and deliberation)
  // ---------------------------------------------------------------------------

  /**
   * Get the person model summary for LLM context assembly.
   */
  getPersonModel(personId: string): PersonModelSummary | null {
    const facts = this.cache.get(personId) ?? [];
    const count = this.interactionCounts.get(personId) ?? 0;
    if (facts.length === 0 && count === 0) return null;

    return {
      personId,
      knownFacts: facts.map((f) => `${f.key}: ${f.value}`),
      interactionSummary:
        `${count} interactions. ` +
        (facts.length > 0
          ? `Known: ${facts.map((f) => `${f.key}=${f.value}`).join(', ')}.`
          : 'No facts learned yet.'),
    };
  }

  /** Return the keys of all known facts for a person. */
  listFactKeys(personId: string): string[] {
    return (this.cache.get(personId) ?? []).map((f) => f.key);
  }

  /** Return a specific fact with its deterministic provenance id, or null if not found. */
  getFactByKey(personId: string, key: string): { key: string; value: string; attrId: string } | null {
    const fact = (this.cache.get(personId) ?? []).find((f) => f.key === key);
    if (!fact) return null;
    return { key: fact.key, value: fact.value, attrId: `attr-${personId}-${fact.key}` };
  }

  /**
   * Get the model for the currently active person, if any.
   *
   * WS4 Ticket 4: use getPersonModelForTurn(userId) during an active inbound
   * turn. This method is kept only as an idle/self-tick fallback — when no
   * InboundTurn is in flight, there is no per-turn userId and the global
   * activePersonId is the best available context.
   */
  getActivePersonModel(): PersonModelSummary | null {
    if (!this.activePersonId) return null;
    return this.getPersonModel(this.activePersonId);
  }

  /**
   * WS4 Ticket 4 — Per-turn speaker context accessor.
   *
   * Returns the person model for an EXPLICIT userId, bypassing the global
   * mutable activePersonId slot. Call this from cycle-bound code where the
   * speaker is known (i.e., from an InboundTurn's userId field).
   *
   * This is the correct accessor for all code that runs inside a decision
   * cycle triggered by an inbound turn (e.g., intakeTurn, handleCycleResponse).
   *
   * @param userId - The exact userId of the turn's speaker.
   * @returns The person model summary, or null if no facts are known for this user.
   */
  getPersonModelForTurn(userId: string): PersonModelSummary | null {
    return this.getPersonModel(userId);
  }

  /**
   * Set the active person (idle/self-tick fallback).
   *
   * WS4 Ticket 4: do NOT call this from handleMessage or handleConnection in
   * ConversationGateway. Those two call sites were the source of the
   * active-person thrash (B.4). This method is retained only for:
   *   - parseInput() → sets the fallback so self-tick cycles see a plausible speaker
   *   - clear() reset paths
   */
  setActivePerson(personId: string): void {
    this.activePersonId = personId;
    vlog('active person set (idle fallback)', { personId });
  }

  /**
   * Get the active person ID (idle/self-tick fallback).
   */
  getActivePersonId(): string | null {
    return this.activePersonId;
  }

  /**
   * Record an interaction with a person (increments counter).
   * Fact extraction is handled separately by CommunicationService.
   */
  recordInteraction(personId: string): void {
    const count = this.interactionCounts.get(personId) ?? 0;
    this.interactionCounts.set(personId, count + 1);
    vlog('interaction recorded', { personId, newCount: count + 1 });
  }

  /**
   * Get all known person IDs.
   */
  getKnownPersonIds(): string[] {
    return [...this.cache.keys()];
  }

  /**
   * Clear all in-memory state (e.g., on system reset).
   * Wipes the fact cache and interaction counts so the LLM doesn't see
   * stale person attributes after a reset clears the OKG graph.
   */
  clear(): void {
    this.cache.clear();
    this.interactionCounts.clear();
    this.activePersonId = null;
    this.logger.debug('PersonModelService cleared: cache, interaction counts, active person.');
  }
}

// ---------------------------------------------------------------------------
// Fact extraction (pure function, used by CommunicationService)
// ---------------------------------------------------------------------------

/**
 * First-word stoplist for the "I am X" / "You are X" identity extractors.
 * Pleasantries and transient states are not identity: "I'm glad to meet you"
 * must not produce identity="glad to" at 90% confidence (a real junk fact
 * this list exists to prevent — it broke gate cassette hermeticity).
 */
const IDENTITY_STOPWORDS = new Set([
  // negation / intensifiers / fillers (original list)
  'not', 'very', 'so', 'just', 'also', 'really', 'doing', 'going', 'feeling',
  // pleasantries
  'glad', 'happy', 'sorry', 'pleased', 'thankful', 'grateful', 'welcome', 'called',
  // transient states — not identity
  'sure', 'afraid', 'fine', 'good', 'great', 'okay', 'ok', 'well', 'tired',
  'bored', 'curious', 'excited', 'interested', 'ready', 'here', 'back', 'done',
  'trying', 'looking', 'thinking', 'wondering', 'asking', 'still', 'always', 'now',
]);

/**
 * Rejects two-word identity captures that end in a dangling function word —
 * the regex grabs up to two words, so "glad to", "happy to", "here for"
 * would otherwise survive a stoplist miss on the first word.
 */
const DANGLING_TAIL_REGEX = /\b(?:to|of|in|at|for|on|with|that|it|the|and|or|but)$/;

/**
 * Extract structured facts from conversation text.
 *
 * Handles two directions:
 *
 * SPEAKER facts (target: 'speaker' → OKG + WKG):
 * - "My name is X" → name = X
 * - "I am X" / "I'm X" → identity = X
 * - "I like X" → likes = X
 * - "I work at/as X" → occupation = X
 * - "I live in X" → location = X
 * - "I'm N years old" → age = N
 *
 * SYLPHIE facts (target: 'sylphie' → Self KG + WKG CoBeing):
 * - "Your name is X" → name = X
 * - "You are X" / "You're X" → identity = X
 * - "You like X" → likes = X
 * - "You live in X" → location = X
 *
 * Returns structured facts ready for routing to the appropriate KG.
 */
export function extractFactsFromText(text: string): ExtractedFact[] {
  const facts: ExtractedFact[] = [];
  const lower = text.toLowerCase();

  // ── Speaker facts ("I/My" → OKG) ──────────────────────────────────

  // "My name is X"
  const nameMatch = lower.match(/my name is (\w+)/);
  if (nameMatch) {
    facts.push({
      key: 'name',
      value: nameMatch[1].charAt(0).toUpperCase() + nameMatch[1].slice(1),
      source: 'self_reported',
      target: 'speaker',
      rawText: text,
    });
  }

  // "My favorite X is Y" — e.g. "my favorite color is blue"
  const favRegex = /my favorite (\w+(?:\s+\w+)?) is (.+?)(?:[,.]|and\b|$)/gi;
  let favMatch: RegExpExecArray | null;
  while ((favMatch = favRegex.exec(lower)) !== null) {
    const category = favMatch[1].trim().replace(/\s+/g, '_');
    const favValue = favMatch[2].trim().substring(0, 50);
    if (favValue) {
      facts.push({
        key: `favorite_${category}`,
        value: favValue,
        source: 'self_reported',
        target: 'speaker',
        rawText: text,
      });
    }
  }

  // "My X is Y" — generic possessive fact e.g. "my job is teacher", "my hobby is painting"
  // Exclude "name" (handled above) and "favorite" (handled above).
  const myXisY = /\bmy ((?!name\b|favorite\b)\w+(?:\s+\w+)?) is (.+?)(?:[,.]|and\b|$)/gi;
  let myMatch: RegExpExecArray | null;
  while ((myMatch = myXisY.exec(lower)) !== null) {
    const myKey = myMatch[1].trim().replace(/\s+/g, '_');
    const myVal = myMatch[2].trim().substring(0, 50);
    // Skip very short or purely stopword values
    if (myVal.length >= 2 && myKey.length >= 2) {
      facts.push({
        key: myKey,
        value: myVal,
        source: 'self_reported',
        target: 'speaker',
        rawText: text,
      });
    }
  }

  // "I have a X named Y" / "I have a X called Y" — pets, kids, etc.
  const haveNamedRegex = /i have (?:a |an )?(\w+(?:\s+\w+)?) (?:named|called) (\w+)/gi;
  let haveMatch: RegExpExecArray | null;
  while ((haveMatch = haveNamedRegex.exec(lower)) !== null) {
    const thingType = haveMatch[1].trim();
    const thingName = haveMatch[2].trim();
    const capName = thingName.charAt(0).toUpperCase() + thingName.slice(1);
    facts.push({
      key: thingType.replace(/\s+/g, '_'),
      value: capName,
      source: 'self_reported',
      target: 'speaker',
      rawText: text,
    });
  }

  // "I'm from X" / "I am from X"
  const fromMatch = lower.match(/i(?:'m| am) from (.+?)(?:[,.]|$)/);
  if (fromMatch) {
    facts.push({
      key: 'origin',
      value: fromMatch[1].trim().substring(0, 50),
      source: 'self_reported',
      target: 'speaker',
      rawText: text,
    });
  }

  // "I am X" / "I'm X" (occupation, state, identity)
  const iAmMatch = lower.match(/i(?:'m| am) (?:a |an )?(\w+(?:\s+\w+)?)/);
  if (
    iAmMatch &&
    !IDENTITY_STOPWORDS.has(iAmMatch[1].split(/\s+/)[0]) &&
    !DANGLING_TAIL_REGEX.test(iAmMatch[1])
  ) {
    facts.push({
      key: 'identity',
      value: iAmMatch[1].trim(),
      source: 'self_reported',
      target: 'speaker',
      rawText: text,
    });
  }

  // "I like/love/enjoy X"
  const likeMatch = lower.match(/i (?:like|love|enjoy) (.+?)(?:\.|!|$)/);
  if (likeMatch) {
    facts.push({
      key: 'likes',
      value: likeMatch[1].trim().substring(0, 50),
      source: 'self_reported',
      target: 'speaker',
      rawText: text,
    });
  }

  // "I work at/as/for/in X"
  // Note: "at/as/for" were the original captures; "in" is added to handle
  // "I work in software/finance/tech/..." — a common natural-language form
  // that the corpus uses ("I work in software."). Without "in", the occupation
  // fact is never stored and OKG recall grounding for job questions always fails.
  const workMatch = lower.match(/i work (?:at|as|for|in) (.+?)(?:\.|!|$)/);
  if (workMatch) {
    facts.push({
      key: 'occupation',
      value: workMatch[1].trim().substring(0, 50),
      source: 'self_reported',
      target: 'speaker',
      rawText: text,
    });
  }

  // "I live in X"
  const liveMatch = lower.match(/i live in (.+?)(?:\.|!|$)/);
  if (liveMatch) {
    facts.push({
      key: 'location',
      value: liveMatch[1].trim().substring(0, 50),
      source: 'self_reported',
      target: 'speaker',
      rawText: text,
    });
  }

  // "I'm N years old" / "I am N years old"
  const ageMatch = lower.match(/i(?:'m| am) (\d+) years old/);
  if (ageMatch) {
    facts.push({
      key: 'age',
      value: ageMatch[1],
      source: 'self_reported',
      target: 'speaker',
      rawText: text,
    });
  }

  // ── Sylphie facts ("You/Your" → Self KG) ──────────────────────────

  // "Your name is X" / "you're called X" / "you are called X"
  const yourNameMatch = lower.match(/your name is (\w+)|you(?:'re| are) called (\w+)/);
  if (yourNameMatch) {
    const val = yourNameMatch[1] ?? yourNameMatch[2];
    facts.push({
      key: 'name',
      value: val.charAt(0).toUpperCase() + val.slice(1),
      source: 'self_reported',
      target: 'sylphie',
      rawText: text,
    });
  }

  // "You are X" / "You're X" (identity/description)
  const youAreMatch = lower.match(/you(?:'re| are) (?:a |an )?(\w+(?:\s+\w+){0,3})/);
  if (youAreMatch
    && !IDENTITY_STOPWORDS.has(youAreMatch[1].split(/\s+/)[0])
    && !DANGLING_TAIL_REGEX.test(youAreMatch[1])
    && !yourNameMatch // avoid double-matching "you are called X"
  ) {
    facts.push({
      key: 'identity',
      value: youAreMatch[1].trim(),
      source: 'self_reported',
      target: 'sylphie',
      rawText: text,
    });
  }

  // "You like X" / "You love X" / "You enjoy X"
  const youLikeMatch = lower.match(/you (?:like|love|enjoy) (.+?)(?:\.|!|$)/);
  if (youLikeMatch) {
    facts.push({
      key: 'likes',
      value: youLikeMatch[1].trim().substring(0, 50),
      source: 'self_reported',
      target: 'sylphie',
      rawText: text,
    });
  }

  // "You live in X"
  const youLiveMatch = lower.match(/you live in (.+?)(?:\.|!|$)/);
  if (youLiveMatch) {
    facts.push({
      key: 'location',
      value: youLiveMatch[1].trim().substring(0, 50),
      source: 'self_reported',
      target: 'sylphie',
      rawText: text,
    });
  }

  return facts;
}
