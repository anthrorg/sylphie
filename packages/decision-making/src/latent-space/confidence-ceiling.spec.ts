/**
 * CANON Immutable Standard 3 — write-time confidence ceiling regression spec.
 *
 * INVARIANT under test: no pattern may exceed 0.60 confidence while it has never
 * been successfully retrieved-and-used (useCount 0). This must hold across BOTH
 * write paths to confidence:
 *   1. write()            — a new pattern is written with useCount 0.
 *   2. updateConfidence() — a caller updates confidence post-outcome.
 *
 * There is NO guardian/provenance bypass at useCount 0: guardian-sourced
 * knowledge STARTS at 0.60; confirmation raises the base, never lifts the ceiling.
 * Only once useCount > 0 may the legitimate reinforced path raise confidence
 * above the ceiling.
 *
 * TimescaleService is passed undefined so the service runs hot-layer-only — the
 * in-memory clamp is exercised directly. (The DB-side CASE clamp and the schema
 * CHECK backstop cannot be exercised without a live DB; see the implementation
 * notes in latent-space.service.ts ensureSchema().)
 */

import { LatentSpaceService, type NewPattern } from './latent-space.service';
import { EMBEDDING_DIM } from '@sylphie/shared';

// Suppress verbose logs.
jest.mock('@sylphie/shared', () => {
  const actual = jest.requireActual('@sylphie/shared');
  return { ...actual, verboseFor: () => () => {} };
});

const CEILING = 0.6;

function unitEmbedding(axis: number): number[] {
  const v = new Array<number>(EMBEDDING_DIM).fill(0);
  v[axis % EMBEDDING_DIM] = 1;
  return v;
}

function newPattern(overrides: Partial<NewPattern> = {}): NewPattern {
  return {
    modality: 'text',
    stimulusEmbedding: unitEmbedding(0),
    responseText: 'cached reflex response',
    confidence: 0.95, // deliberately above the ceiling
    entityIds: [],
    ...overrides,
  };
}

/** Read a hot-layer entry by id (real internal state — no copies). */
function hotEntry(svc: LatentSpaceService, id: string): { confidence: number; useCount: number } {
  const hot = (svc as unknown as { hotLayer: Array<{ id: string; confidence: number; useCount: number }> }).hotLayer;
  const entry = hot.find((e) => e.id === id);
  if (!entry) throw new Error(`hot entry ${id} not found`);
  return entry;
}

describe('CANON Standard 3 — write-time confidence ceiling', () => {
  let svc: LatentSpaceService;

  beforeEach(() => {
    svc = new LatentSpaceService(undefined as never);
  });

  it('write() clamps a high-confidence new pattern to 0.60 at useCount 0', async () => {
    const id = await svc.write(newPattern({ confidence: 0.95 }));
    expect(id).not.toBe('');
    const entry = hotEntry(svc, id);
    expect(entry.useCount).toBe(0);
    expect(entry.confidence).toBeCloseTo(CEILING, 10);
  });

  it('write() preserves a below-ceiling confidence verbatim', async () => {
    const id = await svc.write(newPattern({ confidence: 0.3 }));
    expect(hotEntry(svc, id).confidence).toBeCloseTo(0.3, 10);
  });

  it('write() applies NO guardian/provenance bypass — guardian-grounded still caps at 0.60', async () => {
    // A GROUNDED, guardian-scoped pattern asking for 0.99 still starts at the ceiling.
    const id = await svc.write(
      newPattern({ confidence: 0.99, knowledgeGrounding: 'GROUNDED', groundingPersonId: 'guardian' }),
    );
    expect(hotEntry(svc, id).confidence).toBeCloseTo(CEILING, 10);
  });

  it('updateConfidence() hard-caps at 0.60 while useCount is 0 (the second hole)', async () => {
    const id = await svc.write(newPattern({ confidence: 0.3 }));
    // A caller tries to push a never-used pattern to 0.95 — must be rejected.
    svc.updateConfidence(id, 0.95);
    const entry = hotEntry(svc, id);
    expect(entry.useCount).toBe(0);
    expect(entry.confidence).toBeCloseTo(CEILING, 10);
  });

  it('updateConfidence() still allows lowering confidence at useCount 0', async () => {
    const id = await svc.write(newPattern({ confidence: 0.6 }));
    svc.updateConfidence(id, 0.15); // counter-indicated outcome
    expect(hotEntry(svc, id).confidence).toBeCloseTo(0.15, 10);
  });

  it('updateConfidence() permits exceeding 0.60 ONLY after a successful use (useCount > 0)', async () => {
    const id = await svc.write(newPattern({ confidence: 0.5 }));
    svc.recordUse(id); // pattern retrieved-and-used → useCount 1
    expect(hotEntry(svc, id).useCount).toBe(1);
    svc.updateConfidence(id, 0.8); // reinforced path may now exceed the ceiling
    expect(hotEntry(svc, id).confidence).toBeCloseTo(0.8, 10);
  });
});
