/**
 * Wave 3 / C3 — `:Candidate` minting unit tests (CANON Std-3 §2.8 isolation).
 *
 * These prove the load-bearing minting invariants WITHOUT a live Neo4j:
 *   (a) a conversation-derived proper noun is MERGE'd as `:Candidate` with
 *       provenance 'CANDIDATE', confidence ≤ 0.60, and grounding_person_id =
 *       the speaker from the event payload (C2's `payload.speakerId`);
 *   (b) NO `:Entity` node is minted for a conversation-derived (SENSOR) noun —
 *       the old leak path is gone;
 *   (c) a guardian-taught noun still mints a live `:Entity` (guardians are not a
 *       leak — only un-promoted conversation candidates are isolated);
 *   (d) a world-target triple (subjectHint 'world') is staged as an UNSCOPED
 *       `:Candidate` (no grounding_person_id), never `:Entity` — Std-1 honest
 *       staging instead of the old silent `continue`-drop.
 *
 * The Cypher is executed by Neo4j, so we assert against a Cypher+params-capturing
 * fake session exactly as confidence-decay.service.spec.ts does.
 */

import {
  Neo4jInstanceName,
  CANDIDATE_PROVENANCE_TYPE,
  CANDIDATE_NODE_LABEL,
  CANDIDATE_CONFIDENCE_CAP,
  CANDIDATE_PERSON_ID_PROP,
} from '@sylphie/shared';
import { UpsertEntitiesService } from './upsert-entities.service';
import { ExtractTypedEdgesService } from './extract-typed-edges.service';
import type { UnlearnedEvent, ExtractedEntity } from '../interfaces/learning.interfaces';

// ---------------------------------------------------------------------------
// Cypher + params capturing fake Neo4j
// ---------------------------------------------------------------------------

interface CapturedRun {
  instance: Neo4jInstanceName;
  cypher: string;
  params: Record<string, unknown>;
}

class CapturingNeo4j {
  readonly runs: CapturedRun[] = [];

  /**
   * MERGE queries return one record so the service treats the node as created.
   * The returned nodeId echoes whatever the params declared (so created-vs-matched
   * bookkeeping in the service is exercised).
   */
  getSession(name: Neo4jInstanceName, _mode: 'READ' | 'WRITE') {
    return {
      run: async (cypher: string, params: Record<string, unknown> = {}) => {
        this.runs.push({ instance: name, cypher, params });
        const nodeId = (params['nodeId'] as string) ?? 'mock-node';
        return { records: [{ get: (_k: string) => nodeId }] };
      },
      close: async () => {},
    };
  }
}

// ---------------------------------------------------------------------------
// Event builders
// ---------------------------------------------------------------------------

function inputEvent(content: string, speakerId?: string): UnlearnedEvent {
  return {
    id: 'evt-1',
    type: 'INPUT_RECEIVED',
    timestamp: new Date(),
    subsystem: 'communication',
    session_id: 'sess-1',
    payload: speakerId !== undefined ? { content, speakerId } : { content },
    schema_version: 1,
  };
}

function guardianEvent(content: string): UnlearnedEvent {
  return {
    id: 'evt-g',
    type: 'GUARDIAN_CONFIRMATION',
    timestamp: new Date(),
    subsystem: 'communication',
    session_id: 'sess-1',
    payload: { content },
    schema_version: 1,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** All runs whose Cypher MERGEs a `:Candidate {label}` node. */
function candidateMerges(neo: CapturingNeo4j): CapturedRun[] {
  return neo.runs.filter((r) =>
    new RegExp(`MERGE \\(n:${CANDIDATE_NODE_LABEL} \\{label:`).test(r.cypher),
  );
}

/** All runs whose Cypher MERGEs an `:Entity {label}` node. */
function entityMerges(neo: CapturingNeo4j): CapturedRun[] {
  return neo.runs.filter((r) => /MERGE \(n:Entity \{label:/.test(r.cypher));
}

// ---------------------------------------------------------------------------
// Tests — UpsertEntitiesService (conversation proper nouns)
// ---------------------------------------------------------------------------

describe('Wave 3 / C3 — UpsertEntitiesService :Candidate minting', () => {
  it('mints a conversation proper noun as :Candidate with CANDIDATE provenance, ≤0.60 conf, grounding_person_id = speaker', async () => {
    const neo = new CapturingNeo4j();
    const svc = new UpsertEntitiesService(neo as unknown as never);

    // "Maxford" is a capitalized multi-noun-style proper noun. It must appear
    // mid-sentence so the title-case extractor keeps it (sentence-initial
    // single capitals are dropped unless echoed mid-sentence).
    const results = await svc.upsertEntities(
      inputEvent('My dog is named Maxford the Brave.', 'user-A'),
    );

    const merges = candidateMerges(neo);
    expect(merges.length).toBeGreaterThan(0);

    // Every conversation noun went to the WORLD instance as a :Candidate.
    for (const m of merges) {
      expect(m.instance).toBe(Neo4jInstanceName.WORLD);
      expect(m.params['provenance']).toBe(CANDIDATE_PROVENANCE_TYPE);
      expect(m.params['confidence'] as number).toBeLessThanOrEqual(CANDIDATE_CONFIDENCE_CAP);
      expect(m.params['speakerId']).toBe('user-A');
      // The Cypher writes grounding_person_id from $speakerId.
      expect(m.cypher).toContain(`n.${CANDIDATE_PERSON_ID_PROP}`);
    }

    // Returned ExtractedEntity objects are flagged as candidates + scoped.
    expect(results.length).toBeGreaterThan(0);
    for (const e of results) {
      expect(e.isCandidate).toBe(true);
      expect(e.provenance).toBe(CANDIDATE_PROVENANCE_TYPE);
      expect(e.confidence).toBeLessThanOrEqual(CANDIDATE_CONFIDENCE_CAP);
      expect(e.groundingPersonId).toBe('user-A');
    }
  });

  it('mints NO live :Entity node for a conversation-derived proper noun (the §2.8 leak is gone)', async () => {
    const neo = new CapturingNeo4j();
    const svc = new UpsertEntitiesService(neo as unknown as never);

    await svc.upsertEntities(inputEvent('I visited Maxford City today.', 'user-A'));

    expect(entityMerges(neo)).toHaveLength(0);
    expect(candidateMerges(neo).length).toBeGreaterThan(0);
  });

  it('still mints a live :Entity for a guardian-taught proper noun (guardians are not a leak)', async () => {
    const neo = new CapturingNeo4j();
    const svc = new UpsertEntitiesService(neo as unknown as never);

    await svc.upsertEntities(guardianEvent('Remember Maxford City is important.'));

    const entities = entityMerges(neo);
    expect(entities.length).toBeGreaterThan(0);
    for (const m of entities) {
      expect(m.params['provenance']).toBe('GUARDIAN');
    }
    // Guardian nouns are NOT staged as candidates.
    expect(candidateMerges(neo)).toHaveLength(0);
  });

  it('still mints a :Candidate (unscoped) when no speakerId is present, never an :Entity', async () => {
    const neo = new CapturingNeo4j();
    const svc = new UpsertEntitiesService(neo as unknown as never);

    await svc.upsertEntities(inputEvent('I saw Maxford Tower.')); // no speakerId

    const merges = candidateMerges(neo);
    expect(merges.length).toBeGreaterThan(0);
    for (const m of merges) {
      expect(m.params['speakerId']).toBeNull(); // unscoped
    }
    expect(entityMerges(neo)).toHaveLength(0);
  });

  it('clamps the candidate confidence to ≤ CANDIDATE_CONFIDENCE_CAP in the MERGE params', async () => {
    const neo = new CapturingNeo4j();
    const svc = new UpsertEntitiesService(neo as unknown as never);

    await svc.upsertEntities(inputEvent('I love Maxford Park.', 'user-A'));

    for (const m of candidateMerges(neo)) {
      expect(m.params['confidence'] as number).toBeLessThanOrEqual(CANDIDATE_CONFIDENCE_CAP);
      expect(m.params['cap']).toBe(CANDIDATE_CONFIDENCE_CAP);
    }
  });
});

// ---------------------------------------------------------------------------
// Tests — ExtractTypedEdgesService (world-fact staging)
// ---------------------------------------------------------------------------

describe('Wave 3 / C3 — ExtractTypedEdgesService world-fact :Candidate staging', () => {
  it('stages a world-target triple as an UNSCOPED :Candidate subject+object, never :Entity', async () => {
    const neo = new CapturingNeo4j();
    const svc = new ExtractTypedEdgesService(neo as unknown as never);

    // No pre-extracted entities → forces upsertValueEntity to mint the world nodes.
    const event = inputEvent('The Eiffel Tower is in Paris.', 'user-A');
    const { edges } = await svc.extractTypedEdges([], event);

    // A world fact was staged (not dropped) — Std-1 honesty.
    expect(edges.length).toBeGreaterThan(0);
    const worldEdge = edges[0];
    expect(worldEdge.provenance).toBe(CANDIDATE_PROVENANCE_TYPE);
    expect(worldEdge.confidence).toBeLessThanOrEqual(CANDIDATE_CONFIDENCE_CAP);

    // Both endpoints minted as :Candidate, UNSCOPED (a world fact is not one
    // person's claim → grounding_person_id is null).
    const merges = candidateMerges(neo);
    expect(merges.length).toBeGreaterThanOrEqual(2);
    for (const m of merges) {
      expect(m.instance).toBe(Neo4jInstanceName.WORLD);
      expect(m.params['provenance']).toBe(CANDIDATE_PROVENANCE_TYPE);
      expect(m.params['confidence'] as number).toBeLessThanOrEqual(CANDIDATE_CONFIDENCE_CAP);
      expect(m.params['speakerId']).toBeNull(); // unscoped world candidate
    }

    // NO live :Entity minted for the world fact.
    expect(entityMerges(neo)).toHaveLength(0);
  });

  it('stages a speaker-fact value (e.g. a value proper noun) as a person-scoped :Candidate, not :Entity', async () => {
    const neo = new CapturingNeo4j();
    const svc = new ExtractTypedEdgesService(neo as unknown as never);

    // Speaker already extracted as a :Candidate (as upsertEntities would have done).
    const speaker: ExtractedEntity = {
      nodeId: 'candidate-speaker',
      label: 'Jim',
      provenance: CANDIDATE_PROVENANCE_TYPE,
      confidence: 0.3,
      isCandidate: true,
      groundingPersonId: 'user-A',
    };

    // "I like Coffeetown" → speaker triple, object "Coffeetown" not yet an entity,
    // so upsertValueEntity mints it. Speaker facts → value staged as :Candidate.
    const event = inputEvent('I like Coffeetown.', 'user-A');
    await svc.extractTypedEdges([speaker], event);

    const merges = candidateMerges(neo);
    expect(merges.length).toBeGreaterThan(0);
    // The value candidate is person-scoped to the speaker.
    expect(merges.some((m) => m.params['speakerId'] === 'user-A')).toBe(true);
    // No live :Entity minted for the conversation value.
    expect(entityMerges(neo)).toHaveLength(0);
  });
});
