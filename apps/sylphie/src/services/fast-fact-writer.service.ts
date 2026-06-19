/**
 * FastFactWriterService — Standalone service for fast (hot-path-bypass) KG writes.
 *
 * Extracted from CommunicationService (TK-34 / EP7-D) to remove four KG-write
 * dependencies (Neo4jService × 2 instances, WkgDiffService, IActionOutcomeReporter)
 * from the Communication hot path.
 *
 * Owns the three formerly-private methods:
 *   - writeFastFacts  — dispatches facts to the appropriate graph
 *   - writeFactToSelfKg  — Self KG (Neo4j SELF) CoBeing anchor write
 *   - writeFactToWkgCoBeing  — WKG (Neo4j WORLD) CoBeing anchor write + diff report
 *
 * CANON §Communication: CommunicationService is the voice, not the mind. These
 * writes belong in a subordinate writer, not on the hot-path service.
 *
 * CANON §KG Separation: each write targets exactly one instance (SELF or WORLD);
 * there is no cross-instance query inside this service.
 */

import { Injectable, Logger, Inject } from '@nestjs/common';
import {
  Neo4jService,
  Neo4jInstanceName,
} from '@sylphie/shared';
import {
  ACTION_OUTCOME_REPORTER,
  type IActionOutcomeReporter,
} from '@sylphie/drive-engine';
import { WkgDiffService } from './wkg-diff.service';
import type { ExtractedFact } from './person-model.service';
import { PersonModelService } from './person-model.service';

@Injectable()
export class FastFactWriterService {
  private readonly logger = new Logger(FastFactWriterService.name);

  constructor(
    private readonly neo4j: Neo4jService,
    private readonly wkgDiff: WkgDiffService,

    @Inject(ACTION_OUTCOME_REPORTER)
    private readonly outcomeReporter: IActionOutcomeReporter,

    // PersonModelService handles OKG writes for speaker-targeted facts.
    private readonly personModel: PersonModelService,
  ) {}

  // ---------------------------------------------------------------------------
  // Public API (formerly private to CommunicationService)
  // ---------------------------------------------------------------------------

  /**
   * Write extracted facts immediately to the appropriate knowledge graph.
   *
   * This is the fast path — facts are written within milliseconds of being
   * spoken, not after a 60-second learning cycle.
   *
   * Routing by fact.target:
   *   'speaker' → OKG ONLY (Person anchor → HAS_FACT → Attribute), tiered by
   *               the speaker's guardian status (WS4 Ticket 5 §1/§2.1).
   *   'sylphie' → Self KG (CoBeing anchor → HAS_FACT → Attribute) + WKG CoBeing.
   *
   * WS4 Ticket 5 §2.1 (CANON-blocking): the speaker→WKG dual-write was DELETED.
   * Self-reported personal facts are person facts, not world facts, regardless of
   * speaker. No world path replaces it (deferred to WS5-T1).
   *
   * @param userId     The speaker's PostgreSQL User.id.
   * @param facts      Extracted facts from text.
   * @param isGuardian The speaker's verified guardian status, threaded to
   *                   personModel.writeFact for the §1 confidence/provenance tier.
   */
  async writeFastFacts(
    userId: string,
    facts: ExtractedFact[],
    isGuardian = true,
  ): Promise<void> {
    const writes: Promise<void>[] = [];

    for (const fact of facts) {
      if (fact.target === 'speaker') {
        // Speaker facts → OKG ONLY (no WKG dual-write — §2.1).
        writes.push(
          this.personModel.writeFact(userId, fact, isGuardian).catch((err) => {
            this.logger.warn(`OKG fast-fact write failed: ${err}`);
          }),
        );
      } else if (fact.target === 'sylphie') {
        // Sylphie facts → Self KG + WKG (CoBeing anchor)
        writes.push(
          this.writeFactToSelfKg(fact).catch((err) => {
            this.logger.warn(`Self KG fast-fact write failed: ${err}`);
          }),
        );
        writes.push(
          this.writeFactToWkgCoBeing(fact).catch((err) => {
            this.logger.warn(`WKG CoBeing fast-fact write failed: ${err}`);
          }),
        );
      }
    }

    await Promise.all(writes);
  }

  // ---------------------------------------------------------------------------
  // Private graph writers
  // ---------------------------------------------------------------------------

  /**
   * Write a fact about Sylphie to the Self KG (Neo4j SELF).
   *
   * Example: "Your name is Sylphie" creates:
   *   (self:CoBeing)-[:HAS_FACT]->(a:Attribute {key: "name", value: "Sylphie"})
   */
  private async writeFactToSelfKg(fact: ExtractedFact): Promise<void> {
    const session = this.neo4j.getSession(Neo4jInstanceName.SELF, 'WRITE');
    try {
      const attrId = `self-attr-${fact.key}`;
      await session.run(
        `MERGE (self:CoBeing {label: 'Sylphie'})
         ON CREATE SET
           self.node_id = 'cobeing-self',
           self.created_at = datetime()
         MERGE (a:Attribute {attr_id: $attrId})
         ON CREATE SET
           a.key = $key,
           a.value = $value,
           a.confidence = 0.95,
           a.provenance_type = 'GUARDIAN',
           a.source = $source,
           a.raw_text = $rawText,
           a.learned_at = datetime()
         ON MATCH SET
           a.value = $value,
           a.confidence = 0.95,
           a.updated_at = datetime(),
           a.raw_text = $rawText
         MERGE (self)-[:HAS_FACT]->(a)`,
        {
          attrId,
          key: fact.key,
          value: fact.value,
          source: fact.source,
          rawText: fact.rawText,
        },
      );
      this.logger.log(`Self KG fast-fact: Sylphie.${fact.key} = "${fact.value}"`);
    } finally {
      await session.close();
    }
  }

  /**
   * Write a fact about Sylphie to the WKG's CoBeing anchor node.
   *
   * Captures a before/after WKG snapshot and reports information-gain to the
   * Drive Engine so curiosity relief is accurately attributed to this write
   * (Ticket 2 §A.14 — foreign-marker concurrency → UNVERIFIED protects honesty).
   */
  private async writeFactToWkgCoBeing(fact: ExtractedFact): Promise<void> {
    // The attribution key. The MERGE below stamps `last_action_id = $actionId`
    // on the value Entity it creates, so computeInformationGain attributes the
    // new node to THIS write and emits WKG_DIFF (real curiosity relief). A
    // concurrent writer's foreign marker still forces UNVERIFIED (honesty gate).
    const actionId = `wkg-fact-write:${fact.key}:${fact.value}`;
    const before = await this.wkgDiff.captureWkgSnapshot();

    const session = this.neo4j.getSession(Neo4jInstanceName.WORLD, 'WRITE');
    try {
      const relType = factKeyToRelType(fact.key);
      await session.run(
        `MATCH (self:CoBeing)
         MERGE (value:Entity {label: $value})
         ON CREATE SET
           value.node_id = $valueNodeId,
           value.node_type = 'Entity',
           value.schema_level = 'instance',
           value.provenance_type = 'GUARDIAN',
           value.confidence = 0.95,
           value.last_action_id = $actionId,
           value.created_at = datetime()
         MERGE (self)-[r:${relType}]->(value)
         ON CREATE SET
           r.confidence = 0.95,
           r.provenance_type = 'GUARDIAN',
           r.source = $source,
           r.raw_text = $rawText,
           r.created_at = datetime()
         ON MATCH SET
           r.confidence = 0.95,
           r.updated_at = datetime()`,
        {
          value: fact.value,
          valueNodeId: `self-${fact.key}-${fact.value.toLowerCase().replace(/\s+/g, '-').substring(0, 20)}`,
          actionId,
          source: fact.source,
          rawText: fact.rawText,
        },
      );
      this.logger.log(`WKG CoBeing fast-fact: (Sylphie) -[${relType}]-> "${fact.value}"`);
    } finally {
      await session.close();
    }

    // After the write lands, diff and report. computeInformationGain returns
    // UNVERIFIED (→ zero relief) when the change carries no action attribution,
    // when a snapshot failed, or when a concurrent writer touched the graph —
    // never a guessed number. Thread the result verbatim; Drive Engine
    // honesty-gates on source === 'WKG_DIFF'.
    try {
      const after = await this.wkgDiff.captureWkgSnapshot();
      const metrics = this.wkgDiff.computeInformationGain(before, after, actionId);
      this.outcomeReporter.reportOutcome({
        actionId,
        actionType: 'WkgFactWrite',
        // The write itself succeeded if we reached here; curiosity relief is
        // gated separately by informationGainMetrics.source.
        success: true,
        feedbackSource: 'GUARDIAN',
        theaterCheck: {
          expressionType: 'none',
          correspondingDrive: null,
          driveValue: null,
          isTheatrical: false,
        },
        informationGainMetrics: metrics,
      });
    } catch (err) {
      this.logger.warn(`WKG-diff information-gain report failed: ${err}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Pure helper (moved here alongside the WKG write that uses it)
// ---------------------------------------------------------------------------

/**
 * Map a fact key (from extractFactsFromText) to a WKG relationship type.
 */
function factKeyToRelType(key: string): string {
  const map: Record<string, string> = {
    name: 'HAS_NAME',
    identity: 'IDENTIFIES_AS',
    likes: 'LIKES',
    occupation: 'WORKS_AS',
    location: 'LIVES_IN',
    age: 'HAS_AGE',
  };
  return map[key] ?? `HAS_${key.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
}
