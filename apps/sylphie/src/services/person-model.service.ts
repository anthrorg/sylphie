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
import { Neo4jService, Neo4jInstanceName, type PersonModelSummary, verboseFor } from '@sylphie/shared';

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

  /** The current active person (who Sylphie is talking to right now). */
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
   * @param userId - The PostgreSQL User.id this fact is about.
   * @param fact   - The extracted fact to persist.
   */
  async writeFact(userId: string, fact: ExtractedFact): Promise<void> {
    const personFact: PersonFact = {
      key: fact.key,
      value: fact.value,
      confidence: fact.source === 'self_reported' ? 0.90 : 0.60,
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
           a.source = $source,
           a.learned_at = datetime(),
           a.raw_text = $rawText
         ON MATCH SET
           a.value = $value,
           a.confidence = CASE WHEN $confidence > a.confidence THEN $confidence ELSE a.confidence END,
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
          source: fact.source,
          rawText: fact.rawText,
        },
      );
      this.logger.log(`OKG fact written: ${fact.key}="${fact.value}" for user ${userId}`);
      vlog('fact written to OKG', { userId, key: fact.key, value: fact.value, source: fact.source, target: fact.target });
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

  /**
   * Get the model for the currently active person, if any.
   */
  getActivePersonModel(): PersonModelSummary | null {
    if (!this.activePersonId) return null;
    return this.getPersonModel(this.activePersonId);
  }

  /**
   * Set the active person (who Sylphie is currently talking to).
   */
  setActivePerson(personId: string): void {
    this.activePersonId = personId;
    vlog('active person set', { personId });
  }

  /**
   * Get the active person ID.
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
  if (iAmMatch && !['not', 'very', 'so', 'just', 'also', 'really', 'doing', 'going', 'feeling'].includes(iAmMatch[1].split(/\s+/)[0])) {
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

  // "I work at/as/for X"
  const workMatch = lower.match(/i work (?:at|as|for) (.+?)(?:\.|!|$)/);
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
    && !['not', 'very', 'so', 'just', 'also', 'really', 'doing', 'going', 'welcome', 'called'].includes(youAreMatch[1].split(/\s+/)[0])
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
