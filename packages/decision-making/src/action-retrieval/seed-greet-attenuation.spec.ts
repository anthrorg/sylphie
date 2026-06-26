/**
 * TK-104 (AC2) — bootstrap seed-greet de-prioritization.
 *
 * AC2: with real procedures/content available, the runaway-reinforced bootstrap
 * seed-greet does NOT win every cycle by default — it is de-prioritized at rank
 * time once real content exists. Provable from the candidate ORDER returned by
 * ActionRetrieverService.retrieve(): a real procedure of comparable raw score
 * ranks ABOVE a higher-confidence bootstrap seed when both coexist, while at
 * true cold start (only seeds present) the seed still ranks normally.
 *
 * Strategy: drive retrieve() through a minimal fake Neo4j session (the same
 * getSession → run → records[].toObject() shape the service consumes), with the
 * embedding/grounding plumbing stubbed so contextMatchScore is deterministic.
 */

import { ActionRetrieverService } from './action-retriever.service';
import { DriveName, DRIVE_INDEX_ORDER, type DriveSnapshot } from '@sylphie/shared';

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

interface FakeRow {
  id: string;
  name: string;
  category: string;
  triggerContext: string;
  provenance: string;
  confidence: number;
  actionSequence: string | null;
  triggerPhrase: string | null;
  triggerEmbedding: number[] | null;
}

/** Build a fake Neo4j whose READ session returns the given procedure rows. */
function makeFakeNeo4j(rows: FakeRow[]): any {
  const session = {
    run: async () => ({
      records: rows.map((row) => ({ toObject: () => row })),
    }),
    close: async () => undefined,
  };
  return {
    getSession: () => session,
  };
}

/** A flat zero-pressure drive snapshot (the highest-pressure-drive tie path). */
function makeDriveSnapshot(): DriveSnapshot {
  const pressureVector = Object.fromEntries(
    DRIVE_INDEX_ORDER.map((d) => [d, 0]),
  ) as Record<DriveName, number>;
  return {
    sessionId: 'sess-test',
    tickNumber: 1,
    totalPressure: 0,
    pressureVector,
  } as DriveSnapshot;
}

/**
 * A unit query embedding. The fake rows below carry the SAME vector as their
 * trigger embedding, so cosine = 1.0 and contextMatchScore is uniform across
 * candidates — isolating the test to confidence + bootstrap attenuation.
 */
const UNIT_EMBEDDING = [1, 0, 0];

function row(
  id: string,
  provenance: string,
  confidence: number,
): FakeRow {
  return {
    id,
    name: id,
    category: 'ConversationalResponse',
    triggerContext: 'ctx',
    provenance,
    confidence,
    actionSequence: null,
    triggerPhrase: 'ctx',
    triggerEmbedding: [...UNIT_EMBEDDING],
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TK-104 AC2 — bootstrap seed-greet de-prioritization', () => {
  it('a real procedure outranks a higher-confidence bootstrap seed when both coexist', async () => {
    // Seed-greet reinforced to 0.81 (the AD-0041 runaway); a real learned
    // procedure at 0.60. Without attenuation the seed (composite ~0.705) beats
    // the real proc (composite ~0.60) and wins every cycle. With attenuation the
    // seed's RANK score halves (~0.353), so the real proc ranks first.
    const neo4j = makeFakeNeo4j([
      row('seed-greet', 'SYSTEM_BOOTSTRAP', 0.81),
      row('learned-proc', 'BEHAVIORAL_INFERENCE', 0.6),
    ]);
    const svc = new ActionRetrieverService(neo4j, null);

    const candidates = await svc.retrieve('fp', makeDriveSnapshot(), UNIT_EMBEDDING);

    expect(candidates.length).toBe(2);
    expect(candidates[0].procedureData.id).toBe('learned-proc');
    expect(candidates[1].procedureData.id).toBe('seed-greet');
  });

  it('at true cold start (only seeds present) the seed still ranks by composite', async () => {
    // No real content → attenuation MUST NOT apply, so seeds rank normally and
    // bootstrap behaviour is preserved (higher-confidence seed wins).
    const neo4j = makeFakeNeo4j([
      row('seed-greet', 'SYSTEM_BOOTSTRAP', 0.81),
      row('seed-shrug', 'SYSTEM_BOOTSTRAP', 0.6),
    ]);
    const svc = new ActionRetrieverService(neo4j, null);

    const candidates = await svc.retrieve('fp', makeDriveSnapshot(), UNIT_EMBEDDING);

    expect(candidates.length).toBe(2);
    expect(candidates[0].procedureData.id).toBe('seed-greet');
  });

  it('a real procedure that already outranks the seed is unaffected by attenuation', async () => {
    // Sanity: attenuation only ever HELPS real content; it never reorders two
    // real procedures, and a real proc that wins on raw score still wins.
    const neo4j = makeFakeNeo4j([
      row('learned-strong', 'BEHAVIORAL_INFERENCE', 0.9),
      row('seed-greet', 'SYSTEM_BOOTSTRAP', 0.81),
    ]);
    const svc = new ActionRetrieverService(neo4j, null);

    const candidates = await svc.retrieve('fp', makeDriveSnapshot(), UNIT_EMBEDDING);

    expect(candidates[0].procedureData.id).toBe('learned-strong');
  });
});
